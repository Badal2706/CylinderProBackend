/**
 * seedDemo.js — wipe the demo account's data and reseed 50 realistic test records
 * covering every scenario in CylinderPro. Safe to re-run (it clears the demo
 * account's data first, matched by user_id; it never touches other users).
 *
 * Run:
 *   node seedDemo.js
 * Or with MONGODB_URI pointing at a different Mongo:
 *   MONGODB_URI=mongodb://localhost:27017/cylinder_management node seedDemo.js
 *
 * NOTE: canonical location is backend/seedDemo.js (the app's real models live in
 * backend/models). The brief referenced server/seedDemo.js, but server/ is the
 * stale duplicate tree that isn't part of the running app.
 */
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';
// SEED_EMAIL lets this target any existing (or new) account instead of the shared demo login.
// Password is only used if the account doesn't exist yet — an existing account's password is untouched.
const DEMO_EMAIL = process.env.SEED_EMAIL || 'demo@cylinderpro.com';
const DEMO_PASSWORD = process.env.SEED_PASSWORD || 'demo1234';

const User            = require('./models/User');
const Customer        = require('./models/Customer');
const Bill            = require('./models/Bill');
const Payment         = require('./models/Payment');
const Cylinder        = require('./models/Cylinder');
const GasType         = require('./models/GasType');
const CylinderSize    = require('./models/CylinderSize');
const BusinessProfile = require('./models/BusinessProfile');

// ── Valid gas type → capacity combinations (the only ones allowed) ──
const GAS_CAPACITIES = {
  'Oxygen':            ['1.5 m3', '6 m3', '7 m3', '10 m3'],
  'Nitrogen':          ['1.5 m3', '6 m3', '7 m3', '10 m3'],
  'Argon':             ['7 m3', '10 m3'],
  'CO2':               ['2 KG', '4.5 KG', '6 KG', '9 KG', '15 KG', '18 KG', '22 KG', '30 KG', '45 KG'],
  'Nitrous Oxide':     ['2 KG', '17 m3', '30 KG'],
  'Acetylene':         ['7 m3'],
  'Helium':            ['1.5 m3', '7 m3', '10 m3'],
  'HCL':               ['5 KG', '32 KG']
};
// Realistic per-cylinder rate by gas type (₹300–₹1200)
const RATE = {
  'Oxygen': 700, 'Nitrogen': 500, 'CO2': 400,
  'Argon': 1000, 'Acetylene': 1200, 'Nitrous Oxide': 700, 'HCL': 900, 'Helium': 1100
};
// How many of each gas to create (sums to 50)
const GAS_TARGETS = {
  'Oxygen': 15, 'Nitrogen': 7, 'CO2': 11,
  'Argon': 5, 'Acetylene': 3, 'Nitrous Oxide': 4, 'HCL': 2, 'Helium': 3
};

const NOW = new Date();
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
const pad3 = (n) => String(n).padStart(3, '0');

// Whether to also seed transactions + payments. Default OFF: seed only the
// cylinder inventory + customers + business profile so entries can be made by
// hand. Set SEED_TXNS=true to generate the full demo dataset.
const SEED_TXNS = process.env.SEED_TXNS === 'true';

(async () => {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to', MONGODB_URI);

  // ── Resolve demo user (preserve account; create only if missing) ──
  let demo = await User.findOne({ email: DEMO_EMAIL });
  let createdAccount = false;
  if (!demo) {
    demo = new User({ name: 'Demo User', email: DEMO_EMAIL, password: DEMO_PASSWORD });
    await demo.save();
    createdAccount = true;
    console.log('👤 Demo account did not exist — created it.');
  } else {
    console.log('👤 Demo account found — preserved (id ' + demo._id + ').');
  }
  const uid = demo._id;

  // ── STEP 1: clear demo data only ──
  const cleared = {
    customers: (await Customer.deleteMany({ user_id: uid })).deletedCount,
    bills:     (await Bill.deleteMany({ user_id: uid })).deletedCount,
    payments:  (await Payment.deleteMany({ user_id: uid })).deletedCount,
    cylinders: (await Cylinder.deleteMany({ user_id: uid })).deletedCount,
    business:  (await BusinessProfile.deleteMany({ user_id: uid })).deletedCount
  };
  // Optional legacy collections, if present
  const existing = (await mongoose.connection.db.listCollections().toArray()).map(c => c.name);
  for (const name of ['custodytransfers', 'custody_transfers', 'receipts']) {
    if (existing.includes(name)) {
      const r = await mongoose.connection.collection(name).deleteMany({ $or: [{ user_id: uid }, { owner: uid }] });
      cleared[name] = r.deletedCount;
    }
  }
  console.log('🧹 Cleared demo data:', JSON.stringify(cleared));

  // ── Ensure master gas types + sizes exist; map name/label → ObjectId ──
  const gasId = {}, sizeId = {};
  for (const gas of Object.keys(GAS_CAPACITIES)) {
    const g = await GasType.findOneAndUpdate({ gas_type_name: gas }, { gas_type_name: gas, is_active: true }, { upsert: true, new: true });
    gasId[gas] = g._id;
  }
  for (const cap of [...new Set(Object.values(GAS_CAPACITIES).flat())]) {
    const s = await CylinderSize.findOneAndUpdate({ size_label: cap }, { size_label: cap, is_active: true }, { upsert: true, new: true });
    sizeId[cap] = s._id;
  }

  // ── STEP 2: seed 50 cylinders ──
  const combos = [];
  for (const [gas, count] of Object.entries(GAS_TARGETS)) {
    const caps = GAS_CAPACITIES[gas];
    for (let i = 0; i < count; i++) combos.push({ gas_type: gas, capacity: caps[i % caps.length] });
  }
  const cylDocs = combos.map((c, i) => ({
    user_id: uid,
    rotational_number: `ROT-${pad3(i + 1)}`,
    physical_number: String(202601 + i),
    gas_type: c.gas_type,
    capacity: c.capacity,
    status: 'at-plant'
  }));
  await Cylinder.insertMany(cylDocs);
  const cylByRot = {};
  (await Cylinder.find({ user_id: uid })).forEach(c => { cylByRot[c.rotational_number] = c; });
  console.log(`🛢️  Created ${cylDocs.length} cylinders (ROT-001..ROT-${pad3(cylDocs.length)}).`);

  // ── STEP 3: seed 10 customers (7 regular, 3 one-time) ──
  const customerDefs = [
    { company_name: 'Gujarat Industrial Gases Pvt Ltd', contact_person: 'Mahesh Patel', phone_primary: '9824012345', phone_alternate: '07926570011', address: 'Plot 14, GIDC Estate, Vatva, Ahmedabad, Gujarat - 382445', gst_number: '24AABCG1234M1Z7', security_deposit: 50000, holding_limit: 10, customer_type: 'REGULAR', additional_contacts: [{ name: 'Accounts Dept', number: '9824099887' }, { name: '', number: '9924011223' }] },
    { company_name: 'Shree Engineering Works', contact_person: 'Rakesh Shah', phone_primary: '9898023456', phone_alternate: '02612345678', address: '23, Udhna Industrial Area, Surat, Gujarat - 394210', gst_number: '24AAACS5678P1Z3', security_deposit: 30000, holding_limit: 8, customer_type: 'REGULAR' },
    { company_name: 'Patel Fabrication & Allied', contact_person: 'Nilesh Patel', phone_primary: '9925034567', phone_alternate: '02652233445', address: '8, Makarpura GIDC, Vadodara, Gujarat - 390010', gst_number: '24AAECP2345Q1Z9', security_deposit: 25000, holding_limit: 6, customer_type: 'REGULAR', additional_contacts: [{ name: 'Store Manager', number: '9925044556' }] },
    { company_name: 'Rajkot Steel & Alloys', contact_person: 'Bhavin Mehta', phone_primary: '9879045678', phone_alternate: '02812345600', address: '45, Aji Industrial Estate, Rajkot, Gujarat - 360003', gst_number: '24AAFCR6789R1Z1', security_deposit: 20000, holding_limit: 5, customer_type: 'REGULAR' },
    { company_name: 'Narmada Welding Solutions', contact_person: 'Kiran Desai', phone_primary: '9426056789', phone_alternate: '02642250011', address: '12, GIDC Ankleshwar, Bharuch, Gujarat - 393002', gst_number: '24AAGCN3456S1Z5', security_deposit: 35000, holding_limit: 7, customer_type: 'REGULAR', additional_contacts: [{ name: 'Plant Supervisor', number: '9426066778' }, { name: 'Purchase', number: '9712033445' }] },
    { company_name: 'Sardar Gas Agency', contact_person: 'Jignesh Trivedi', phone_primary: '9377067890', phone_alternate: '07932211000', address: 'Sector 21, GH Road, Gandhinagar, Gujarat - 382021', gst_number: '24AAHCS7890T1Z8', security_deposit: 28000, holding_limit: 6, customer_type: 'REGULAR' },
    { company_name: 'Krishna Auto Works', contact_person: 'Hardik Joshi', phone_primary: '9558078901', phone_alternate: '02692266778', address: 'Station Road, Vidyanagar, Anand, Gujarat - 388120', gst_number: '24AAJCK4567U1Z2', security_deposit: 8000, holding_limit: 2, customer_type: 'REGULAR' },
    { company_name: 'Ravi Enterprises', contact_person: 'Ravi Chauhan', phone_primary: '9106089012', address: 'Highway Road, Mehsana, Gujarat - 384002', gst_number: '24AAKCR1239V1Z6', security_deposit: 0, holding_limit: 3, customer_type: 'ONE_TIME' },
    { company_name: 'Shiv Trading Co', contact_person: 'Sanjay Bhatt', phone_primary: '9714090123', address: 'Market Yard, Junagadh, Gujarat - 362001', gst_number: '24AALCS6541W1Z4', security_deposit: 0, holding_limit: 3, customer_type: 'ONE_TIME' },
    { company_name: 'Ambica Constructions', contact_person: 'Dipak Solanki', phone_primary: '9909001234', address: 'Ring Road, Nadiad, Gujarat - 387001', gst_number: '24AAMCA9871X1Z0', security_deposit: 0, holding_limit: 3, customer_type: 'ONE_TIME' }
  ];
  const C = [];
  for (const def of customerDefs) {
    const cust = new Customer({ ...def, user_id: uid, is_active: true });
    await cust.save();
    C.push(cust);
  }
  console.log(`👥 Created ${C.length} customers (7 regular, 3 one-time).`);

  // ── Sequential bill/receipt numbers continuing past any global max ──
  const maxSuffix = async (Model, field, prefix) => {
    const docs = await Model.find({ [field]: { $regex: `^${prefix}-` } }, { [field]: 1 });
    let max = 0;
    docs.forEach(d => { const n = parseInt(String(d[field]).split('-')[1], 10); if (n > max) max = n; });
    return max;
  };
  let billSeq = await maxSuffix(Bill, 'bill_number', 'BILL');
  let rcptSeq = await maxSuffix(Payment, 'receipt_number', 'RCP');
  const nextBill = () => `BILL-${String(++billSeq).padStart(4, '0')}`;
  const nextRcpt = () => `RCP-${String(++rcptSeq).padStart(4, '0')}`;

  // ── Helpers to build line items & bills ──
  const allBills = [];
  const L = (direction, rot) => {
    const c = cylByRot[rot];
    const rate = direction === 'GIVEN' ? RATE[c.gas_type] : 0;
    return {
      direction, gas_type_id: gasId[c.gas_type], cylinder_size_id: sizeId[c.capacity],
      serial_number: rot, quantity: 1, rate, amount: rate
    };
  };
  const saveBill = async ({ cust, day, type, challan, lines, remarks }) => {
    const given = lines.filter(l => l.direction === 'GIVEN');
    const recv = lines.filter(l => l.direction === 'RECEIVED');
    const bill = new Bill({
      user_id: uid, bill_number: nextBill(), customer_id: cust._id, bill_date: daysAgo(day),
      transaction_type: type, challan_no: challan || '',
      total_given_qty: given.length, total_received_qty: recv.length,
      total_bill_amount: given.reduce((s, l) => s + l.amount, 0),
      remarks: remarks || '', line_items: lines
    });
    await bill.save();
    allBills.push(bill);
    return bill;
  };

  // ── STEP 4 + 5: transactions + payments (only when SEED_TXNS=true) ──
  if (SEED_TXNS) {
  // (a) GIVEN bills
  const G1  = await saveBill({ cust: C[0], day: 35, type: 'GIVEN', challan: 'CH-1001', lines: [L('GIVEN','ROT-001')], remarks: 'Monthly supply' });
  const G2  = await saveBill({ cust: C[1], day: 31, type: 'GIVEN', challan: 'CH-1002', lines: [L('GIVEN','ROT-002'), L('GIVEN','ROT-008'), L('GIVEN','ROT-009')] });
  const G3  = await saveBill({ cust: C[2], day: 27, type: 'GIVEN', challan: 'CH-1003', lines: [L('GIVEN','ROT-003'), L('GIVEN','ROT-010')] });
  const G4  = await saveBill({ cust: C[0], day: 22, type: 'GIVEN', challan: 'CH-1004', lines: [L('GIVEN','ROT-004'), L('GIVEN','ROT-011'), L('GIVEN','ROT-012')] });
  const G5  = await saveBill({ cust: C[3], day: 16, type: 'GIVEN', challan: 'CH-1005', lines: [L('GIVEN','ROT-005'), L('GIVEN','ROT-013')] });
  const G6  = await saveBill({ cust: C[4], day: 40, type: 'GIVEN', challan: 'CH-1006', lines: [L('GIVEN','ROT-018')], remarks: 'Returned later via Sardar Gas Agency' });
  const G7  = await saveBill({ cust: C[5], day: 38, type: 'GIVEN', challan: 'CH-1007', lines: [L('GIVEN','ROT-019')] });
  const G8  = await saveBill({ cust: C[2], day: 20, type: 'GIVEN', challan: 'CH-1008', lines: [L('GIVEN','ROT-007')] });
  const G9  = await saveBill({ cust: C[6], day: 18, type: 'GIVEN', challan: 'CH-1009', lines: [L('GIVEN','ROT-020'), L('GIVEN','ROT-021'), L('GIVEN','ROT-022')], remarks: 'Bulk order' });
  const G10 = await saveBill({ cust: C[7], day: 25, type: 'GIVEN', challan: 'CH-1010', lines: [L('GIVEN','ROT-014'), L('GIVEN','ROT-015')] });
  const G11 = await saveBill({ cust: C[1], day: 10, type: 'GIVEN', challan: 'CH-1011', lines: [L('GIVEN','ROT-006')] });
  const G12 = await saveBill({ cust: C[8], day: 14, type: 'GIVEN', challan: 'CH-1012', lines: [L('GIVEN','ROT-025'), L('GIVEN','ROT-026')] });
  const G13 = await saveBill({ cust: C[9], day: 9,  type: 'GIVEN', challan: 'CH-1013', lines: [L('GIVEN','ROT-027')] });

  // (b) RECEIVED bills (normal returns)
  await saveBill({ cust: C[1], day: 5, type: 'RECEIVED', challan: 'CH-2001', lines: [L('RECEIVED','ROT-008'), L('RECEIVED','ROT-009')] });
  await saveBill({ cust: C[2], day: 4, type: 'RECEIVED', challan: 'CH-2002', lines: [L('RECEIVED','ROT-010')] });
  await saveBill({ cust: C[0], day: 3, type: 'RECEIVED', challan: 'CH-2003', lines: [L('RECEIVED','ROT-011'), L('RECEIVED','ROT-012')] });
  await saveBill({ cust: C[3], day: 8, type: 'RECEIVED', challan: 'CH-2004', lines: [L('RECEIVED','ROT-005'), L('RECEIVED','ROT-013')] });
  await saveBill({ cust: C[7], day: 2, type: 'RECEIVED', challan: 'CH-2005', lines: [L('RECEIVED','ROT-014'), L('RECEIVED','ROT-015')] });
  await saveBill({ cust: C[1], day: 6, type: 'RECEIVED', challan: 'CH-2006', lines: [L('RECEIVED','ROT-006')] });
  await saveBill({ cust: C[8], day: 4, type: 'RECEIVED', challan: 'CH-2007', lines: [L('RECEIVED','ROT-025'), L('RECEIVED','ROT-026')] });
  await saveBill({ cust: C[9], day: 3, type: 'RECEIVED', challan: 'CH-2008', lines: [L('RECEIVED','ROT-027')] });

  // (c) SWAP bills
  // round-trip: same cylinder returned empty then re-issued filled
  await saveBill({ cust: C[2], day: 6, type: 'SWAP', challan: 'CH-3001', lines: [L('RECEIVED','ROT-007'), L('GIVEN','ROT-007')], remarks: 'Round-trip refill' });
  await saveBill({ cust: C[6], day: 4, type: 'SWAP', challan: 'CH-3003', lines: [L('RECEIVED','ROT-022'), L('GIVEN','ROT-022')], remarks: 'Round-trip refill' });
  // normal swap: returned ROT-004 empty, issued ROT-016 filled
  await saveBill({ cust: C[0], day: 9, type: 'SWAP', challan: 'CH-3002', lines: [L('RECEIVED','ROT-004'), L('GIVEN','ROT-016')], remarks: 'Swap exchange' });

  // (d) CROSS-CUSTOMER RETURNS (returnedOnBehalfOf)
  // C5 returns ROT-018 (originally given to C4) on C4's behalf
  const cr1Line = L('RECEIVED', 'ROT-018');
  cr1Line.returned_on_behalf_of = C[4]._id;
  cr1Line.returned_on_behalf_of_name = C[4].company_name;
  await saveBill({ cust: C[5], day: 5, type: 'RECEIVED', challan: 'CH-4001', lines: [cr1Line], remarks: `Returned on behalf of ${C[4].company_name}` });
  G6.line_items[0].returned_via = C[5]._id;
  G6.line_items[0].returned_via_name = C[5].company_name;
  G6.line_items[0].returned_date = daysAgo(5);
  await G6.save();

  // C4 returns ROT-019 (originally given to C5) on C5's behalf
  const cr2Line = L('RECEIVED', 'ROT-019');
  cr2Line.returned_on_behalf_of = C[5]._id;
  cr2Line.returned_on_behalf_of_name = C[5].company_name;
  await saveBill({ cust: C[4], day: 6, type: 'RECEIVED', challan: 'CH-4002', lines: [cr2Line], remarks: `Returned on behalf of ${C[5].company_name}` });
  G7.line_items[0].returned_via = C[4]._id;
  G7.line_items[0].returned_via_name = C[4].company_name;
  G7.line_items[0].returned_date = daysAgo(6);
  await G7.save();

  const byType = allBills.reduce((m, b) => { m[b.transaction_type] = (m[b.transaction_type] || 0) + 1; return m; }, {});
  console.log(`🧾 Created ${allBills.length} transactions:`, JSON.stringify(byType));

  // ── Reconcile final cylinder statuses deterministically ──
  // For each cylinder, the latest-dated line wins; on a tie, GIVEN beats RECEIVED
  // (handles same-day round-trip swaps). A GIVEN line marked returned_via = at-plant.
  const latest = {}; // rot -> { time, rank, status }
  for (const b of allBills) {
    const t = new Date(b.bill_date).getTime();
    for (const li of b.line_items) {
      const rank = li.direction === 'GIVEN' ? 1 : 0;
      const status = (li.direction === 'GIVEN' && !li.returned_via) ? 'in-rotation' : 'at-plant';
      const cur = latest[li.serial_number];
      if (!cur || t > cur.time || (t === cur.time && rank >= cur.rank)) {
        latest[li.serial_number] = { time: t, rank, status };
      }
    }
  }
  for (const [rot, info] of Object.entries(latest)) {
    await Cylinder.updateOne({ user_id: uid, rotational_number: rot }, { status: info.status });
  }

  // ── STEP 5: payments ──
  // Per-customer billed total (sum of GIVEN amounts across their bills)
  const billedByCust = {};
  for (const b of allBills) {
    const amt = b.line_items.filter(l => l.direction === 'GIVEN').reduce((s, l) => s + l.amount, 0);
    billedByCust[b.customer_id.toString()] = (billedByCust[b.customer_id.toString()] || 0) + amt;
  }
  // Fraction of billed amount each customer has paid, and how many payment records to split into.
  const payPlan = [
    { cust: C[0], fraction: 1.0, parts: 3 },
    { cust: C[1], fraction: 0.5, parts: 2 },
    { cust: C[2], fraction: 0.7, parts: 3 },
    { cust: C[3], fraction: 0.0, parts: 0 },
    { cust: C[4], fraction: 1.0, parts: 3 },
    { cust: C[5], fraction: 0.3, parts: 2 },
    { cust: C[6], fraction: 0.0, parts: 0 },
    { cust: C[7], fraction: 0.5, parts: 2 },
    { cust: C[8], fraction: 0.0, parts: 0 },
    { cust: C[9], fraction: 1.0, parts: 1 }
  ];
  const firstBillOf = (custId) => allBills.find(b => b.customer_id.toString() === custId && b.transaction_type !== 'RECEIVED');
  const MODES = ['CASH', 'CHEQUE', 'UPI'];
  let modeIdx = 0, payDay = 32, payCount = 0;
  const rnd = (len) => Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join('');

  for (const plan of payPlan) {
    const cid = plan.cust._id.toString();
    const billed = billedByCust[cid] || 0;
    if (plan.fraction <= 0 || billed <= 0 || plan.parts <= 0) continue;
    const target = Math.round(billed * plan.fraction);
    const linkBill = firstBillOf(cid);
    const base = Math.floor(target / plan.parts);
    for (let p = 0; p < plan.parts; p++) {
      const isLast = p === plan.parts - 1;
      const amount = isLast ? target - base * (plan.parts - 1) : base;
      if (amount <= 0) continue;
      const mode = MODES[modeIdx++ % MODES.length];
      // small discount on some partial-payment records (keeps full payers at exactly ₹0 outstanding)
      const discount = (plan.fraction < 1 && p === 0) ? 100 : 0;
      const pay = new Payment({
        user_id: uid,
        receipt_number: nextRcpt(),
        customer_id: plan.cust._id,
        bill_id: linkBill ? linkBill._id : undefined,
        challan_no: linkBill ? linkBill.challan_no : `CH-9${pad3(payCount)}`,
        date: daysAgo(Math.max(1, payDay - payCount * 3)),
        amount_received: amount,
        discount,
        payment_mode: mode,
        cheque_number: mode === 'CHEQUE' ? `CHQ-${rnd(6)}` : undefined,
        upi_transaction_id: mode === 'UPI' ? `UPI-${rnd(14)}` : undefined,
        remarks: discount ? 'Part payment (discount applied)' : 'Part payment'
      });
      await pay.save();
      payCount++;
    }
  }
  console.log(`💰 Created ${payCount} payments (Cash / Cheque / UPI mix).`);
  } else {
    console.log('⏭️  Skipped transactions + payments (SEED_TXNS not set) — cylinders & customers only.');
  }

  // ── STEP 6: business profile ──
  await BusinessProfile.findOneAndUpdate(
    { user_id: uid },
    { $set: {
        business_name: 'GURU Industries',
        business_address: 'Industrial Area, Phase 2, Ahmedabad, Gujarat - 380015',
        business_phone: '07926578900',
        gst_number: '24AAAAA0000A1Z5',
        logo: ''
      }, $setOnInsert: { user_id: uid } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log('🏢 Business profile set to GURU Industries.');

  // ── VERIFY: summary ──
  const cyl = await Cylinder.find({ user_id: uid });
  const inRotation = cyl.filter(c => c.status === 'in-rotation');
  const atPlant = cyl.filter(c => c.status === 'at-plant');
  const custs = await Customer.find({ user_id: uid });
  const bills = await Bill.find({ user_id: uid });
  const pays = await Payment.find({ user_id: uid });

  // Outstanding per customer (mirrors backend getCustomerStats)
  let totalOutstanding = 0, custWithDues = 0, overLimit = 0;
  for (const cust of custs) {
    const cBills = bills.filter(b => b.customer_id.toString() === cust._id.toString());
    let given = 0, received = 0, billAmt = 0;
    cBills.forEach(b => b.line_items.forEach(li => {
      if (li.direction === 'GIVEN') { given += li.quantity; billAmt += li.amount; if (li.returned_via) received += li.quantity; }
      else if (!li.returned_on_behalf_of) { received += li.quantity; }
    }));
    const cPays = pays.filter(p => p.customer_id.toString() === cust._id.toString());
    const paid = cPays.reduce((s, p) => s + p.amount_received - p.discount, 0);
    const outstanding = billAmt - paid;
    const held = given - received;
    if (outstanding > 0) { custWithDues++; totalOutstanding += outstanding; }
    if (held > cust.holding_limit) overLimit++;
  }

  const agingBuckets = { '30+': 0, '20-30': 0, '10-20': 0, '<10': 0 };
  inRotation.forEach(c => {
    // latest non-returned GIVEN date for this cylinder
    let d = null;
    bills.forEach(b => b.line_items.forEach(li => {
      if (li.direction === 'GIVEN' && li.serial_number === c.rotational_number && !li.returned_via) {
        if (!d || new Date(b.bill_date) > d) d = new Date(b.bill_date);
      }
    }));
    if (d) {
      const days = Math.floor((NOW - d) / 86400000);
      if (days >= 30) agingBuckets['30+']++; else if (days >= 20) agingBuckets['20-30']++;
      else if (days >= 10) agingBuckets['10-20']++; else agingBuckets['<10']++;
    }
  });

  const byTypeFinal = bills.reduce((m, b) => { m[b.transaction_type] = (m[b.transaction_type] || 0) + 1; return m; }, {});

  console.log('\n══════════ SEED SUMMARY ══════════');
  console.log(`Cylinders created:          ${cyl.length}`);
  console.log(`  • in-rotation:            ${inRotation.length}  (aging spread ${JSON.stringify(agingBuckets)})`);
  console.log(`  • at-plant:               ${atPlant.length}`);
  console.log(`Customers created:          ${custs.length}  (regular ${custs.filter(c => c.customer_type === 'REGULAR').length} / one-time ${custs.filter(c => c.customer_type === 'ONE_TIME').length})`);
  console.log(`Transactions created:       ${bills.length}  ${JSON.stringify(byTypeFinal)}`);
  console.log(`Payments created:           ${pays.length}`);
  console.log(`Customers with outstanding: ${custWithDues}`);
  console.log(`Customers over limit:       ${overLimit}`);
  console.log(`Total outstanding amount:   ₹${totalOutstanding.toFixed(2)}`);
  console.log('══════════════════════════════════\n');

  await mongoose.disconnect();
  console.log(`✅ Done. Log in as ${DEMO_EMAIL}${createdAccount ? ` / ${DEMO_PASSWORD}` : ' (existing password)'} to view.`);
  process.exit(0);
})().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
