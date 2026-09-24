// Stock Summary — the full round trip of ONE cylinder in ONE day, across two sites.
//
// This is the owner's own worked example, made executable. A cylinder comes back empty from a
// customer at a non-filling site, goes to the plant, is filled, comes back, and goes out to a
// customer again — all on the same day. Six legs, and every one of them must land in a specific
// bucket:
//
//   1. returned empty by a customer at the office   -> office   Empty  Receive
//   2. transferred office -> plant (empty)          -> office   Empty  Issue
//                                                   -> plant    Empty  Receive
//   3. filled at the plant                          -> plant    Filled Filled Today
//                                                   -> plant    Empty  Issue        (the empty is consumed)
//   4. transferred plant -> office (filled)         -> plant    Filled Issue
//                                                   -> office   Filled Add
//   5. given to a customer at the office            -> office   Filled Issue
//
// The same physical cylinder is therefore counted EIGHT times across the two reports in one day.
// That is correct: each number is a movement at a location, not a headcount of cylinders.
//
// Nothing here hardcodes a site name. The two sites are distinguished only by
// `is_filling_location`, which is what the report code actually keys on — so a client with
// different sites, or three of them, gets the same behaviour.

const mongoose = require('mongoose');

const User = require('../models/User');
const Customer = require('../models/Customer');
const Cylinder = require('../models/Cylinder');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const LocationProfile = require('../models/LocationProfile');
const FillingLogEntry = require('../models/FillingLogEntry');
const billService = require('../services/bill.service');
const fillingLog = require('../services/fillingLog.service');
const reportService = require('../services/report.service');
const N = require('../services/numbering.service');
const acct = require('../services/accountNumbering.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_roundtrip_${Date.now()}`;

// Deliberately NOT the real site names — the rule is about the filling flag, not the label.
const PLANT = 'AT_WORKS_ALPHA';       // is_filling_location: true
const OFFICE = 'AT_DEPOT_BETA';       // is_filling_location: false

const DAY = '2026-06-12';
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00+05:30`);

let user, customer, gas, size;

const SERIAL = '303';
const GAS = 'Oxygen';
const CAP = '7 m3';

const item = () => ({
  gas_type_id: String(gas._id), cylinder_size_id: String(size._id),
  quantity: 1, rate: 0, serial_numbers: [SERIAL]
});

// The row for our gas/size out of a location's summary, with zeros when the report omits it.
async function summary(location) {
  const rep = await reportService.getStockSummary(user._id, { date: DAY, location });
  const row = rep.rows.find(r => r.gas_type === GAS && r.capacity === CAP);
  return {
    label: rep.location_label,
    filled_add_label: rep.filled_add_label,
    empty_issue_label: rep.empty_issue_label,
    filled: row ? row.filled : { opening: 0, add: 0, issue: 0, closing: 0 },
    empty: row ? row.empty : { opening: 0, receive: 0, issue: 0, closing: 0 }
  };
}

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  user = await User.create({ name: 'R', email: 'round@trip.test', password: 'Test1234!' });
  user.account_code = N.deriveAccountCode(user._id);
  await user.save();
  acct._clearCache();

  await LocationProfile.create([
    { user_id: user._id, location: PLANT, label: 'Works Alpha', is_filling_location: true },
    { user_id: user._id, location: OFFICE, label: 'Depot Beta' }
  ]);
  gas = await GasType.create({ user_id: user._id, gas_type_name: GAS, is_active: true });
  size = await CylinderSize.create({ user_id: user._id, size_label: CAP, is_active: true });
  customer = await Customer.create({
    user_id: user._id, company_name: 'Round Trip Co', customer_type: 'REGULAR',
    phone_primary: '9000000000', is_active: true, holding_limit: 99
  });

  // The cylinder starts the day OUT with the customer, issued from the office the day before.
  await Cylinder.create({
    user_id: user._id, rotational_number: SERIAL, gas_type: GAS, capacity: CAP,
    location: OFFICE, stock_state: 'IN_STOCK'
  });
  await billService.createBill(user._id, {
    customer_id: String(customer._id), customer_type: 'REGULAR', challan_no: 'RT-0',
    location: OFFICE, transaction_type: 'GIVEN', given_items: [item()],
    bill_date: new Date(`2026-06-11T10:00:00+05:30`)
  });

  // ── Leg 1: returned EMPTY by the customer at the office, 10:00 ──
  await billService.createBill(user._id, {
    customer_id: String(customer._id), customer_type: 'REGULAR', challan_no: 'RT-1',
    location: OFFICE, transaction_type: 'RECEIVED', received_items: [item()],
    bill_date: at('10:00')
  });

  // ── Leg 2: transferred office -> plant, empty, 11:00 ──
  await billService.createBill(user._id, {
    transaction_category: 'INTERNAL_TRANSFER', challan_no: 'RT-2',
    from_location: OFFICE, to_location: PLANT, serial_numbers: [SERIAL],
    bill_date: at('11:00')
  });

  // ── Leg 3: filled at the plant ──
  await fillingLog.addEntry(user._id, {
    date: DAY, rotational_number: SERIAL, gas_type: GAS, capacity: CAP
  });

  // ── Leg 4: transferred plant -> office, filled, 15:00 ──
  await billService.createBill(user._id, {
    transaction_category: 'INTERNAL_TRANSFER', challan_no: 'RT-3',
    from_location: PLANT, to_location: OFFICE, serial_numbers: [SERIAL],
    bill_date: at('15:00')
  });

  // ── Leg 5: given to a customer at the office, 17:00 ──
  await billService.createBill(user._id, {
    customer_id: String(customer._id), customer_type: 'REGULAR', challan_no: 'RT-4',
    location: OFFICE, transaction_type: 'GIVEN', given_items: [item()],
    bill_date: at('17:00')
  });
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

describe('the day was actually recorded', () => {
  test('one filling-log entry exists for the day', async () => {
    expect(await FillingLogEntry.countDocuments({ user_id: user._id, date: DAY })).toBe(1);
  });

  test('the cylinder ends the day back with the customer, out of the office', async () => {
    const c = await Cylinder.findOne({ user_id: user._id, rotational_number: SERIAL }).lean();
    expect(c.stock_state).toBe('AT_CUSTOMER');
    expect(c.location).toBe(OFFICE);
  });
});

describe('the non-filling site (office) counts its four movements', () => {
  test('empty: the customer return is a Receive, the transfer out is an Issue', async () => {
    const s = await summary(OFFICE);
    expect(s.empty.receive).toBe(1);   // leg 1
    expect(s.empty.issue).toBe(1);     // leg 2
  });

  test('filled: the transfer in is an Add, the customer issue is an Issue', async () => {
    const s = await summary(OFFICE);
    expect(s.filled.add).toBe(1);      // leg 4
    expect(s.filled.issue).toBe(1);    // leg 5
  });

  test('a non-filling site never reports "Filled Today" — its filled stock only arrives', async () => {
    const s = await summary(OFFICE);
    expect(s.filled_add_label).not.toMatch(/Filled Today/);
    expect(s.filled_add_label).toMatch(/Transfers In/i);
  });
});

describe('the filling site (plant) counts its four movements', () => {
  test('empty: the transfer in is a Receive', async () => {
    const s = await summary(PLANT);
    expect(s.empty.receive).toBe(1);   // leg 2
  });

  test('empty: filling CONSUMES the empty, so it is an Issue', async () => {
    const s = await summary(PLANT);
    // This is the half that is easy to miss — a filled cylinder has stopped being an empty one.
    expect(s.empty.issue).toBe(1);     // leg 3
  });

  test('filled: the fill is Filled Today, the transfer out is an Issue', async () => {
    const s = await summary(PLANT);
    expect(s.filled.add).toBe(1);      // leg 3
    expect(s.filled.issue).toBe(1);    // leg 4
    expect(s.filled_add_label).toBe('Filled Today');
  });
});

describe('every ledger balances: Opening + In - Out = Closing', () => {
  test.each([['plant', () => PLANT], ['office', () => OFFICE]])('%s', async (_label, loc) => {
    const s = await summary(loc());
    expect(s.filled.opening + s.filled.add - s.filled.issue).toBe(s.filled.closing);
    expect(s.empty.opening + s.empty.receive - s.empty.issue).toBe(s.empty.closing);
  });
});

describe('the physical invariant: no figure may be negative', () => {
  // "How can we give a cylinder to someone if it does not exist at our location?" Every number in
  // this report is a count of physical cylinders, and there is no such thing as minus one cylinder.
  test.each([['plant', () => PLANT], ['office', () => OFFICE]])('%s has no negative figure', async (_label, loc) => {
    const s = await summary(loc());
    const all = [
      ['filled.opening', s.filled.opening], ['filled.add', s.filled.add],
      ['filled.issue', s.filled.issue], ['filled.closing', s.filled.closing],
      ['empty.opening', s.empty.opening], ['empty.receive', s.empty.receive],
      ['empty.issue', s.empty.issue], ['empty.closing', s.empty.closing]
    ];
    const negatives = all.filter(([, v]) => v < 0).map(([k, v]) => `${k}=${v}`);
    expect(negatives).toEqual([]);
  });
});

describe('the cylinder is counted once per movement, not once per day', () => {
  test('one cylinder produces eight bucket entries across the two sites', async () => {
    const p = await summary(PLANT), o = await summary(OFFICE);
    const moves = p.filled.add + p.filled.issue + p.empty.receive + p.empty.issue
                + o.filled.add + o.filled.issue + o.empty.receive + o.empty.issue;
    expect(moves).toBe(8);
  });
});
