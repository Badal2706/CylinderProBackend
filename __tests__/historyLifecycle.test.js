const mongoose = require('mongoose');
const Cylinder = require('../models/Cylinder');
const Bill = require('../models/Bill');
const CylinderHistory = require('../models/CylinderHistory');
const Customer = require('../models/Customer');
const User = require('../models/User');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const LocationProfile = require('../models/LocationProfile');
const billSvc = require('../services/bill.service');
const cylSvc = require('../services/cylinder.service');
const { stateAsOf } = require('../services/cylinderState.service');

const TEST_DB = 'mongodb://127.0.0.1:27017/cylinder_management_test_histlife';
beforeAll(async () => { await mongoose.connect(TEST_DB); });
afterAll(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.connection.close(); });

describe('cylinder history follows the bill', () => {
  let uid, gas, size, cust, vendor;
  const CH = 'AT_PLANT_CHANDISAR';
  const evs = async (rot) => {
    const c = await Cylinder.findOne({ user_id: uid, rotational_number: rot }).lean();
    return CylinderHistory.find({ user_id: uid, cylinder_id: c._id }).sort({ event_at: -1 }).lean();
  };
  const mk = async (rot) => (await cylSvc.createCylinder(uid, {
    rotational_number: rot, gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK'
  })).cylinder_id;
  const item = (rots) => ({ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: rots, quantity: rots.length, rate: 100 });

  beforeAll(async () => {
    const user = await User.create({ name: 'HL', email: 'hl@test.com', password: 'Test1234!' });
    uid = user._id;
    await LocationProfile.create([{ user_id: uid, location: CH, manager_name: 'Raju' }]);
    gas = await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
    size = await CylinderSize.create({ size_label: '7 m3', is_active: true });
    cust = await Customer.create({ user_id: uid, company_name: 'Acme', phone_primary: '1', holding_limit: 100 });
    vendor = await Customer.create({ user_id: uid, company_name: 'FillCo', phone_primary: '2', holding_limit: 100, is_filling_vendor: true });
  });

  test('a filling-vendor round trip reads as empty-out / filled-back and stays in our stock', async () => {
    await mk('H1');
    await billSvc.createBill(uid, {
      customer_id: String(vendor._id), bill_date: new Date('2026-09-01T09:00:00'),
      transaction_type: 'SWAP', challan_no: 'c', location: CH,
      given_items: [item(['H1'])], received_items: [{ ...item(['H1']), rate: 0 }]
    });
    const rows = await evs('H1');
    expect(rows.find(r => r.event_type === 'GIVEN').description).toMatch(/Given empty to FillCo for filling/);
    expect(rows.find(r => r.event_type === 'RECEIVED').description).toMatch(/Received filled from FillCo/);
    // The round trip ends in OUR stock — and the as-of validation must agree with inventory,
    // even though nothing before it ever set a stock_state.
    const cyl = await Cylinder.findOne({ user_id: uid, rotational_number: 'H1' }).lean();
    expect(cyl.stock_state).toBe('IN_STOCK');
    const asof = await stateAsOf(uid, 'H1', new Date('2026-09-30T00:00:00'), null);
    expect(asof.state.stock_state).toBe('IN_STOCK');
  });

  test('editing the bill date moves the cylinder history entry to the new date', async () => {
    await mk('H2');
    const res = await billSvc.createBill(uid, {
      customer_id: String(cust._id), bill_date: new Date('2026-09-10T09:00:00'),
      transaction_type: 'GIVEN', challan_no: 'c', location: CH, given_items: [item(['H2'])]
    });
    const before = (await evs('H2')).find(r => r.event_type === 'GIVEN');
    expect(new Date(before.event_at).toISOString()).toContain('2026-09-10');

    await billSvc.updateBill({ id: String(uid), name: 'HL' }, String(res.bill_id), {
      bill_date: new Date('2026-09-08T09:00:00'), challan_no: 'c', transaction_type: 'GIVEN', logEdit: true,
      line_items: [{ direction: 'GIVEN', gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_number: 'H2', quantity: 1, rate: 100 }]
    });
    const after = (await evs('H2')).find(r => r.event_type === 'GIVEN');
    expect(new Date(after.event_at).toISOString()).toContain('2026-09-08');
  });

  test('deleting a bill leaves a log line saying where the cylinder went back to', async () => {
    await mk('H3');
    const res = await billSvc.createBill(uid, {
      customer_id: String(cust._id), bill_date: new Date('2026-09-12T09:00:00'),
      transaction_type: 'GIVEN', challan_no: 'c', location: CH, given_items: [item(['H3'])]
    });
    await billSvc.deleteBill(uid, String(res.bill_id), { via: 'TEST', person_name: 'tester' });

    const rows = await evs('H3');
    const del = rows.find(r => r.event_type === 'BILL_DELETED');
    expect(del).toBeTruthy();
    expect(del.description).toMatch(/was deleted/);
    expect(del.description).toMatch(/in stock/);
    // and the cylinder really is back
    const cyl = await Cylinder.findOne({ user_id: uid, rotational_number: 'H3' }).lean();
    expect(cyl.stock_state).toBe('IN_STOCK');
  });

  test('removing a cylinder from a bill during an edit is logged', async () => {
    await mk('H4'); await mk('H5');
    const res = await billSvc.createBill(uid, {
      customer_id: String(cust._id), bill_date: new Date('2026-09-14T09:00:00'),
      transaction_type: 'GIVEN', challan_no: 'c', location: CH, given_items: [item(['H4', 'H5'])]
    });
    await billSvc.updateBill({ id: String(uid), name: 'HL' }, String(res.bill_id), {
      challan_no: 'c', transaction_type: 'GIVEN', logEdit: true,
      line_items: [{ direction: 'GIVEN', gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_number: 'H4', quantity: 1, rate: 100 }]
    });
    const rows = await evs('H5');
    const rm = rows.find(r => r.event_type === 'REMOVED_FROM_BILL');
    expect(rm).toBeTruthy();
    expect(rm.description).toMatch(/Removed from entry/);
  });
});

// Moving a bill's date can put it before the events that made its cylinders available. Creating a
// bill always checked that; editing the date did not, so a bill could be re-dated into a moment
// that contradicts its own cylinders and the replay would quietly produce a wrong location.
describe('re-dating a bill is validated', () => {
  let uid, gas, size, cust;
  const CH = 'AT_PLANT_CHANDISAR';
  const item = (rots) => ({ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: rots, quantity: rots.length, rate: 100 });

  beforeAll(async () => {
    const user = await User.create({ name: 'DC', email: 'dc@test.com', password: 'Test1234!' });
    uid = user._id;
    await LocationProfile.create([{ user_id: uid, location: CH, manager_name: 'Raju' }]);
    gas = await GasType.findOne({ gas_type_name: 'Oxygen' }) || await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
    size = await CylinderSize.findOne({ size_label: '7 m3' }) || await CylinderSize.create({ size_label: '7 m3', is_active: true });
    cust = await Customer.create({ user_id: uid, company_name: 'DateCo', phone_primary: '3', holding_limit: 100 });
    await cylSvc.createCylinder(uid, { rotational_number: 'D1', gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK' });
  });

  test('re-dating an issue into a window where it was already out is refused, then forced', async () => {
    // D1 goes out on the 1st, comes back on the 5th, goes out again on the 7th.
    await billSvc.createBill(uid, {
      customer_id: String(cust._id), bill_date: new Date('2026-10-01T09:00:00'),
      transaction_type: 'GIVEN', challan_no: 'c', location: CH, given_items: [item(['D1'])]
    });
    await billSvc.createBill(uid, {
      customer_id: String(cust._id), bill_date: new Date('2026-10-05T09:00:00'),
      transaction_type: 'RECEIVED', challan_no: 'c', location: CH,
      received_items: [{ ...item(['D1']), rate: 0 }]
    });
    const second = await billSvc.createBill(uid, {
      customer_id: String(cust._id), bill_date: new Date('2026-10-07T09:00:00'),
      transaction_type: 'GIVEN', challan_no: 'c', location: CH, given_items: [item(['D1'])]
    });

    const line = [{ direction: 'GIVEN', gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_number: 'D1', quantity: 1, rate: 100 }];
    // Move the second issue back to the 3rd — on that date D1 was still out from the 1st.
    const res = await billSvc.updateBill({ id: String(uid), name: 'DC' }, String(second.bill_id), {
      bill_date: new Date('2026-10-03T09:00:00'), challan_no: 'c', transaction_type: 'GIVEN',
      logEdit: true, line_items: line
    });
    expect(res.requires_date_change_confirmation).toBe(true);
    expect(res.conflicts.map(c => c.serial)).toContain('D1');
    expect(res.conflicts[0].problem).toMatch(/already out/);
    // Nothing was saved by the refused attempt.
    const stillSeventh = await Bill.findById(second.bill_id).lean();
    expect(new Date(stillSeventh.bill_date).toISOString()).toContain('2026-10-07');

    // Forcing it through saves and recomputes.
    const forced = await billSvc.updateBill({ id: String(uid), name: 'DC' }, String(second.bill_id), {
      bill_date: new Date('2026-10-03T09:00:00'), challan_no: 'c', transaction_type: 'GIVEN',
      logEdit: true, line_items: line, confirm_date_change: true
    });
    expect(forced.requires_date_change_confirmation).toBeUndefined();
    const moved = await Bill.findById(second.bill_id).lean();
    expect(new Date(moved.bill_date).toISOString()).toContain('2026-10-03');
  });
});
