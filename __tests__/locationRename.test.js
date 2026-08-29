// A location's NAME is editable until the site is put to work, and fixed afterwards.
//
// The reason is the same one that freezes a printed bill number: the name is stamped onto
// challans, written into cylinder history sentences, and used as every report's header. Renaming a
// site that already has records would silently rewrite what those documents say happened.
//
// The location CODE is permanent either way (R83) — this is only about the display name.
process.env.NUMBERING_SALT = process.env.NUMBERING_SALT || 'test-salt-do-not-use-in-production';

const mongoose = require('mongoose');

const User = require('../models/User');
const Customer = require('../models/Customer');
const Cylinder = require('../models/Cylinder');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const LocationProfile = require('../models/LocationProfile');
const profileSvc = require('../services/profile.service');
const billService = require('../services/bill.service');
const N = require('../services/numbering.service');
const acct = require('../services/accountNumbering.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_locrename_${Date.now()}`;

const PLANT = 'AT_MAIN_PLANT';
const DEPOT = 'AT_SIDE_DEPOT';

let user, customer, gas, size;

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  await LocationProfile.syncIndexes();
  user = await User.create({ name: 'L', email: 'loc@rename.test', password: 'Test1234!' });
  user.account_code = N.deriveAccountCode(user._id);
  await user.save();
  acct._clearCache();

  await LocationProfile.create([
    { user_id: user._id, location: PLANT, label: 'Main Plant', is_filling_location: true },
    { user_id: user._id, location: DEPOT, label: 'Side Depot' }
  ]);
  gas = await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
  size = await CylinderSize.create({ size_label: '7 m3', is_active: true });
  customer = await Customer.create({
    user_id: user._id, company_name: 'Any Customer', customer_type: 'REGULAR',
    phone_primary: '9000000000', is_active: true, holding_limit: 99
  });
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

const labelOf = async (code) =>
  (await LocationProfile.findOne({ user_id: user._id, location: code }).lean()).label;

describe('a brand-new, unused site', () => {
  test('reports itself as renameable, with no usage', async () => {
    const { profiles } = await profileSvc.getLocationProfiles(user._id);
    const plant = profiles.find(p => p.location === PLANT);
    expect(plant.renameable).toBe(true);
    expect(plant.usage).toEqual({ bills: 0, cylinders: 0 });
  });

  test('can be renamed — this is the case a new account needs on day one', async () => {
    await profileSvc.updateLocationProfile(user._id, PLANT, { label: 'Chandisar Plant' });
    expect(await labelOf(PLANT)).toBe('Chandisar Plant');
  });

  test('renaming does NOT change the permanent code', async () => {
    const p = await LocationProfile.findOne({ user_id: user._id, location: PLANT }).lean();
    expect(p.location).toBe(PLANT);   // R83: the code is referenced forever by bills and history
  });

  test('a blank name is refused', async () => {
    await expect(profileSvc.updateLocationProfile(user._id, PLANT, { label: '   ' }))
      .rejects.toThrow(/cannot be blank/i);
  });
});

describe('once a cylinder sits at the site', () => {
  beforeAll(async () => {
    await Cylinder.create({
      user_id: user._id, rotational_number: 'LOC-1', gas_type: 'Oxygen', capacity: '7 m3',
      location: DEPOT, stock_state: 'IN_STOCK'
    });
  });

  test('it is reported as no longer renameable, and says why', async () => {
    const { profiles } = await profileSvc.getLocationProfiles(user._id);
    const depot = profiles.find(p => p.location === DEPOT);
    expect(depot.renameable).toBe(false);
    expect(depot.usage.cylinders).toBe(1);
  });

  test('renaming it is refused, naming what is in the way', async () => {
    const err = await profileSvc.updateLocationProfile(user._id, DEPOT, { label: 'Renamed Depot' })
      .catch(e => e);
    expect(err.message).toMatch(/cannot be renamed/i);
    expect(err.message).toMatch(/1 cylinder/);
    expect(await labelOf(DEPOT)).toBe('Side Depot');
  });

  test('the OTHER site is unaffected and still renameable', async () => {
    const { profiles } = await profileSvc.getLocationProfiles(user._id);
    expect(profiles.find(p => p.location === PLANT).renameable).toBe(true);
  });
});

describe('once a transaction has been recorded at the site', () => {
  beforeAll(async () => {
    await Cylinder.create({
      user_id: user._id, rotational_number: 'LOC-2', gas_type: 'Oxygen', capacity: '7 m3',
      location: PLANT, stock_state: 'IN_STOCK'
    });
    await billService.createBill(user._id, {
      customer_id: String(customer._id), customer_type: 'REGULAR', challan_no: 'LR-1',
      location: PLANT, transaction_type: 'GIVEN',
      given_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id),
                      quantity: 1, rate: 0, serial_numbers: ['LOC-2'] }],
      bill_date: new Date('2026-06-12T10:00:00+05:30')
    });
  });

  test('the site is locked, and the reason counts the transaction', async () => {
    const { profiles } = await profileSvc.getLocationProfiles(user._id);
    const plant = profiles.find(p => p.location === PLANT);
    expect(plant.renameable).toBe(false);
    expect(plant.usage.bills).toBeGreaterThanOrEqual(1);
  });

  test('renaming is refused', async () => {
    await expect(profileSvc.updateLocationProfile(user._id, PLANT, { label: 'Something Else' }))
      .rejects.toThrow(/cannot be renamed/i);
  });
});

describe('a locked site is not otherwise frozen', () => {
  // The settings form posts EVERY card on every save. If re-sending an unchanged name counted as
  // a rename, a locked site could never have its manager or challan prefix corrected again.
  test('re-sending the identical name is not treated as a rename', async () => {
    const current = await labelOf(PLANT);
    await expect(profileSvc.updateLocationProfile(user._id, PLANT, {
      label: current, manager_name: 'Raju bhai', contact_number: '9876543210', challan_prefix: 'C-'
    })).resolves.toBeTruthy();

    const p = await LocationProfile.findOne({ user_id: user._id, location: PLANT }).lean();
    expect(p.label).toBe(current);
    expect(p.manager_name).toBe('Raju bhai');
    expect(p.challan_prefix).toBe('C-');
  });

  test('the batch save works across a locked and an unlocked site together', async () => {
    const plantLabel = await labelOf(PLANT);
    const depotLabel = await labelOf(DEPOT);
    await expect(profileSvc.updateLocationProfilesBatch(user._id, [
      { location: PLANT, label: plantLabel, manager_name: 'Raju bhai' },
      { location: DEPOT, label: depotLabel, manager_name: 'Mehul' }
    ])).resolves.toBeTruthy();

    expect((await LocationProfile.findOne({ user_id: user._id, location: DEPOT }).lean()).manager_name)
      .toBe('Mehul');
  });

  test('the filling flag can still be moved to a locked site', async () => {
    // Locking the NAME must not lock the site's role — R93 gates that separately.
    await profileSvc.updateLocationProfile(user._id, DEPOT, { is_filling_location: true });
    const { fillingLocationCode } = await require('../services/location.service').getUserLocations(user._id);
    expect(fillingLocationCode).toBe(DEPOT);
  });
});

describe('the usage helper itself', () => {
  test('counts transfers at both endpoints, not just the origin', async () => {
    const fresh = 'AT_FRESH_SITE';
    await LocationProfile.create({ user_id: user._id, location: fresh, label: 'Fresh Site' });
    expect((await profileSvc.locationUsage(user._id, fresh)).in_use).toBe(false);

    await Cylinder.create({
      user_id: user._id, rotational_number: 'LOC-3', gas_type: 'Oxygen', capacity: '7 m3',
      location: PLANT, stock_state: 'IN_STOCK'
    });
    await billService.createBill(user._id, {
      transaction_category: 'INTERNAL_TRANSFER', challan_no: 'LR-2',
      from_location: PLANT, to_location: fresh, serial_numbers: ['LOC-3'],
      bill_date: new Date('2026-06-13T10:00:00+05:30')
    });

    // The transfer only names `fresh` as the DESTINATION — it must still count as usage.
    const usage = await profileSvc.locationUsage(user._id, fresh);
    expect(usage.bills).toBe(1);
    expect(usage.in_use).toBe(true);
  });
});
