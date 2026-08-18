const mongoose = require('mongoose');
const Cylinder = require('../models/Cylinder');
const User = require('../models/User');
const { createCylinder } = require('../services/cylinder.service');
const { saveDay, addEntry } = require('../services/fillingLog.service');

const TEST_DB = 'mongodb://127.0.0.1:27017/cylinder_management_test_filllog';

beforeAll(async () => { await mongoose.connect(TEST_DB); });
afterAll(async () => { await mongoose.connection.db.dropDatabase(); await mongoose.connection.close(); });

// Phase 32 item 6: the Filling List is a pure log feeding Stock Summary's "Filled Today". It must
// NEVER write a cylinder's location/stock_state — those change only through transaction flows.
describe('Filling List never mutates cylinder location/stock_state', () => {
  let userId, cylId;
  const ROT = 'FILL-100';

  beforeAll(async () => {
    const user = await User.create({ name: 'Fill Test', email: 'filltest@test.com', password: 'Test1234!' });
    userId = user._id;
    const r = await createCylinder(userId, {
      rotational_number: ROT, gas_type: 'Oxygen', capacity: '7 m3',
      location: 'AT_PLANT_CHANDISAR', stock_state: 'IN_STOCK'
    });
    cylId = r.cylinder_id;
  });

  test('saveDay leaves the cylinder untouched (location, stock_state, updatedAt)', async () => {
    const before = await Cylinder.findById(cylId).lean();
    await new Promise(r => setTimeout(r, 10));
    await saveDay(userId, { date: '2026-08-20', entries: [{ rotational_number: ROT }] });
    const after = await Cylinder.findById(cylId).lean();
    expect(after.location).toBe(before.location);
    expect(after.stock_state).toBe(before.stock_state);
    // updatedAt would bump if the filling log wrote to the doc at all.
    expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
  });

  test('a cylinder a later transaction moved out is NOT reverted by a subsequent filling-list save', async () => {
    // Simulate a real transaction (transfer/give) persisting a new location/state.
    await Cylinder.updateOne({ _id: cylId }, { location: 'AT_PALANPUR_OFFICE', stock_state: 'AT_CUSTOMER' });
    // Re-save the filling list for the same day, cylinder still listed (even twice).
    await saveDay(userId, { date: '2026-08-20', entries: [{ rotational_number: ROT }, { rotational_number: ROT }] });
    const after = await Cylinder.findById(cylId).lean();
    expect(after.location).toBe('AT_PALANPUR_OFFICE'); // stays where the transaction left it
    expect(after.stock_state).toBe('AT_CUSTOMER');
  });

  test('addEntry leaves the cylinder untouched', async () => {
    const before = await Cylinder.findById(cylId).lean();
    await new Promise(r => setTimeout(r, 10));
    await addEntry(userId, { date: '2026-08-21', rotational_number: ROT });
    const after = await Cylinder.findById(cylId).lean();
    expect(after.location).toBe(before.location);
    expect(after.stock_state).toBe(before.stock_state);
    expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
  });
});
