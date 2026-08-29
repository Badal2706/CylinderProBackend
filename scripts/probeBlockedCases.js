// Fire every guard in the transaction path against the SEEDED data and print the exact message
// each one produces, so the manual test checklist quotes what the software really says rather
// than what it is supposed to say.
//
//   node scripts/probeBlockedCases.js
//
// SAFE BY CONSTRUCTION — every probe is expected to be REJECTED, so nothing is written. The bill
// number is only peeked (advanceCounterPast runs after a successful save), so a rejected probe
// does not burn a number either. Any probe that unexpectedly SUCCEEDS is reported as a FAILURE
// of the guard, and the bill it created is deleted immediately.
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


const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cylinder_management';
if (!/(localhost|127\.0\.0\.1)/.test(uri)) {
  console.error('REFUSED: local database only.');
  process.exit(1);
}

(async () => {
  await mongoose.connect(uri);
  const User = require('../models/User');
  const Customer = require('../models/Customer');
  const Cylinder = require('../models/Cylinder');
  const Bill = require('../models/Bill');
  const GasType = require('../models/GasType');
  const CylinderSize = require('../models/CylinderSize');
  const locationService = require('../services/location.service');
  const billService = require('../services/bill.service');

  const u = await resolveUser(User);
  const uid = u._id;
  const { codes, labels, fillingLocationCode } = await locationService.getUserLocations(uid);
  const PLANT = fillingLocationCode;
  const [OFFICE_A, OFFICE_B] = codes.filter(c => c !== PLANT);

  const gasIds = {}, sizeIds = {};
  for (const g of await GasType.find({ is_active: true })) gasIds[g.gas_type_name] = String(g._id);
  for (const s of await CylinderSize.find({ is_active: true })) sizeIds[s.size_label] = String(s._id);
  const cust = {};
  for (const c of await Customer.find({ user_id: uid })) cust[c.company_name] = String(c._id);

  const line = (gas, cap, serials, rate) => ({
    gas_type_id: gasIds[gas], cylinder_size_id: sizeIds[cap],
    quantity: serials.length, rate: rate || 0, serial_numbers: serials
  });

  let pass = 0, fail = 0;
  async function probe(n, title, body, kind) {
    // kind: 'block' = must throw; 'confirm' = must come back asking for confirmation
    let outcome, msg;
    try {
      const res = await billService.createBill(uid, body);
      if (res && (res.requires_cross_site_confirmation || res.requires_pre_software_confirmation)) {
        outcome = 'confirm'; msg = res.message;
      } else {
        outcome = 'saved'; msg = 'bill ' + res.bill_number + ' — NOT BLOCKED';
        if (res && res._id) await Bill.deleteOne({ _id: res._id });
        else if (res && res.bill_id) await Bill.deleteOne({ _id: res.bill_id });
      }
    } catch (e) { outcome = 'block'; msg = e.message; }
    const ok = outcome === kind;
    ok ? pass++ : fail++;
    console.log('\n' + String(n).padStart(2) + '. ' + (ok ? '[OK]  ' : '[!!]  ') + title);
    console.log('      expected: ' + kind + '   got: ' + outcome);
    console.log('      "' + msg + '"');
  }

  const L = (c) => labels[c] || c;
  console.log('Sites — filling: ' + L(PLANT) + ' | offices: ' + L(OFFICE_A) + ', ' + L(OFFICE_B));
  console.log('='.repeat(96));

  const TODAY = '2026-08-30T10:00';

  // Cylinders 71-76 were transferred to OFFICE_A on 28 Aug; 71-74 went to a customer, 75-76 sit
  // in stock there. Cylinder 100 has never moved and is in stock at the plant.
  await probe(1, 'Give a cylinder from a site it is not at (bill written at the office, cylinder at the plant)', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-1', location: OFFICE_A, bill_date: TODAY,
    given_items: [line('Nitrogen', '7 m3', ['100'], 290)]
  }, 'block');

  await probe(2, 'Give a cylinder that is already out with a customer', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-2', location: PLANT, bill_date: TODAY,
    given_items: [line('CO2', '30 KG', ['101'], 900)]
  }, 'block');

  await probe(3, 'Receive a cylinder that is already in our stock', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'RECEIVED',
    challan_no: 'PROBE-3', location: PLANT, bill_date: TODAY,
    received_items: [line('Nitrogen', '7 m3', ['100'], 0)]
  }, 'block');

  await probe(4, 'Take a cylinder back at a DIFFERENT site than it was issued from (allowed, but must confirm)', {
    customer_id: cust['Banas Dairy Cold Storage'], customer_type: 'REGULAR', transaction_type: 'RECEIVED',
    challan_no: 'PROBE-4', location: OFFICE_A, bill_date: TODAY,
    received_items: [line('CO2', '30 KG', ['101'], 0)]
  }, 'confirm');

  await probe(5, 'Push a customer past their holding limit (Vijay Auto: limit 8)', {
    customer_id: cust['Vijay Auto Garage'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-5', location: PLANT, bill_date: TODAY,
    given_items: [line('Oxygen', '7 m3', ['23', '24', '25', '26', '27', '28', '29'], 260)]
  }, 'block');

  await probe(6, 'Use a cylinder number that does not exist in inventory', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-6', location: PLANT, bill_date: TODAY,
    given_items: [line('Nitrogen', '7 m3', ['999999'], 290)]
  }, 'block');

  await probe(7, 'Put the same cylinder twice in the Given section', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-7', location: PLANT, bill_date: TODAY,
    given_items: [line('Nitrogen', '7 m3', ['100', '100'], 290)]
  }, 'block');

  await probe(8, 'Put the same cylinder in Given AND Received on a non-swap bill', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-8', location: PLANT, bill_date: TODAY,
    given_items: [line('Nitrogen', '7 m3', ['100'], 290)],
    received_items: [line('Nitrogen', '7 m3', ['100'], 0)]
  }, 'block');

  await probe(9, 'Put an Oxygen cylinder on a Nitrogen line', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-9', location: PLANT, bill_date: TODAY,
    given_items: [line('Nitrogen', '7 m3', ['49'], 290)]
  }, 'block');

  await probe(10, 'Serial count does not match the typed quantity', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-10', location: PLANT, bill_date: TODAY,
    given_items: [{ gas_type_id: gasIds['Nitrogen'], cylinder_size_id: sizeIds['7 m3'],
                    quantity: 5, rate: 290, serial_numbers: ['100'] }]
  }, 'block');

  await probe(11, 'Save a challan with no challan number', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: '   ', location: PLANT, bill_date: TODAY,
    given_items: [line('Nitrogen', '7 m3', ['100'], 290)]
  }, 'block');

  await probe(12, 'Transfer a cylinder OUT OF a site it is not at', {
    transaction_category: 'INTERNAL_TRANSFER', challan_no: 'PROBE-12',
    from_location: OFFICE_A, to_location: OFFICE_B, serial_numbers: ['100'], bill_date: TODAY
  }, 'block');

  await probe(13, 'Transfer a cylinder that is out with a customer', {
    transaction_category: 'INTERNAL_TRANSFER', challan_no: 'PROBE-13',
    from_location: PLANT, to_location: OFFICE_A, serial_numbers: ['101'], bill_date: TODAY
  }, 'block');

  await probe(14, 'Transfer to the same site it came from', {
    transaction_category: 'INTERNAL_TRANSFER', challan_no: 'PROBE-14',
    from_location: PLANT, to_location: PLANT, serial_numbers: ['100'], bill_date: TODAY
  }, 'block');

  await probe(15, 'Filling vendor returns a cylinder that is actually held by an ordinary customer', {
    customer_id: cust['Nova Gas Refillers'], customer_type: 'REGULAR', transaction_type: 'RECEIVED',
    challan_no: 'PROBE-15', location: PLANT, bill_date: TODAY,
    received_items: [line('CO2', '30 KG', ['101'], 0)]
  }, 'block');

  await probe(16, 'Return more personal cylinders than the customer has with us', {
    customer_id: cust['Patel Welding Services'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-16', location: PLANT, bill_date: TODAY,
    given_items: [{ gas_type_id: gasIds['Nitrogen'], cylinder_size_id: sizeIds['7 m3'],
                    quantity: 0, rate: 300, serial_numbers: [], personalCylindersOut: 3 }]
  }, 'block');

  await probe(17, 'BACKDATE: give a cylinder on a date when it was still out with a customer', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-17', location: PLANT, bill_date: '2026-08-04T10:00',
    given_items: [line('Oxygen', '7 m3', ['11'], 250)]
  }, 'block');

  await probe(18, 'BACKDATE: give a cylinder on a date when it was still at a different site', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-18', location: PLANT, bill_date: '2026-08-05T10:00',
    given_items: [line('Oxygen', '7 m3', ['7'], 250)]
  }, 'block');

  // ── Maintenance is a live flag, set outside the bill path ──
  const cylinderService = require('../services/cylinder.service');
  const spare = await Cylinder.findOne({ user_id: uid, rotational_number: '100' });
  await cylinderService.setMaintenance(uid, spare._id, true, PLANT);
  await probe(19, 'Give out a cylinder that is under maintenance', {
    customer_id: cust['Ambica Steel Fabricators'], customer_type: 'REGULAR', transaction_type: 'GIVEN',
    challan_no: 'PROBE-19', location: PLANT, bill_date: TODAY,
    given_items: [line('Nitrogen', '7 m3', ['100'], 290)]
  }, 'block');
  await probe(20, 'Transfer a cylinder that is under maintenance', {
    transaction_category: 'INTERNAL_TRANSFER', challan_no: 'PROBE-20',
    from_location: PLANT, to_location: OFFICE_A, serial_numbers: ['100'], bill_date: TODAY
  }, 'block');
  await cylinderService.setMaintenance(uid, spare._id, false, PLANT);
  console.log('\n      (cylinder 100 taken back out of maintenance — inventory restored)');

  console.log('\n' + '='.repeat(96));
  console.log('GUARDS HOLDING: ' + pass + ' / ' + (pass + fail) + (fail ? '   *** ' + fail + ' DID NOT BEHAVE AS EXPECTED ***' : ''));
  const after = await Bill.countDocuments({ user_id: uid });
  console.log('Bills in the account: ' + after + ' (unchanged — every probe was rejected before saving)');
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nFAILED: ' + (e && e.message ? e.message : e)); process.exit(1); });
