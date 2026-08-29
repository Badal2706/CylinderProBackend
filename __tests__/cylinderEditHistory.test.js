// Q3: a cylinder's history must record every deliberate change made to it — gas type, size,
// location and maintenance — not only the ones that moved it between sites.
//
// Location and Stock State were already logged (Phase 33) and those lines are unchanged. Gas Type,
// Size and Maintenance are new. The maintenance endpoint logged nothing at all before.
process.env.NUMBERING_SALT = process.env.NUMBERING_SALT || 'test-salt-do-not-use-in-production';

const mongoose = require('mongoose');

const User = require('../models/User');
const Cylinder = require('../models/Cylinder');
const LocationProfile = require('../models/LocationProfile');
const CylinderHistory = require('../models/CylinderHistory');
const cylinderService = require('../services/cylinder.service');
const N = require('../services/numbering.service');
const acct = require('../services/accountNumbering.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_edithist_${Date.now()}`;
const CH = 'AT_PLANT_CHANDISAR';
const PA = 'AT_PALANPUR_OFFICE';

let user;

const logFor = (cylId) => CylinderHistory.find({ cylinder_id: cylId, event_type: 'MANUAL_EDIT' })
  .sort({ createdAt: -1 }).lean();

async function freshCylinder(rot) {
  return Cylinder.create({
    user_id: user._id, rotational_number: rot, gas_type: 'Oxygen', capacity: '7 m3',
    location: CH, stock_state: 'IN_STOCK'
  });
}

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  user = await User.create({ name: 'E', email: 'edit@hist.test', password: 'Test1234!' });
  user.account_code = N.deriveAccountCode(user._id);
  await user.save();
  acct._clearCache();

  await LocationProfile.create([
    { user_id: user._id, location: CH, label: 'Chandisar Plant', is_filling_location: true,
      is_maintenance_location: true, manager_name: 'Raju bhai' },
    { user_id: user._id, location: PA, label: 'Palanpur Office', manager_name: 'Mehul' }
  ]);
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

describe('gas type and size changes are recorded', () => {
  test('a gas type change names the person, the site and both values', async () => {
    const c = await freshCylinder('E-1');
    await cylinderService.updateCylinder(user._id, c._id, { gas_type: 'Nitrogen', active_location: CH });

    const [ev] = await logFor(c._id);
    expect(ev).toBeTruthy();
    // This is the sentence the user asked for, verbatim in shape.
    expect(ev.description).toBe('Raju bhai at Chandisar Plant changed Gas Type from Oxygen to Nitrogen');
    expect(ev.performed_by).toBe('Raju bhai');
    expect(ev.performed_at_location).toBe(CH);
  });

  test('a size change is recorded as Size', async () => {
    const c = await freshCylinder('E-2');
    await cylinderService.updateCylinder(user._id, c._id, { capacity: '6 m3', active_location: CH });

    const [ev] = await logFor(c._id);
    expect(ev.description).toBe('Raju bhai at Chandisar Plant changed Size from 7 m3 to 6 m3');
  });

  test('writing the same value again records nothing', async () => {
    const c = await freshCylinder('E-3');
    await cylinderService.updateCylinder(user._id, c._id, { gas_type: 'Oxygen', capacity: '7 m3', active_location: CH });
    expect(await logFor(c._id)).toHaveLength(0);
  });

  test('two fields changed at once produce one row each', async () => {
    const c = await freshCylinder('E-4');
    await cylinderService.updateCylinder(user._id, c._id, { gas_type: 'Argon', capacity: '6 m3', active_location: CH });

    const evs = await logFor(c._id);
    expect(evs).toHaveLength(2);
    const text = evs.map(e => e.description).join(' | ');
    expect(text).toMatch(/changed Gas Type from Oxygen to Argon/);
    expect(text).toMatch(/changed Size from 7 m3 to 6 m3/);
  });
});

describe('maintenance is recorded', () => {
  test('the dedicated maintenance endpoint now logs both directions', async () => {
    const c = await freshCylinder('E-5');

    await cylinderService.setMaintenance(user._id, c._id, true, CH);
    let evs = await logFor(c._id);
    expect(evs).toHaveLength(1);
    expect(evs[0].description).toBe('Raju bhai at Chandisar Plant changed Maintenance from In service to Under maintenance');

    await cylinderService.setMaintenance(user._id, c._id, false, CH);
    evs = await logFor(c._id);
    expect(evs).toHaveLength(2);
    expect(evs[0].description).toBe('Raju bhai at Chandisar Plant changed Maintenance from Under maintenance to In service');
  });

  test('toggling maintenance through the edit form is recorded too', async () => {
    const c = await freshCylinder('E-6');
    await cylinderService.updateCylinder(user._id, c._id, { under_maintenance: true, active_location: CH });

    const [ev] = await logFor(c._id);
    expect(ev.description).toMatch(/changed Maintenance from In service to Under maintenance/);
  });
});

describe('what was already logged still is', () => {
  test('a location change reads exactly as before', async () => {
    const c = await freshCylinder('E-7');
    await cylinderService.updateCylinder(user._id, c._id, { location: PA, active_location: CH });

    const [ev] = await logFor(c._id);
    expect(ev.description).toBe('Raju bhai at Chandisar Plant changed Location from Chandisar Plant to Palanpur Office');
    expect(ev.from_location).toBe(CH);
    expect(ev.to_location).toBe(PA);
  });

  test('a stock state change reads exactly as before', async () => {
    const c = await freshCylinder('E-8');
    await cylinderService.updateCylinder(user._id, c._id, { stock_state: 'AT_CUSTOMER', active_location: CH });

    const [ev] = await logFor(c._id);
    expect(ev.description).toMatch(/changed Stock State from/);
    expect(ev.from_state).toBe('IN_STOCK');
    expect(ev.to_state).toBe('AT_CUSTOMER');
  });
});

describe('who gets named', () => {
  test('the acting site decides the name, not the cylinder location', async () => {
    const c = await freshCylinder('E-9');
    await cylinderService.updateCylinder(user._id, c._id, { stock_state: 'AT_CUSTOMER', active_location: PA });

    const [ev] = await logFor(c._id);
    expect(ev.description).toMatch(/^Mehul at Palanpur Office /);
    expect(ev.performed_by).toBe('Mehul');
  });

  test('a site with no manager recorded falls back to the site name', async () => {
    await LocationProfile.updateOne({ user_id: user._id, location: PA }, { $set: { manager_name: '' } });
    const c = await freshCylinder('E-10');
    await cylinderService.updateCylinder(user._id, c._id, { stock_state: 'AT_CUSTOMER', active_location: PA });

    const [ev] = await logFor(c._id);
    expect(ev.description).toMatch(/^Palanpur Office at Palanpur Office /);
    expect(ev.performed_by).toBe('');
  });
});
