// Phase GEN-B2 — creating a location and moving the filling flag.
const mongoose = require('mongoose');
const User = require('../models/User');
const LocationProfile = require('../models/LocationProfile');
const locationService = require('../services/location.service');
const profileSvc = require('../services/profile.service');
const cylSvc = require('../services/cylinder.service');

const CH = 'AT_PLANT_CHANDISAR';
const PA = 'AT_PALANPUR_OFFICE';
let uid;

beforeAll(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/cylinder_management_test_genb2_${Date.now()}`);
  await LocationProfile.syncIndexes();
  const user = await User.create({ name: 'B2', email: 'b2@test.com', password: 'Test1234!' });
  uid = user._id;
  // GEN-C: getLocationProfiles now seeds ONE generic site into an empty account, not Guru's three.
  // These tests exercise the legacy codes, so they create them outright.
  await LocationProfile.create([
    { user_id: uid, location: 'AT_PLANT_CHANDISAR', label: 'Chandisar Plant', is_filling_location: true },
    { user_id: uid, location: 'AT_PALANPUR_OFFICE', label: 'Palanpur Office' },
    { user_id: uid, location: 'AT_CHHAPI_OFFICE', label: 'Chhapi Office' }
  ]);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('creating a location', () => {
  test('generates a permanent code from the label and leaves everything else alone', async () => {
    const before = await locationService.getUserLocations(uid);
    const res = await profileSvc.createLocationProfile(uid, {
      label: 'Deesa Depot', manager_name: 'Kiran', contact_number: 'Deesa: 90000 11111', challan_prefix: 'D-'
    });
    expect(res.profile.location).toBe('AT_DEESA_DEPOT');
    expect(res.profile.label).toBe('Deesa Depot');
    expect(res.profile.is_filling_location).toBe(false);

    const after = await locationService.getUserLocations(uid);
    expect(after.codes).toEqual([...before.codes, 'AT_DEESA_DEPOT']);
    // The existing sites and the filling assignment are untouched.
    expect(after.fillingLocationCode).toBe(before.fillingLocationCode);
    before.codes.forEach(c => expect(after.labels[c]).toBe(before.labels[c]));
  });

  test('the generated code is immutable afterwards', async () => {
    const p = await LocationProfile.findOne({ user_id: uid, location: 'AT_DEESA_DEPOT' });
    p.location = 'AT_SOMETHING_ELSE';
    await p.save();
    expect((await LocationProfile.findById(p._id)).location).toBe('AT_DEESA_DEPOT');
  });

  test('a colliding label gets a suffixed code, not a duplicate', async () => {
    await LocationProfile.create({ user_id: uid, location: 'AT_RADHANPUR', label: 'Something Else' });
    const res = await profileSvc.createLocationProfile(uid, { label: 'Radhanpur' });
    expect(res.profile.location).toBe('AT_RADHANPUR_2');
  });

  test('a duplicate NAME is refused outright', async () => {
    await expect(profileSvc.createLocationProfile(uid, { label: 'deesa depot' }))
      .rejects.toThrow(/already have a location/i);
  });

  test('a blank name is refused', async () => {
    await expect(profileSvc.createLocationProfile(uid, { label: '   ' }))
      .rejects.toThrow(/name is required/i);
  });

  test('the new code resolves through normalizeLocation, by code and by label', async () => {
    const reg = await locationService.getUserLocations(uid);
    expect(cylSvc.matchLocation(reg, 'AT_DEESA_DEPOT')).toBe('AT_DEESA_DEPOT');
    expect(cylSvc.matchLocation(reg, 'deesa depot')).toBe('AT_DEESA_DEPOT');
    expect(cylSvc.matchLocation(reg, 'Deesa')).toBe('AT_DEESA_DEPOT');
  });

  test('a cylinder can be created at the new location', async () => {
    const GasType = require('../models/GasType');
    const CylinderSize = require('../models/CylinderSize');
    await GasType.findOne({ gas_type_name: 'Oxygen' }) || await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
    await CylinderSize.findOne({ size_label: '7 m3' }) || await CylinderSize.create({ size_label: '7 m3', is_active: true });
    const c = await cylSvc.createCylinder(uid, {
      rotational_number: 'B2-1', gas_type: 'Oxygen', capacity: '7 m3', location: 'AT_DEESA_DEPOT', stock_state: 'IN_STOCK'
    });
    expect(c.cylinder_id).toBeDefined();
  });
});

describe('moving the filling flag', () => {
  const flagged = async () => (await LocationProfile.find({ user_id: uid, is_filling_location: true })).map(p => p.location);

  test('exactly one location is flagged before and after a reassignment', async () => {
    expect(await flagged()).toEqual([CH]);
    await profileSvc.updateLocationProfile(uid, PA, { is_filling_location: true });
    expect(await flagged()).toEqual([PA]);
    expect((await locationService.getUserLocations(uid)).fillingLocationCode).toBe(PA);
  });

  test('the anchor really moves — the maintenance gate follows it', async () => {
    const a = await cylSvc.createCylinder(uid, {
      rotational_number: 'B2-M1', gas_type: 'Oxygen', capacity: '7 m3', location: PA, stock_state: 'IN_STOCK'
    });
    await expect(cylSvc.setMaintenance(uid, String(a.cylinder_id), true)).resolves.toBeDefined();

    const b = await cylSvc.createCylinder(uid, {
      rotational_number: 'B2-M2', gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK'
    });
    await expect(cylSvc.setMaintenance(uid, String(b.cylinder_id), true))
      .rejects.toThrow(/Palanpur Office/);
  });

  test('reassigning to the location that already holds it is a no-op', async () => {
    await profileSvc.updateLocationProfile(uid, PA, { is_filling_location: true });
    expect(await flagged()).toEqual([PA]);
  });

  test('standing down leaves zero — a legal state — and it can be reassigned after', async () => {
    await profileSvc.updateLocationProfile(uid, PA, { is_filling_location: false });
    expect(await flagged()).toEqual([]);
    expect((await locationService.getUserLocations(uid)).fillingLocationCode).toBeNull();
    await profileSvc.updateLocationProfile(uid, CH, { is_filling_location: true });
    expect(await flagged()).toEqual([CH]);
  });

  test('a batch carrying two filling locations is refused before anything is written', async () => {
    await expect(profileSvc.updateLocationProfilesBatch(uid, [
      { location: CH, is_filling_location: true },
      { location: PA, is_filling_location: true }
    ])).rejects.toThrow(/Only one location can be the filling location/);
    expect(await flagged()).toEqual([CH]);   // unchanged
  });

  test('creating a second location as filling moves the flag rather than duplicating it', async () => {
    const res = await profileSvc.createLocationProfile(uid, { label: 'Tharad Yard', is_filling_location: true });
    expect(res.profile.is_filling_location).toBe(true);
    expect(await flagged()).toEqual([res.profile.location]);
  });

  test('the database refuses two flagged rows however they are written', async () => {
    const current = (await locationService.getUserLocations(uid)).fillingLocationCode;
    const other = current === CH ? PA : CH;
    await expect(
      LocationProfile.updateOne({ user_id: uid, location: other }, { $set: { is_filling_location: true } })
    ).rejects.toMatchObject({ code: 11000 });
    expect(await flagged()).toEqual([current]);
  });
});

// The swap is two writes on a standalone mongod. This proves the forced order never produces the
// state the unique index forbids, and that a mid-way failure is recoverable rather than corrupt.
describe('a failure part-way through the swap', () => {
  test('never leaves two locations flagged, and the account recovers', async () => {
    const u = await User.create({ name: 'B2f', email: 'b2f@test.com', password: 'Test1234!' });
    // GEN-C: a brand-new account is seeded with ONE generic site, already flagged as filling.
    const seeded = await profileSvc.getLocationProfiles(u._id);
    expect(seeded.profiles.map(p => p.location)).toEqual(['AT_MAIN_PLANT']);
    const flaggedFor = async () => (await LocationProfile.find({ user_id: u._id, is_filling_location: true })).map(p => p.location);
    expect(await flaggedFor()).toEqual(['AT_MAIN_PLANT']);

    // A second site to move the flag to later.
    await LocationProfile.create({ user_id: u._id, location: PA, label: 'Palanpur Office' });

    // Simulate the crash window: the old flag is cleared, the new one never gets set.
    await LocationProfile.updateMany({ user_id: u._id, is_filling_location: true }, { $set: { is_filling_location: false } });
    expect(await flaggedFor()).toEqual([]);           // zero — degraded, never two
    const mid = await locationService.getUserLocations(u._id);
    expect(mid.fillingLocationCode).toBeNull();        // reports fall back to unclassified (R85)

    // Retrying puts the account right.
    await profileSvc.updateLocationProfile(u._id, PA, { is_filling_location: true });
    expect(await flaggedFor()).toEqual([PA]);
  });
});
