const mongoose = require('mongoose');
const Cylinder = require('../models/Cylinder');
const Bill = require('../models/Bill');
const Customer = require('../models/Customer');
const User = require('../models/User');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const LocationProfile = require('../models/LocationProfile');
const CylinderHistory = require('../models/CylinderHistory');
const billSvc = require('../services/bill.service');
const cylSvc = require('../services/cylinder.service');
const fillSvc = require('../services/fillingLog.service');
const histSvc = require('../services/cylinderHistory.service');

const TEST_DB = 'mongodb://127.0.0.1:27017/cylinder_management_test_cylhist';

beforeAll(async () => { await mongoose.connect(TEST_DB); });
afterAll(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.connection.close(); });

// Phase 33: per-cylinder history is purely observational — it records events alongside the
// existing flows and NEVER writes a cylinder's location/stock_state itself.
describe('Cylinder history (Phase 33)', () => {
  let uid, gas, size, cust, C1, C2;
  const latest = async (cid) => (await CylinderHistory.find({ cylinder_id: cid })
    .sort({ event_at: -1, createdAt: -1, _id: -1 }).lean())[0];

  beforeAll(async () => {
    const user = await User.create({ name: 'Hist', email: 'hist@test.com', password: 'Test1234!' });
    uid = user._id;
    await LocationProfile.create([
      { user_id: uid, location: 'AT_PLANT_CHANDISAR', manager_name: 'Ramesh' },
      { user_id: uid, location: 'AT_PALANPUR_OFFICE', manager_name: 'Suresh' }
    ]);
    gas = await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
    size = await CylinderSize.create({ size_label: '7 m3', is_active: true });
    cust = await Customer.create({ user_id: uid, company_name: 'Acme Gases', phone_primary: '9999999999', holding_limit: 100 });
    C1 = (await cylSvc.createCylinder(uid, { rotational_number: 'H-1', gas_type: 'Oxygen', capacity: '7 m3', location: 'AT_PLANT_CHANDISAR', stock_state: 'IN_STOCK' })).cylinder_id;
    C2 = (await cylSvc.createCylinder(uid, { rotational_number: 'H-2', gas_type: 'Oxygen', capacity: '7 m3', location: 'AT_PLANT_CHANDISAR', stock_state: 'IN_STOCK' })).cylinder_id;
  });

  test('GIVEN then RECEIVED log events with customer, doc ref, and manager', async () => {
    const bill = await billSvc.createBill(uid, {
      customer_id: String(cust._id), bill_date: new Date(), transaction_type: 'GIVEN', challan_no: 'C1',
      location: 'AT_PLANT_CHANDISAR',
      given_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: ['H-1'], quantity: 1, rate: 100 }]
    });
    let e = await latest(C1);
    expect(e.event_type).toBe('GIVEN');
    expect(e.description).toBe('Given filled to Acme Gases at Chandisar Plant');
    expect(e.to_state).toBe('AT_CUSTOMER');
    expect(e.customer_name).toBe('Acme Gases');
    expect(e.document_ref).toBe(bill.bill_number);
    expect(e.performed_by).toBe('Ramesh');

    await billSvc.createBill(uid, {
      customer_id: String(cust._id), bill_date: new Date(), transaction_type: 'RECEIVED', challan_no: 'C2',
      location: 'AT_PLANT_CHANDISAR',
      received_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: ['H-1'], quantity: 1 }]
    });
    e = await latest(C1);
    expect(e.event_type).toBe('RECEIVED');
    expect(e.to_state).toBe('IN_STOCK');
  });

  test('internal transfer logs TRANSFER with source/destination and source manager', async () => {
    const bill = await billSvc.createBill(uid, {
      transaction_category: 'INTERNAL_TRANSFER', bill_date: new Date(), challan_no: 'C3',
      from_location: 'AT_PLANT_CHANDISAR', to_location: 'AT_PALANPUR_OFFICE', serial_numbers: ['H-2']
    });
    const e = await latest(C2);
    expect(e.event_type).toBe('TRANSFER');
    expect(e.description).toBe('Transferred from Chandisar Plant to Palanpur Office');
    expect(e.from_location).toBe('AT_PLANT_CHANDISAR');
    expect(e.to_location).toBe('AT_PALANPUR_OFFICE');
    expect(e.document_ref).toBe(bill.bill_number);
    expect(e.performed_by).toBe('Ramesh');
  });

  test('filling a cylinder logs FILLED but never mutates its location/stock_state', async () => {
    const before = await Cylinder.findById(C1).lean();
    await new Promise(r => setTimeout(r, 12));
    await fillSvc.saveDay(uid, { date: '2026-08-17', entries: [{ rotational_number: 'H-1' }] });
    const after = await Cylinder.findById(C1).lean();
    expect(after.location).toBe(before.location);
    expect(after.stock_state).toBe(before.stock_state);
    expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
    // A FILLED entry is dated to the fill's DAY (Phase 34), so it need not be the absolute latest
    // among same-day timed transactions — assert it exists rather than that it sorts on top.
    const fills = await CylinderHistory.find({ cylinder_id: C1, event_type: 'FILLED' }).lean();
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0].description).toBe('Filled at Chandisar Plant on 2026-08-17');
  });

  test('manual edit logs MANUAL_EDIT with the active session location manager', async () => {
    await cylSvc.updateCylinder(uid, String(C1), { stock_state: 'AT_CUSTOMER', active_location: 'AT_PALANPUR_OFFICE' });
    const e = await latest(C1);
    expect(e.event_type).toBe('MANUAL_EDIT');
    expect(e.description).toBe('Suresh at Palanpur Office changed Stock State from In Stock to At Customer');
    expect(e.from_state).toBe('IN_STOCK');
    expect(e.to_state).toBe('AT_CUSTOMER');
  });

  test('rolling cap keeps only the 15 most recent entries', async () => {
    const now = Date.now();
    const bulk = Array.from({ length: 20 }, (_, i) => ({
      user_id: uid, cylinder_id: C2, rotational_number: 'H-2', event_type: 'FILLED',
      description: `bulk #${i}`, event_at: new Date(now + i * 1000)
    }));
    await histSvc.logEvents(bulk);
    const all = await CylinderHistory.find({ cylinder_id: C2 }).sort({ event_at: -1, createdAt: -1, _id: -1 }).lean();
    expect(all.length).toBe(15);
    expect(all[0].description).toBe('bulk #19');
    expect(all.some(x => x.description === 'bulk #0')).toBe(false);
  });

  test('getHistory returns a header plus capped, newest-first events', async () => {
    const read = await histSvc.getHistory(uid, String(C1));
    expect(read.cylinder.rotational_number).toBe('H-1');
    expect(read.history.length).toBeGreaterThan(0);
    expect(read.history.length).toBeLessThanOrEqual(15);
  });
});
