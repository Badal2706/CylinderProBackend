const mongoose = require('mongoose');
const Bill = require('../models/Bill');
const Customer = require('../models/Customer');
const User = require('../models/User');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const LocationProfile = require('../models/LocationProfile');
const billSvc = require('../services/bill.service');
const cylSvc = require('../services/cylinder.service');

const TEST_DB = 'mongodb://127.0.0.1:27017/cylinder_management_test_billtz';
beforeAll(async () => { await mongoose.connect(TEST_DB); });
afterAll(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.connection.close(); });

// Some browsers (Safari) return Invalid Date for `new Date('YYYY-MM-DDTHH:MM')`, and the frontend
// then fell back to POSTing that naive local string. Mongoose parsed it as UTC, so an IST bill
// landed +5:30 in the future — which reordered the state replay and parked cylinders at the wrong
// site. The frontend now always sends a UTC instant, but a browser on cached JS still might not,
// so the server treats a zone-less datetime as IST.
describe('naive bill_date is interpreted as IST, not UTC', () => {
  let uid, gas, size, cust;
  const CH = 'AT_PLANT_CHANDISAR';

  beforeAll(async () => {
    const user = await User.create({ name: 'TZ', email: 'tz@test.com', password: 'Test1234!' });
    uid = user._id;
    await LocationProfile.create([{ user_id: uid, location: CH, manager_name: 'Raju' }]);
    gas = await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
    size = await CylinderSize.create({ size_label: '7 m3', is_active: true });
    cust = await Customer.create({ user_id: uid, company_name: 'TZ Co', phone_primary: '9', holding_limit: 50 });
    await cylSvc.createCylinder(uid, { rotational_number: 'Z1', gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK' });
  });

  test('a zone-less "16:53" is stored as 11:23Z (IST), not 16:53Z', async () => {
    const res = await billSvc.createBill(uid, {
      customer_id: String(cust._id),
      bill_date: '2026-08-20T16:53',          // naive local wall-clock, exactly what the old code sent
      transaction_type: 'GIVEN', challan_no: 'c', location: CH,
      given_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: ['Z1'], quantity: 1, rate: 100 }]
    });
    const bill = await Bill.findById(res.bill_id).lean();
    expect(new Date(bill.bill_date).toISOString()).toBe('2026-08-20T11:23:00.000Z');
  });

  test('a proper UTC instant is stored unchanged', async () => {
    const iso = '2026-08-20T11:23:00.000Z';
    const res = await billSvc.createBill(uid, {
      customer_id: String(cust._id), bill_date: iso,
      transaction_type: 'RECEIVED', challan_no: 'c', location: CH,
      received_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: ['Z1'], quantity: 1 }]
    });
    const bill = await Bill.findById(res.bill_id).lean();
    expect(new Date(bill.bill_date).toISOString()).toBe(iso);
  });

  test('a date-only value keeps its existing meaning (midnight UTC)', async () => {
    const res = await billSvc.createBill(uid, {
      customer_id: String(cust._id), bill_date: '2026-08-21',
      transaction_type: 'GIVEN', challan_no: 'c', location: CH,
      given_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: ['Z1'], quantity: 1, rate: 100 }]
    });
    const bill = await Bill.findById(res.bill_id).lean();
    expect(new Date(bill.bill_date).toISOString()).toBe('2026-08-21T00:00:00.000Z');
  });
});
