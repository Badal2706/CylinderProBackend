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

const TEST_DB = 'mongodb://127.0.0.1:27017/cylinder_management_test_phase34';
beforeAll(async () => { await mongoose.connect(TEST_DB); });
afterAll(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.connection.close(); });

// Phase 34: date-aware validation, recompute-on-save, and pre-software confirmation.
describe('Phase 34', () => {
  let uid, gas, size, cust, user;
  const CH = 'AT_PLANT_CHANDISAR', PA = 'AT_PALANPUR_OFFICE';
  const day = (s) => new Date(`2026-06-${s}T09:00:00`);
  const locOf = async (rot) => await Cylinder.findOne({ user_id: uid, rotational_number: rot }).lean();
  const mk = async (rot) => (await cylSvc.createCylinder(uid, { rotational_number: rot, gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK' })).cylinder_id;
  const given = (rot, date, location = CH, extra = {}) => billSvc.createBill(uid, {
    customer_id: String(cust._id), bill_date: date, transaction_type: 'GIVEN', challan_no: 'c', location,
    given_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: [rot], quantity: 1, rate: 100 }], ...extra
  });
  const received = (rot, date, location = CH, extra = {}) => billSvc.createBill(uid, {
    customer_id: String(cust._id), bill_date: date, transaction_type: 'RECEIVED', challan_no: 'c', location,
    received_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_numbers: [rot], quantity: 1 }], ...extra
  });

  beforeAll(async () => {
    user = await User.create({ name: 'P34', email: 'p34@test.com', password: 'Test1234!' });
    uid = user._id;
    await LocationProfile.create([
      { user_id: uid, location: CH, manager_name: 'Raju' },
      { user_id: uid, location: PA, manager_name: 'Manish' }
    ]);
    gas = await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
    size = await CylinderSize.create({ size_label: '7 m3', is_active: true });
    cust = await Customer.create({ user_id: uid, company_name: 'Acme', phone_primary: '9', holding_limit: 100 });
  });

  test('SV2: editing an OLD bill leaves a newer bill authoritative (recompute-on-save)', async () => {
    await mk('A');
    const b1 = await given('A', day('01'));       // A -> AT_CUSTOMER (day 1)
    await received('A', day('03'));               // A -> IN_STOCK (day 3, newer)
    expect((await locOf('A')).stock_state).toBe('IN_STOCK');
    // Edit the OLD give (day 1) — its hook re-applies AT_CUSTOMER, but recompute must restore IN_STOCK.
    await billSvc.updateBill({ id: String(uid), name: 'P34' }, String(b1.bill_id), {
      challan_no: 'c2', logEdit: false,
      line_items: [{ direction: 'GIVEN', gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_number: 'A', rate: 150 }]
    });
    expect((await locOf('A')).stock_state).toBe('IN_STOCK'); // newer receive still wins
  });

  test('SV3: backdated receive validates against as-of state, not live state', async () => {
    await mk('B');
    await given('B', day('01'));      // B out (day 1)
    await received('B', day('05'));   // B back in stock (day 5) — LIVE state now IN_STOCK
    expect((await locOf('B')).stock_state).toBe('IN_STOCK');
    // Receive dated day 3: as of then B was still AT_CUSTOMER (per day-1 give), so this is allowed
    // even though the LIVE state is in-stock. (Live-state validation would have rejected it.)
    const r = await received('B', day('03'));
    expect(r.bill_id).toBeTruthy();
  });

  test('SV5: backdated receive contradicting REAL history is hard-rejected (no confirm)', async () => {
    await mk('D');
    await given('D', day('01'));
    await received('D', day('02'));   // D in stock as of day 2 (real bills)
    // Receiving dated day 4 — real history says it was already in stock then → hard reject.
    await expect(received('D', day('04'))).rejects.toThrow(/already in stock as of/i);
  });

  test('SV4: pre-software receive (only migration placeholder precedes) asks to confirm, then saves without moving live state', async () => {
    await mk('E'); // live IN_STOCK @ Chandisar
    await CylinderHistory.create({
      user_id: uid, cylinder_id: (await locOf('E'))._id, event_type: 'MIGRATED',
      description: 'Initial record', to_location: CH, to_state: 'IN_STOCK', event_at: day('10')
    });
    // Receive dated day 5 (before the migration snapshot at day 10) — contradicts placeholder only.
    const need = await received('E', day('05'));
    expect(need.requires_pre_software_confirmation).toBe(true);
    expect(need.cylinders.map(c => c.serial)).toContain('E');
    expect(await Bill.countDocuments({ user_id: uid, 'line_items.serial_number': 'E' })).toBe(0); // nothing saved

    const ok = await received('E', day('05'), CH, { confirm_pre_software: true });
    expect(ok.bill_id).toBeTruthy();
    const e = await locOf('E');
    expect(e.location).toBe(CH); expect(e.stock_state).toBe('IN_STOCK'); // live state not moved
  });

  test('SV6: after a genuine bill exists, a later entry validates against it (not the placeholder)', async () => {
    // E now has a real receive (day 5). A give dated day 20 validates against that real bill.
    const g = await given('E', day('20'), CH);
    expect(g.bill_id).toBeTruthy();
    expect((await locOf('E')).stock_state).toBe('AT_CUSTOMER');
  });

  test('editing an OLD bill to ADD a cylinder recomputes that cylinder; the LATEST bill wins', async () => {
    await mk('G2'); await mk('H2');
    const oldBill = await given('H2', day('02'), CH);   // an old bill (day 2)
    await given('G2', day('10'), CH);                    // G2's latest real event = given (day 10)
    expect((await locOf('G2')).stock_state).toBe('AT_CUSTOMER');
    // Edit the OLD (day-2) bill to ALSO record G2 as received back that day — G2 is NEWLY added to it.
    await billSvc.updateBill({ id: String(uid), name: 'P34' }, String(oldBill.bill_id), {
      challan_no: 'e', logEdit: false,
      line_items: [
        { direction: 'GIVEN', gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_number: 'H2', rate: 100 },
        { direction: 'RECEIVED', gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_number: 'G2' }
      ]
    });
    // G2 (newly added to the edited old bill) is recomputed, and its day-10 give — the chronologically
    // latest event — remains authoritative, so the old bill's day-2 receive does not override it.
    expect((await locOf('G2')).stock_state).toBe('AT_CUSTOMER');
    // And removing G2 from the old bill again re-recomputes it (still AT_CUSTOMER from the day-10 give).
    await billSvc.updateBill({ id: String(uid), name: 'P34' }, String(oldBill.bill_id), {
      challan_no: 'e', logEdit: false,
      line_items: [{ direction: 'GIVEN', gas_type_id: String(gas._id), cylinder_size_id: String(size._id), serial_number: 'H2', rate: 100 }]
    });
    expect((await locOf('G2')).stock_state).toBe('AT_CUSTOMER');
  });

  test('same-day normal entry behaves as before — no confirmation prompt', async () => {
    await mk('F');
    const g = await given('F', new Date(), CH); // today, from its real location
    expect(g.bill_id).toBeTruthy();
    expect(g.requires_pre_software_confirmation).toBeUndefined();
  });
});
