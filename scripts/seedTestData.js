// Seed a realistic, physically-consistent test dataset onto the LOCAL account so every screen,
// report and blocked case can be exercised by hand.
//
//   DRY=1 node scripts/seedTestData.js                 plan only, writes nothing
//   CONFIRM=SEED node scripts/seedTestData.js          actually seed
//   EMAIL=x@y.z CONFIRM=SEED node scripts/seedTestData.js
//
// SAFETY RAILS
//   1. LOCAL ONLY — refuses unless MONGODB_URI points at localhost/127.0.0.1. No override flag.
//   2. CONFIRM=SEED — running the file by accident reports and exits.
//   3. Refuses if the account already has bills or cylinders (FORCE=1 to add anyway).
//
// EVERY challan goes through bill.service.createBill / createInternalTransfer — the same code
// path the UI uses. Nothing is inserted behind the validator's back, so if a step in the story is
// physically impossible the script stops there and names it. That is the point: the dataset is
// PROOF the story is legal, not just plausible-looking rows.
//
// Sites are resolved by ROLE, never by name (R131): the filling site is whichever one carries
// is_filling_location, and the other two are simply "office A" and "office B".
const mongoose = require('mongoose');

// Which account to act on. EMAIL=... names one explicitly; with nothing set this falls back to the
// single account in the local database, and refuses if there is more than one rather than guessing.
// Deliberately NOT a hardcoded address: this file is published, and an address baked into source is
// both a privacy leak and wrong on every machine but one.
async function resolveUser(User) {
  const wanted = (process.env.EMAIL || '').trim().toLowerCase();
  if (wanted) {
    const u = await User.findOne({ email: wanted });
    if (!u) throw new Error('No account found for ' + wanted);
    return u;
  }
  const all = await User.find({}, { email: 1, name: 1 }).limit(2).lean();
  if (!all.length) throw new Error('No accounts in this database.');
  if (all.length > 1) throw new Error('More than one account here - name one with EMAIL=you@example.com');
  return User.findOne({ _id: all[0]._id });
}


const DRY = !!process.env.DRY;
const FORCE = !!process.env.FORCE;
const EMAIL = (process.env.EMAIL || '').trim().toLowerCase();  // blank = the single local account

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cylinder_management';
if (!/(localhost|127\.0\.0\.1)/.test(uri)) {
  console.error('REFUSED: MONGODB_URI does not point at a local database. This script only seeds local.');
  process.exit(1);
}
if (!DRY && process.env.CONFIRM !== 'SEED') {
  console.error('Nothing written. Re-run with CONFIRM=SEED (or DRY=1 to see the plan).');
  process.exit(1);
}

let PLANT, OFFICE_A, OFFICE_B, LABEL = {};

(async () => {
  await mongoose.connect(uri);

  const User = require('../models/User');
  const Customer = require('../models/Customer');
  const Cylinder = require('../models/Cylinder');
  const Bill = require('../models/Bill');
  const GasType = require('../models/GasType');
  const CylinderSize = require('../models/CylinderSize');
  const LocationProfile = require('../models/LocationProfile');
  const locationService = require('../services/location.service');
  const billService = require('../services/bill.service');
  const cylinderService = require('../services/cylinder.service');
  const fillingLog = require('../services/fillingLog.service');

  const user = await resolveUser(User);
  const uid = user._id;
  console.log('Account: ' + user.name + ' <' + user.email + '>  code=' + user.account_code);

  // ── Sites ──────────────────────────────────────────────────────────────────
  const { codes, labels, fillingLocationCode } = await locationService.getUserLocations(uid);
  LABEL = labels;
  if (!fillingLocationCode) {
    throw new Error('No filling location is configured — mark one site as the filling location first.');
  }
  PLANT = fillingLocationCode;
  const others = codes.filter(c => c !== PLANT);
  if (others.length < 2) throw new Error('Need at least 2 non-filling sites, found ' + others.length + '.');
  OFFICE_A = others[0];
  OFFICE_B = others[1];
  console.log('  filling site : ' + LABEL[PLANT] + ' (' + PLANT + ')');
  console.log('  office A     : ' + LABEL[OFFICE_A] + ' (' + OFFICE_A + ')');
  console.log('  office B     : ' + LABEL[OFFICE_B] + ' (' + OFFICE_B + ')');

  const existingBills = await Bill.countDocuments({ user_id: uid });
  const existingCyls = await Cylinder.countDocuments({ user_id: uid });
  if ((existingBills || existingCyls) && !FORCE) {
    console.error('\nREFUSED: this account already has ' + existingCyls + ' cylinder(s) and ' + existingBills + ' bill(s).');
    console.error('Seeding on top would produce a story that contradicts what is already there.');
    console.error('Blank the account first (scripts/blankLocalAccount.js), or re-run with FORCE=1.');
    process.exit(1);
  }

  // ── Catalog ids ────────────────────────────────────────────────────────────
  const gasIds = {}, sizeIds = {};
  for (const g of await GasType.find({ is_active: true })) gasIds[g.gas_type_name] = String(g._id);
  for (const s of await CylinderSize.find({ is_active: true })) sizeIds[s.size_label] = String(s._id);
  for (const pair of [['Oxygen', '7 m3'], ['Nitrogen', '7 m3'], ['CO2', '30 KG'], ['CO2', '45 KG']]) {
    if (!gasIds[pair[0]]) throw new Error('Gas type "' + pair[0] + '" is missing from the catalog.');
    if (!sizeIds[pair[1]]) throw new Error('Cylinder size "' + pair[1] + '" is missing from the catalog.');
  }

  // ── 1. Customers ───────────────────────────────────────────────────────────
  // 8 regular + 2 filling vendors. Holding limits are deliberately varied — Vijay Auto's limit of
  // 8 is small enough to walk into on purpose, which is why it is there.
  const CUSTOMERS = [
    { company_name: 'Shreeji Engineering Works', contact_person: 'Nilesh Shah', phone_primary: '9825011201',
      address: 'Plot 14, GIDC Phase 1, Deesa, Banaskantha 385535', gst_number: '24AABCS1429P1ZQ',
      holding_limit: 25, security_deposit: 50000 },
    { company_name: 'Ambica Steel Fabricators', contact_person: 'Rakesh Chaudhary', phone_primary: '9426033412',
      phone_alternate: '02742-222018', address: 'Survey 88, Palanpur-Deesa Highway, Palanpur 385001',
      gst_number: '24AAGCA7712M1Z4', holding_limit: 20, security_deposit: 40000,
      additional_contacts: [{ name: 'Store', number: '9426033413' }] },
    { company_name: 'Patel Welding Services', contact_person: 'Dinesh Patel', phone_primary: '9909122845',
      address: 'Nr. Bus Stand, Chhapi, Banaskantha 385210', holding_limit: 15, security_deposit: 25000 },
    { company_name: 'Banas Dairy Cold Storage', contact_person: 'Hitesh Desai', phone_primary: '9879544120',
      address: 'Banas Dairy Road, Palanpur 385001', gst_number: '24AAACB2340L1ZR',
      holding_limit: 30, security_deposit: 75000 },
    { company_name: 'Sardar Beverages Pvt Ltd', contact_person: 'Jignesh Thakkar', phone_primary: '9825077310',
      address: 'Block C, Chandisar Industrial Estate', gst_number: '24AAECS9981K1ZP',
      holding_limit: 20, security_deposit: 60000 },
    { company_name: 'Vijay Auto Garage', contact_person: 'Vijay Rabari', phone_primary: '9714200556',
      address: 'Station Road, Palanpur 385001', holding_limit: 8, security_deposit: 10000 },
    { company_name: 'Gujarat Laser Cutting Co', contact_person: 'Ashish Mehta', phone_primary: '9998112204',
      address: 'Shed 22, Naroda GIDC, Ahmedabad 382330', gst_number: '24AABCG5567H1ZM',
      holding_limit: 18, security_deposit: 45000,
      additional_contacts: [{ name: 'Accounts', number: '9998112205' }, { number: '079-22814400' }] },
    { company_name: 'Deesa Hospital Supplies', contact_person: 'Dr. Kirit Joshi', phone_primary: '9426511903',
      address: 'Civil Hospital Road, Deesa 385535', holding_limit: 12, security_deposit: 30000 },
    // ── the two filling vendors (R55: GIVEN = empties out, RECEIVED = filled back) ──
    { company_name: 'Nova Gas Refillers', contact_person: 'Sanjay Prajapati', phone_primary: '9824600771',
      address: 'Refilling Station, Mehsana Road, Unjha 384170', gst_number: '24AACFN3320B1ZS',
      is_filling_vendor: true, holding_limit: null, security_deposit: 0 },
    { company_name: 'Balaji Industrial Gases', contact_person: 'Mahesh Suthar', phone_primary: '9909877432',
      address: 'Plot 7, Kadi GIDC, Mehsana 382715', gst_number: '24AAHFB8812C1ZT',
      is_filling_vendor: true, holding_limit: null, security_deposit: 0 }
  ];

  // ── 2. Cylinders ───────────────────────────────────────────────────────────
  // All start IN_STOCK at the FILLING site. A cylinder with no history is treated as FILLED by
  // the Stock Summary anchor, so "all filled at first" holds with no extra record needed.
  const BATCHES = [
    { from: 1,   to: 50,  gas: 'Oxygen',   cap: '7 m3'  },
    { from: 51,  to: 100, gas: 'Nitrogen', cap: '7 m3'  },
    { from: 101, to: 115, gas: 'CO2',      cap: '30 KG' },
    { from: 116, to: 130, gas: 'CO2',      cap: '45 KG' }
  ];
  const rot = (n) => String(n);
  const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(rot(i)); return r; };

  if (DRY) {
    console.log('\n--- DRY RUN, nothing written ---');
    console.log(CUSTOMERS.length + ' customers (' + CUSTOMERS.filter(c => c.is_filling_vendor).length + ' filling vendors):');
    CUSTOMERS.forEach(c => console.log('   ' + (c.is_filling_vendor ? '[vendor] ' : '         ') + c.company_name));
    BATCHES.forEach(b => console.log('   cylinders ' + b.from + '-' + b.to + '  ' + b.gas + ' ' + b.cap + '  -> ' + LABEL[PLANT]));
    console.log('   ~37 challans dated 1-29 Aug 2026, plus 3 filling-log days');
    await mongoose.disconnect();
    return;
  }

  const custId = {};
  for (const c of CUSTOMERS) {
    const doc = await Customer.create({ user_id: uid, customer_type: 'REGULAR', is_active: true, ...c });
    custId[c.company_name] = String(doc._id);
  }
  console.log('\n[ok] ' + CUSTOMERS.length + ' customers created (2 filling vendors)');

  let made = 0;
  for (const b of BATCHES) {
    for (let n = b.from; n <= b.to; n++) {
      await cylinderService.createCylinder(uid, {
        rotational_number: rot(n), gas_type: b.gas, capacity: b.cap,
        location: PLANT, stock_state: 'IN_STOCK'
      });
      made++;
    }
    console.log('[ok] cylinders ' + b.from + '-' + b.to + '  ' + b.gas + ' ' + b.cap + '  -> ' + LABEL[PLANT]);
  }
  console.log('[ok] ' + made + ' cylinders in stock at the filling site, all filled');

  // ── 3. The story ───────────────────────────────────────────────────────────
  const line = (gas, cap, serials, rate) => ({
    gas_type_id: gasIds[gas], cylinder_size_id: sizeIds[cap],
    quantity: serials.length, rate: rate, serial_numbers: serials
  });
  const pcLine = (gas, cap, opts) => Object.assign({
    gas_type_id: gasIds[gas], cylinder_size_id: sizeIds[cap],
    quantity: 0, rate: 0, serial_numbers: []
  }, opts);

  const log = [];
  async function challan(label, body, expect) {
    const res = await billService.createBill(uid, body);
    if (res && (res.requires_cross_site_confirmation || res.requires_pre_software_confirmation)) {
      if (expect !== 'confirm') throw new Error(label + ': unexpectedly needed confirmation — ' + res.message);
      const again = await billService.createBill(uid,
        Object.assign({}, body, { confirm_cross_site: true, confirm_pre_software: true }));
      log.push([label, body.challan_no || '(transfer)', again.bill_number || '', 'CONFIRMED cross-site']);
      return again;
    }
    if (expect === 'confirm') throw new Error(label + ': expected a confirmation prompt and did not get one.');
    log.push([label, body.challan_no || '(transfer)', res.bill_number || '', '']);
    return res;
  }
  const transfer = (label, challan_no, from, to, serials, at, remarks) => challan(label, {
    transaction_category: 'INTERNAL_TRANSFER', challan_no: challan_no, from_location: from,
    to_location: to, serial_numbers: serials, bill_date: at, remarks: remarks
  });
  const give = (label, challan_no, cust, loc, items, at, remarks) => challan(label, {
    customer_id: custId[cust], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: challan_no, location: loc, given_items: items, bill_date: at, remarks: remarks
  });
  const take = (label, challan_no, cust, loc, items, at, remarks, expect) => challan(label, {
    customer_id: custId[cust], customer_type: 'REGULAR', transaction_type: 'RECEIVED',
    challan_no: challan_no, location: loc, received_items: items, bill_date: at, remarks: remarks
  }, expect);
  const swap = (label, challan_no, cust, loc, given, received, at, remarks) => challan(label, {
    customer_id: custId[cust], customer_type: 'REGULAR', transaction_type: 'SWAP',
    challan_no: challan_no, location: loc, given_items: given, received_items: received,
    bill_date: at, remarks: remarks
  });

  const PFX = {};
  for (const p of await LocationProfile.find({ user_id: uid })) PFX[p.location] = p.challan_prefix || '';
  const cn = (loc, n) => (PFX[loc] || '') + n;

  const O = 'Oxygen', N2 = 'Nitrogen', C = 'CO2', M3 = '7 m3', K30 = '30 KG', K45 = '45 KG';

  // ─ Aug 1 — opening stock is pushed out to the two offices ─
  await transfer('Aug 1  transfer', cn(PLANT, '2001'), PLANT, OFFICE_B, range(1, 10), '2026-08-01T09:15', 'Opening stock for the office');
  await transfer('Aug 1  transfer', cn(PLANT, '2002'), PLANT, OFFICE_A, range(51, 58), '2026-08-01T11:40', 'Opening stock for the office');

  // ─ Aug 2 — first sales, one at the plant and one at an office ─
  await give('Aug 2  given', cn(PLANT, '1001'), 'Shreeji Engineering Works', PLANT, [line(O, M3, range(11, 18), 250)], '2026-08-02T10:20');
  await give('Aug 2  given', cn(OFFICE_B, '1001'), 'Deesa Hospital Supplies', OFFICE_B, [line(O, M3, range(1, 5), 260)], '2026-08-02T15:05');

  // ─ Aug 3 ─
  await give('Aug 3  given', cn(OFFICE_A, '1001'), 'Gujarat Laser Cutting Co', OFFICE_A, [line(N2, M3, range(51, 56), 300)], '2026-08-03T09:50');
  await give('Aug 3  given', cn(PLANT, '1002'), 'Banas Dairy Cold Storage', PLANT, [line(C, K30, range(101, 106), 900)], '2026-08-03T14:30');

  // ─ Aug 5 ─
  await take('Aug 5  received', cn(PLANT, '1003'), 'Shreeji Engineering Works', PLANT, [line(O, M3, range(11, 14), 0)], '2026-08-05T11:00', 'Empties returned');
  await give('Aug 5  given', cn(PLANT, '1004'), 'Sardar Beverages Pvt Ltd', PLANT, [line(C, K45, range(116, 121), 1200)], '2026-08-05T16:20');

  // ─ Aug 6 — a SWAP: filled out and empties back on one challan ─
  await swap('Aug 6  swap', cn(PLANT, '1005'), 'Shreeji Engineering Works', PLANT,
    [line(O, M3, range(19, 22), 250)], [line(O, M3, range(15, 16), 0)], '2026-08-06T10:10', 'Delivery + pickup on one trip');

  // ─ Aug 7 ─
  await take('Aug 7  received', cn(OFFICE_B, '1002'), 'Deesa Hospital Supplies', OFFICE_B, [line(O, M3, range(1, 3), 0)], '2026-08-07T12:40');

  // ─ Aug 8 — empties travel back to the plant ─
  await transfer('Aug 8  transfer', cn(OFFICE_B, '2003'), OFFICE_B, PLANT, range(1, 3), '2026-08-08T08:30', 'Empties back for filling');

  // ─ Aug 9 — FILLING DAY (filling log, not a challan) ─
  await fillingLog.saveDay(uid, { date: '2026-08-09', entries: range(1, 3).map(r => ({ rotational_number: r })) });
  console.log('[ok] filling log 2026-08-09 — 3 cylinders filled');

  // ─ Aug 10 ─
  await give('Aug 10 given', cn(PLANT, '1006'), 'Ambica Steel Fabricators', PLANT, [line(N2, M3, range(59, 66), 290)], '2026-08-10T09:30');
  await give('Aug 10 given', cn(OFFICE_A, '1002'), 'Vijay Auto Garage', OFFICE_A, [line(N2, M3, range(57, 58), 300)], '2026-08-10T16:00');

  // ─ Aug 11 — FILLING VENDOR: we GIVE empties out (R55 inversion) ─
  await give('Aug 11 vendor out', cn(PLANT, '1007'), 'Nova Gas Refillers', PLANT, [line(O, M3, range(11, 14), 0)], '2026-08-11T08:15', 'Sent for filling');

  // ─ Aug 13 — the same vendor RETURNS them filled ─
  await take('Aug 13 vendor in', cn(PLANT, '1008'), 'Nova Gas Refillers', PLANT, [line(O, M3, range(11, 14), 0)], '2026-08-13T17:10', 'Received back filled');

  // ─ Aug 14 ─
  await take('Aug 14 received', cn(OFFICE_A, '1003'), 'Gujarat Laser Cutting Co', OFFICE_A, [line(N2, M3, range(51, 53), 0)], '2026-08-14T11:20');
  await give('Aug 14 given', cn(OFFICE_B, '1003'), 'Deesa Hospital Supplies', OFFICE_B, [line(O, M3, range(6, 8), 260)], '2026-08-14T15:45');

  // ─ Aug 15 — office → office transfer: NEITHER end is the plant (R136) ─
  await transfer('Aug 15 transfer', cn(OFFICE_A, '2004'), OFFICE_A, OFFICE_B, range(51, 53), '2026-08-15T10:00', 'Consolidating empties');

  // ─ Aug 16 ─
  await transfer('Aug 16 transfer', cn(OFFICE_B, '2005'), OFFICE_B, PLANT, range(51, 53), '2026-08-16T08:45', 'Empties back for filling');

  // ─ Aug 17 — FILLING DAY ─
  await fillingLog.saveDay(uid, { date: '2026-08-17', entries: range(51, 53).map(r => ({ rotational_number: r })) });
  console.log('[ok] filling log 2026-08-17 — 3 cylinders filled');
  await give('Aug 17 given', cn(PLANT, '1009'), 'Patel Welding Services', PLANT, [line(O, M3, range(31, 38), 255)], '2026-08-17T14:10');

  // ─ Aug 18 — CROSS-SITE RETURN: issued at the plant, handed back at an office ─
  await take('Aug 18 cross-site', cn(OFFICE_B, '1004'), 'Shreeji Engineering Works', OFFICE_B,
    [line(O, M3, range(19, 20), 0)], '2026-08-18T13:25', 'Customer dropped them at the nearer branch', 'confirm');

  // ─ Aug 19 ─
  await give('Aug 19 given', cn(PLANT, '1010'), 'Banas Dairy Cold Storage', PLANT, [line(C, K30, range(107, 112), 900)], '2026-08-19T10:30');
  await take('Aug 19 received', cn(PLANT, '1011'), 'Sardar Beverages Pvt Ltd', PLANT, [line(C, K45, range(116, 118), 0)], '2026-08-19T16:40');

  // ─ Aug 20 ─
  await transfer('Aug 20 transfer', cn(PLANT, '2006'), PLANT, OFFICE_A, range(122, 127), '2026-08-20T09:00', 'Filled CO2 for the office');
  await give('Aug 20 given', cn(OFFICE_A, '1004'), 'Sardar Beverages Pvt Ltd', OFFICE_A, [line(C, K45, range(122, 124), 1200)], '2026-08-20T15:15');

  // ─ Aug 21 — personal cylinders arrive (the customer's OWN, quantity only) ─
  await take('Aug 21 received', cn(PLANT, '1012'), 'Ambica Steel Fabricators', PLANT, [line(N2, M3, range(59, 62), 0)], '2026-08-21T11:05');
  await challan('Aug 21 PC in', {
    customer_id: custId['Gujarat Laser Cutting Co'], customer_type: 'REGULAR', transaction_type: 'RECEIVED',
    challan_no: cn(PLANT, '1013'), location: PLANT,
    received_items: [pcLine(N2, M3, { personalCylindersIn: 4 })],
    bill_date: '2026-08-21T16:30', remarks: "Customer's own 4 empty cylinders taken in for refilling"
  });

  // ─ Aug 22 — the same personal cylinders go back refilled, charged at the line rate ─
  await challan('Aug 22 PC out', {
    customer_id: custId['Gujarat Laser Cutting Co'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: cn(PLANT, '1014'), location: PLANT,
    given_items: [pcLine(N2, M3, { personalCylindersOut: 4, rate: 300 })],
    bill_date: '2026-08-22T10:20', remarks: "Customer's own 4 cylinders returned refilled"
  });

  // ─ Aug 23 — the SECOND filling vendor ─
  await give('Aug 23 vendor out', cn(PLANT, '1015'), 'Balaji Industrial Gases', PLANT, [line(C, K45, range(116, 118), 0)], '2026-08-23T08:40', 'Sent for filling');

  // ─ Aug 24 ─
  await take('Aug 24 vendor in', cn(PLANT, '1016'), 'Balaji Industrial Gases', PLANT, [line(C, K45, range(116, 118), 0)], '2026-08-24T17:30', 'Received back filled');

  // ─ Aug 25 ─
  await take('Aug 25 received', cn(OFFICE_B, '1005'), 'Deesa Hospital Supplies', OFFICE_B, [line(O, M3, range(4, 5), 0)], '2026-08-25T12:00');
  await give('Aug 25 given', cn(OFFICE_B, '1006'), 'Vijay Auto Garage', OFFICE_B, [line(O, M3, range(9, 10), 260)], '2026-08-25T16:50');

  // ─ Aug 26 — the cross-site returns and the office empties all head back ─
  await transfer('Aug 26 transfer', cn(OFFICE_B, '2007'), OFFICE_B, PLANT, range(4, 5).concat(range(19, 20)), '2026-08-26T08:20', 'Empties back for filling');

  // ─ Aug 27 — FILLING DAY ─
  await fillingLog.saveDay(uid, {
    date: '2026-08-27',
    entries: range(4, 5).concat(range(19, 20)).concat(range(59, 62)).map(r => ({ rotational_number: r }))
  });
  console.log('[ok] filling log 2026-08-27 — 8 cylinders filled');
  await give('Aug 27 given', cn(PLANT, '1017'), 'Shreeji Engineering Works', PLANT, [line(O, M3, range(39, 42), 250)], '2026-08-27T14:40');

  // ─ Aug 28 ─
  await swap('Aug 28 swap', cn(PLANT, '1018'), 'Patel Welding Services', PLANT,
    [line(O, M3, range(43, 46), 255)], [line(O, M3, range(31, 34), 0)], '2026-08-28T10:15', 'Delivery + pickup on one trip');
  await transfer('Aug 28 transfer', cn(PLANT, '2008'), PLANT, OFFICE_A, range(71, 76), '2026-08-28T13:00');
  await give('Aug 28 given', cn(OFFICE_A, '1005'), 'Gujarat Laser Cutting Co', OFFICE_A, [line(N2, M3, range(71, 74), 300)], '2026-08-28T16:20');

  // ─ Aug 29 ─
  await take('Aug 29 received', cn(OFFICE_A, '1006'), 'Vijay Auto Garage', OFFICE_A, [line(N2, M3, range(57, 58), 0)], '2026-08-29T11:30');
  await challan('Aug 29 one-time', {
    customer_type: 'ONE_TIME',
    one_time_customer: {
      company_name: 'Kalpesh Fabrication (walk-in)', contact_person: 'Kalpesh Rathod',
      phone_primary: '9737100482', address: 'Chandisar'
    },
    transaction_type: 'GIVEN', challan_no: cn(PLANT, '1019'), location: PLANT,
    given_items: [line(O, M3, range(47, 48), 300)], bill_date: '2026-08-29T15:00',
    remarks: 'Cash sale, walk-in customer'
  });

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log('\n' + '-'.repeat(88));
  console.log('CHALLANS CREATED');
  console.log('-'.repeat(88));
  for (const row of log) {
    console.log('  ' + row[0].padEnd(20) + String(row[1]).padEnd(10) + 'bill ' + String(row[2]).padEnd(8) + row[3]);
  }
  console.log('-'.repeat(88));
  console.log('  ' + log.length + ' challans, 3 filling-log days');

  const byLoc = await Cylinder.aggregate([
    { $match: { user_id: uid } },
    { $group: { _id: { l: '$location', s: '$stock_state' }, n: { $sum: 1 } } },
    { $sort: { '_id.l': 1 } }
  ]);
  console.log('\nWHERE THE ' + made + ' CYLINDERS ENDED UP');
  for (const r of byLoc) {
    const where = r._id.s === 'AT_CUSTOMER'
      ? 'out with customers (last dispatched from ' + (LABEL[r._id.l] || r._id.l) + ')'
      : 'in stock at ' + (LABEL[r._id.l] || r._id.l);
    console.log('  ' + String(r.n).padStart(4) + '  ' + where);
  }

  const held = await Bill.aggregate([
    { $match: { user_id: uid, transaction_category: 'CUSTOMER' } },
    { $unwind: '$line_items' },
    { $match: { 'line_items.serial_number': { $nin: ['', null] } } },
    { $group: {
        _id: '$customer_id',
        given: { $sum: { $cond: [{ $eq: ['$line_items.direction', 'GIVEN'] }, 1, 0] } },
        recv: { $sum: { $cond: [{ $eq: ['$line_items.direction', 'RECEIVED'] }, 1, 0] } }
    } }
  ]);
  const names = {};
  for (const c of await Customer.find({ user_id: uid })) {
    names[String(c._id)] = { n: c.company_name, l: c.holding_limit, v: c.is_filling_vendor };
  }
  console.log('\nCUSTOMER HOLDINGS (inventory cylinders out with them right now)');
  held.sort((a, b) => (b.given - b.recv) - (a.given - a.recv));
  for (const h of held) {
    const m = names[String(h._id)] || { n: '?' };
    console.log('  ' + String(h.given - h.recv).padStart(3) + ' held / ' +
      (m.v ? 'vendor, no limit ' : ('limit ' + String(m.l)).padEnd(17)) + '  ' + m.n);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
})().catch(e => {
  console.error('\nFAILED: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
