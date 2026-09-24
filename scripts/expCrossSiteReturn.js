// DESIGN EXPERIMENT for the cross-site return rule. Runs on a throwaway database.
//
// Question: when a cylinder issued from Palanpur is returned at Chandisar, what does an
// auto-recorded transfer do to each site's Stock Summary? Specifically — does the transfer
// DOUBLE-COUNT the arrival that the customer RECEIVED line already records?
//
// Three worlds are built and measured:
//   A  same-site return           (the control — what "correct" looks like)
//   B  cross-site return, no transfer   (what the code does today)
//   C  cross-site return + auto transfer (the proposal)
//
// Nothing here touches the real database.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const CH = 'AT_PLANT_CHANDISAR';
const PA = 'AT_PALANPUR_OFFICE';
const D1 = '2026-06-10';   // given
const D2 = '2026-06-12';   // returned

async function build(world) {
  const db = `mongodb://127.0.0.1:27017/cp_exp_${world}_${Date.now()}`;
  await mongoose.connect(db);
  await mongoose.connection.dropDatabase();

  const User = require('../models/User');
  const Customer = require('../models/Customer');
  const Cylinder = require('../models/Cylinder');
  const Bill = require('../models/Bill');
  const GasType = require('../models/GasType');
  const CylinderSize = require('../models/CylinderSize');
  const LocationProfile = require('../models/LocationProfile');
  const N = require('../services/numbering.service');
  const acct = require('../services/accountNumbering.service');

  const u = await User.create({ name: 'Exp', email: `exp${world}@t.test`, password: 'Test1234!' });
  u.account_code = N.deriveAccountCode(u._id); await u.save(); acct._clearCache();

  await LocationProfile.create([
    { user_id: u._id, location: CH, label: 'Chandisar Plant', is_filling_location: true },
    { user_id: u._id, location: PA, label: 'Palanpur Office' }
  ]);
  const gas = await GasType.create({ user_id: u._id, gas_type_name: 'Oxygen', is_active: true });
  const size = await CylinderSize.create({ user_id: u._id, size_label: '7 m3', is_active: true });
  const cust = await Customer.create({ user_id: u._id, company_name: 'Exp Customer', customer_type: 'REGULAR', phone_primary: '9', is_active: true, holding_limit: 99 });

  // One cylinder, starting in stock at Palanpur.
  await Cylinder.create({ user_id: u._id, rotational_number: 'X-1', gas_type: 'Oxygen', capacity: '7 m3',
    location: PA, stock_state: 'IN_STOCK' });

  const li = (dir) => ({ direction: dir, gas_type_id: gas._id, cylinder_size_id: size._id,
    gas_type_name: 'Oxygen', size_label: '7 m3', serial_number: 'X-1', quantity: 1, rate: 0, amount: 0 });

  // 1. GIVEN from Palanpur.
  await Bill.create({ user_id: u._id, customer_id: cust._id, bill_number: 'B1', challan_no: 'C-1',
    bill_date: new Date(`${D1}T10:00:00+05:30`), location: PA,
    transaction_type: 'GIVEN', transaction_category: 'CUSTOMER', total_bill_amount: 0, line_items: [li('GIVEN')] });
  await Cylinder.updateOne({ user_id: u._id, rotational_number: 'X-1' }, { stock_state: 'AT_CUSTOMER', location: PA });

  // 2. RECEIVED — where depends on the world.
  const recvAt = world === 'A' ? PA : CH;
  await Bill.create({ user_id: u._id, customer_id: cust._id, bill_number: 'B2', challan_no: 'C-2',
    bill_date: new Date(`${D2}T10:00:00+05:30`), location: recvAt,
    transaction_type: 'RECEIVED', transaction_category: 'CUSTOMER', total_bill_amount: 0, line_items: [li('RECEIVED')] });
  await Cylinder.updateOne({ user_id: u._id, rotational_number: 'X-1' }, { stock_state: 'IN_STOCK', location: recvAt });

  // 3. World C also records the site-to-site move as an internal transfer.
  if (world === 'C') {
    await Bill.create({ user_id: u._id, bill_number: 'T1', challan_no: 'C-3',
      bill_date: new Date(`${D2}T10:00:01+05:30`), from_location: PA, to_location: CH,
      transaction_type: 'GIVEN', transaction_category: 'INTERNAL_TRANSFER', total_bill_amount: 0,
      line_items: [li('GIVEN')] });
  }

  return { u, db };
}

async function measure(uid, label) {
  const reportService = require('../services/report.service');
  const out = {};
  for (const loc of [CH, PA]) {
    const rep = await reportService.getStockSummary(uid, { date: D2, location: loc });
    const r = rep.rows.find(x => x.gas_type === 'Oxygen') || null;
    out[loc] = r ? { fOpen: r.filled.opening, fAdd: r.filled.add, fIss: r.filled.issue, fClose: r.filled.closing,
                     eOpen: r.empty.opening, eRecv: r.empty.receive, eIss: r.empty.issue, eClose: r.empty.closing }
                 : null;
  }
  return out;
}

const fmt = (m) => m ? `F ${String(m.fOpen).padStart(3)}/${String(m.fAdd).padStart(2)}/${String(m.fIss).padStart(2)}/${String(m.fClose).padStart(3)}   E ${String(m.eOpen).padStart(3)}/${String(m.eRecv).padStart(2)}/${String(m.eIss).padStart(2)}/${String(m.eClose).padStart(3)}` : '(no row)';

(async () => {
  console.log(`Stock Summary on ${D2}, columns are  open/in/out/close  for Filled and Empty\n`);
  const results = {};
  for (const world of ['A', 'B', 'C']) {
    const { u } = await build(world);
    results[world] = await measure(u._id);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    // clear model registry state between worlds
    for (const k of Object.keys(require.cache)) if (/services[\\/]accountNumbering/.test(k)) delete require.cache[k];
  }

  const NAMES = {
    A: 'A  same-site return (control — correct behaviour)',
    B: 'B  cross-site return, NO transfer (today)',
    C: 'C  cross-site return + auto transfer (proposal)'
  };
  for (const w of ['A', 'B', 'C']) {
    console.log(NAMES[w]);
    console.log(`   Chandisar : ${fmt(results[w][CH])}`);
    console.log(`   Palanpur  : ${fmt(results[w][PA])}\n`);
  }

  // The question that decides the design.
  const cEmptyIn_B = results.B[CH] ? results.B[CH].eRecv : 0;
  const cEmptyIn_C = results.C[CH] ? results.C[CH].eRecv : 0;
  console.log('─'.repeat(72));
  console.log(`Chandisar "Empty In" without transfer : ${cEmptyIn_B}`);
  console.log(`Chandisar "Empty In" with transfer    : ${cEmptyIn_C}`);
  console.log(cEmptyIn_C > cEmptyIn_B
    ? '=> The transfer DOUBLE-COUNTS the arrival. It must be excluded from Stock Summary math.'
    : '=> No double count; the transfer is safe for the Stock Summary as-is.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
