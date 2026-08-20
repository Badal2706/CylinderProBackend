const mongoose = require('mongoose');
const Cylinder = require('../models/Cylinder');
const CylinderHistory = require('../models/CylinderHistory');
const Customer = require('../models/Customer');
const User = require('../models/User');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const LocationProfile = require('../models/LocationProfile');
const billSvc = require('../services/bill.service');
const cylSvc = require('../services/cylinder.service');

const TEST_DB = 'mongodb://127.0.0.1:27017/cylinder_management_test_phase35';
beforeAll(async () => { await mongoose.connect(TEST_DB); });
afterAll(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.connection.close(); });

// Phase 35: a cylinder ADDED to an internal transfer during a later edit takes effect at the moment
// it was added — so the transfer stays authoritative over receives entered before that edit
// (the "vehicle collects Palanpur empties en route, then they're added to the Pal→Chandisar
// transfer" case). Its status must land at the transfer's destination, not bounce back.
describe('Phase 35 — added-to-transfer timing', () => {
  let uid, gas, size, cust;
  const CH = 'AT_PLANT_CHANDISAR', PA = 'AT_PALANPUR_OFFICE';
  const day = (s) => new Date(`2026-06-${s}T09:00:00`);
  const locOf = async (rot) => (await Cylinder.findOne({ user_id: uid, rotational_number: rot }).lean());
  const mk = async (rot) => (await cylSvc.createCylinder(uid, { rotational_number: rot, gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK' })).cylinder_id;
  const xfer = (serials, from, to, date) => billSvc.createBill(uid, {
    transaction_category: 'INTERNAL_TRANSFER', bill_date: date, challan_no: 'c', from_location: from, to_location: to, serial_numbers: serials
  });
  const given = (rot, date, loc) => billSvc.createBill(uid, {
    customer_id: String(cust._id), bill_date: date, transaction_type: 'GIVEN', challan_no: 'c', location: loc,
    given_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: [rot], quantity: 1, rate: 100 }]
  });
  const received = (rot, date, loc) => billSvc.createBill(uid, {
    customer_id: String(cust._id), bill_date: date, transaction_type: 'RECEIVED', challan_no: 'c', location: loc,
    received_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: [rot], quantity: 1 }]
  });

  beforeAll(async () => {
    const user = await User.create({ name: 'P35', email: 'p35@test.com', password: 'Test1234!' });
    uid = user._id;
    await LocationProfile.create([{ user_id: uid, location: CH, manager_name: 'Raju' }, { user_id: uid, location: PA, manager_name: 'Manish' }]);
    gas = await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
    size = await CylinderSize.create({ size_label: '7 m3', is_active: true });
    cust = await Customer.create({ user_id: uid, company_name: 'Acme', phone_primary: '9', holding_limit: 100 });
  });

  test('cylinder added to a Pal→Chandisar transfer via edit lands at Chandisar, beating an earlier-dated receive', async () => {
    // T1 goes out to a Palanpur customer.
    await mk('T1');
    await xfer(['T1'], CH, PA, day('01'));         // T1 -> Palanpur
    await given('T1', day('02'), PA);              // T1 -> AT_CUSTOMER (with a Palanpur customer)
    // A Pal→Chandisar transfer is created (with a filler cylinder) — this is the vehicle bill.
    await mk('T2'); await xfer(['T2'], CH, PA, day('03')); // stage T2 at Palanpur
    const vehicle = await xfer(['T2'], PA, CH, day('04'));  // the Pal->Chan transfer bill
    // Later, T1's empty is collected & received back at Palanpur (created AFTER the transfer bill).
    await received('T1', day('05'), PA);           // T1 -> IN_STOCK at Palanpur
    expect((await locOf('T1')).location).toBe(PA);
    // Now the operator edits the transfer bill to ADD T1 (it was on the same vehicle to Chandisar).
    await billSvc.updateBill({ id: String(uid), name: 'P35' }, String(vehicle.bill_id), {
      challan_no: 'c', from_location: PA, to_location: CH, serial_numbers: ['T2', 'T1']
    });
    // T1 was added during the edit → its transfer is the latest action → it lands at Chandisar,
    // NOT back at Palanpur (which is what bill_date ordering alone would have given).
    expect((await locOf('T1')).location).toBe(CH);
    expect((await locOf('T1')).stock_state).toBe('IN_STOCK');
    // The transfer's original cylinder (T2) is unaffected — still at Chandisar.
    expect((await locOf('T2')).location).toBe(CH);
    // A history event for the add must exist — the transfer now shows up in T1's history, marked
    // as added-in-update, and sorted to the top (event_at = edit time).
    const t1 = await locOf('T1');
    const evs = await CylinderHistory.find({ user_id: uid, cylinder_id: t1._id }).sort({ event_at: -1 }).lean();
    expect(evs[0].event_type).toBe('TRANSFER');
    expect(evs[0].to_location).toBe(CH);
    expect(evs[0].description).toMatch(/added later in an update/);
  });

  test('adding a cylinder still in stock elsewhere is rejected (dots must connect)', async () => {
    await mk('T3'); // T3 is IN_STOCK at Chandisar, never sent to Palanpur
    await mk('T4'); await xfer(['T4'], CH, PA, day('06'));
    const v = await xfer(['T4'], PA, CH, day('07'));
    // Try to add T3 (which is at Chandisar) to a Pal->Chan transfer — it isn't at Palanpur → error.
    await expect(billSvc.updateBill({ id: String(uid), name: 'P35' }, String(v.bill_id), {
      challan_no: 'c', from_location: PA, to_location: CH, serial_numbers: ['T4', 'T3']
    })).rejects.toThrow(/T3/);
  });
});
