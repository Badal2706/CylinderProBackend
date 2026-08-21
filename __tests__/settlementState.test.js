const mongoose = require('mongoose');
const Cylinder = require('../models/Cylinder');
const Customer = require('../models/Customer');
const User = require('../models/User');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const LocationProfile = require('../models/LocationProfile');
const billSvc = require('../services/bill.service');
const cylSvc = require('../services/cylinder.service');

const TEST_DB = 'mongodb://127.0.0.1:27017/cylinder_management_test_settlement';
beforeAll(async () => { await mongoose.connect(TEST_DB); });
afterAll(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.connection.close(); });

// A cross-customer return re-saves the ORIGINAL holder's (old) bill to mark the returned line.
// That re-fires the bill's post-save hook, which re-applies that old bill's movements to EVERY
// serial on it — rewinding unrelated cylinders to a stale state. The Phase 34 replay must cover
// those collateral serials, not just the ones on the bill being saved.
describe('cross-customer return settlement — collateral serials', () => {
  let uid, gas, size, custA, custB;
  const CH = 'AT_PLANT_CHANDISAR';
  const day = (s) => new Date(`2026-07-${s}T09:00:00`);
  const locOf = async (rot) => Cylinder.findOne({ user_id: uid, rotational_number: rot }).lean();
  const mk = async (rot) => (await cylSvc.createCylinder(uid, {
    rotational_number: rot, gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK'
  })).cylinder_id;
  const given = (rots, cust, date) => billSvc.createBill(uid, {
    customer_id: String(cust._id), bill_date: date, transaction_type: 'GIVEN', challan_no: 'c', location: CH,
    given_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: rots, quantity: rots.length, rate: 100 }]
  });
  const received = (rots, cust, date) => billSvc.createBill(uid, {
    customer_id: String(cust._id), bill_date: date, transaction_type: 'RECEIVED', challan_no: 'c', location: CH,
    received_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: rots, quantity: rots.length }]
  });

  beforeAll(async () => {
    const user = await User.create({ name: 'SET', email: 'settle@test.com', password: 'Test1234!' });
    uid = user._id;
    await LocationProfile.create([{ user_id: uid, location: CH, manager_name: 'Raju' }]);
    gas = await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
    size = await CylinderSize.create({ size_label: '7 m3', is_active: true });
    custA = await Customer.create({ user_id: uid, company_name: 'Cust A', phone_primary: '1', holding_limit: 500 });
    custB = await Customer.create({ user_id: uid, company_name: 'Cust B', phone_primary: '2', holding_limit: 500 });
  });

  test('settling one serial does not rewind a cylinder already returned on the same old bill', async () => {
    await mk('S1'); await mk('S2');
    // One old bill gives BOTH cylinders to customer A.
    await given(['S1', 'S2'], custA, day('01'));
    // S2 comes back from A directly. A same-customer return leaves the day-01 GIVEN line
    // unmarked, so re-saving that bill would flip S2 to AT_CUSTOMER again.
    await received(['S2'], custA, day('02'));
    expect((await locOf('S2')).stock_state).toBe('IN_STOCK');

    // Now S1 is returned by customer B (cross-customer). Settling it re-saves A's day-01 bill,
    // whose post-save hook re-applies GIVEN to BOTH S1 and S2.
    await received(['S1'], custB, day('05'));

    // S1 genuinely came back.
    expect((await locOf('S1')).stock_state).toBe('IN_STOCK');
    // S2 must NOT be dragged back out to the customer — it was already returned.
    expect((await locOf('S2')).stock_state).toBe('IN_STOCK');
  });

  test('deleting the settling bill also restores collateral serials', async () => {
    await mk('T1'); await mk('T2');
    await given(['T1', 'T2'], custA, day('10'));
    await received(['T2'], custA, day('11'));
    const settle = await received(['T1'], custB, day('13')); // cross-customer settlement
    expect((await locOf('T2')).stock_state).toBe('IN_STOCK');

    // Deleting it un-marks the return and re-saves A's day-10 bill — same collateral risk.
    await billSvc.deleteBill(uid, String(settle.bill_id), { via: 'TEST', person_name: 'tester' });

    expect((await locOf('T1')).stock_state).toBe('AT_CUSTOMER'); // back out with A
    expect((await locOf('T2')).stock_state).toBe('IN_STOCK');    // still returned
  });
});
