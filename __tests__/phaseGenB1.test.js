// Phase GEN-B1 — the location registry.
//
// These lock in the guarantees that used to be provided by schema enums and by the literal
// 'AT_PLANT_CHANDISAR' scattered through five services. The enum removals are only safe because
// of the service-layer checks asserted here; if one of these ever goes green-to-red, a location
// string can reach the database unvalidated.
const mongoose = require('mongoose');
const User = require('../models/User');
const Cylinder = require('../models/Cylinder');
const LocationProfile = require('../models/LocationProfile');
const CylinderHistory = require('../models/CylinderHistory');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const locationService = require('../services/location.service');
const cylSvc = require('../services/cylinder.service');
const fillSvc = require('../services/fillingLog.service');
const profileSvc = require('../services/profile.service');

const CH = 'AT_PLANT_CHANDISAR';
const PA = 'AT_PALANPUR_OFFICE';
let uid;

beforeAll(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/cylinder_management_test_genb1_${Date.now()}`);
  // The partial unique index does NOT exist just because the model does — an existing database
  // only gains it when indexes are synced, which is why the GEN-B1 migration calls syncIndexes().
  await LocationProfile.syncIndexes();
  const user = await User.create({ name: 'B1', email: 'b1@test.com', password: 'Test1234!' });
  uid = user._id;
  await LocationProfile.create([
    { user_id: uid, location: CH, label: 'Chandisar Plant', manager_name: 'Raju', is_filling_location: true },
    { user_id: uid, location: PA, label: 'Palanpur Office', manager_name: 'Manish' }
  ]);
  await GasType.findOne({ gas_type_name: 'Oxygen' }) || await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
  await CylinderSize.findOne({ size_label: '7 m3' }) || await CylinderSize.create({ size_label: '7 m3', is_active: true });
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe('the registry answers what the config array used to', () => {
  test('codes, labels and the filling location come from the records', async () => {
    const r = await locationService.getUserLocations(uid);
    expect(r.codes).toEqual([CH, PA]);
    expect(r.labels[CH]).toBe('Chandisar Plant');
    expect(r.fillingLocationCode).toBe(CH);
    expect(await locationService.isFillingLocation(uid, CH)).toBe(true);
    expect(await locationService.isFillingLocation(uid, PA)).toBe(false);
    expect(await locationService.isValidLocation(uid, 'AT_NOWHERE')).toBe(false);
  });

  test('at most one filling location, enforced by the database', async () => {
    await expect(
      LocationProfile.updateOne({ user_id: uid, location: PA }, { $set: { is_filling_location: true } })
    ).rejects.toMatchObject({ code: 11000 });
    const flagged = await LocationProfile.find({ user_id: uid, is_filling_location: true });
    expect(flagged.map(f => f.location)).toEqual([CH]);
  });

  test('a location code is immutable once created', async () => {
    const p = await LocationProfile.findOne({ user_id: uid, location: PA });
    p.location = 'AT_SOMEWHERE_ELSE';
    await p.save();
    const after = await LocationProfile.findById(p._id);
    expect(after.location).toBe(PA);
  });
});

// The enum used to reject these. With it gone, only the service layer stands in the way.
describe('unknown locations are still rejected (the enum-removal regression)', () => {
  test('createCylinder refuses a location that is not in the registry', async () => {
    await expect(cylSvc.createCylinder(uid, {
      rotational_number: 'B1-X', gas_type: 'Oxygen', capacity: '7 m3', location: 'AT_ATLANTIS'
    })).rejects.toThrow(/Unknown location/);
  });

  test('updateCylinder refuses a location that is not in the registry', async () => {
    const { cylinder_id } = await cylSvc.createCylinder(uid, {
      rotational_number: 'B1-1', gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK'
    });
    await expect(cylSvc.updateCylinder(uid, String(cylinder_id), { location: 'AT_ATLANTIS' }))
      .rejects.toThrow(/Unknown location/);
    const still = await Cylinder.findById(cylinder_id).lean();
    expect(still.location).toBe(CH);
  });

  test('setActiveLocation refuses one too', async () => {
    await expect(profileSvc.setActiveLocation(uid, 'AT_ATLANTIS')).rejects.toThrow(/Unknown location/);
  });
});

describe('the anchor follows the registry, not a hardcoded site', () => {
  test('maintenance is allowed at the filling location and refused elsewhere', async () => {
    const a = await cylSvc.createCylinder(uid, {
      rotational_number: 'B1-M1', gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK'
    });
    await expect(cylSvc.setMaintenance(uid, String(a.cylinder_id), true)).resolves.toBeDefined();

    const b = await cylSvc.createCylinder(uid, {
      rotational_number: 'B1-M2', gas_type: 'Oxygen', capacity: '7 m3', location: PA, stock_state: 'IN_STOCK'
    });
    await expect(cylSvc.setMaintenance(uid, String(b.cylinder_id), true))
      .rejects.toThrow(/Chandisar Plant/);   // the resolved label, not a hardcoded string
  });

  test('a fill is recorded at the filling location, using its label', async () => {
    await cylSvc.createCylinder(uid, {
      rotational_number: 'B1-F1', gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK'
    });
    await fillSvc.saveDay(uid, { date: '2026-08-17', entries: [{ rotational_number: 'B1-F1' }] });
    const fills = await CylinderHistory.find({ user_id: uid, event_type: 'FILLED' }).lean();
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0].performed_at_location).toBe(CH);
    expect(fills[0].description).toBe('Filled at Chandisar Plant on 2026-08-17');
  });
});

describe('friendly location spellings still resolve', () => {
  test.each([
    ['chandisar plant', CH],
    ['CHANDISAR', CH],
    ['Palanpur Office', PA],
    ['palanpur', PA],
    ['AT_PLANT_CHANDISAR', CH],
    ['nowhere at all', null]
  ])('%s -> %s', async (input, expected) => {
    const reg = await locationService.getUserLocations(uid);
    expect(cylSvc.matchLocation(reg, input)).toBe(expected);
  });
});

// The spec requires this state to be supported, not crash: a user may legitimately have no site
// that fills, in which case every transfer stays unclassified.
describe('a user with NO filling location', () => {
  let uid2;
  beforeAll(async () => {
    const u = await User.create({ name: 'NoFill', email: 'nofill@test.com', password: 'Test1234!' });
    uid2 = u._id;
    await LocationProfile.create([
      { user_id: uid2, location: PA, label: 'Palanpur Office', is_filling_location: false },
      { user_id: uid2, location: 'AT_CHHAPI_OFFICE', label: 'Chhapi Office', is_filling_location: false }
    ]);
  });

  test('resolves to null rather than falling back to a hardcoded site', async () => {
    const r = await locationService.getUserLocations(uid2);
    expect(r.fillingLocationCode).toBeNull();
    expect(await locationService.isFillingLocation(uid2, PA)).toBe(false);
  });

  test('reports still generate, with every transfer unclassified', async () => {
    const reportSvc = require('../services/report.service');
    const dsr = await reportSvc.getDSR(uid2, { date: '2026-08-17', location: PA });
    expect(dsr).toBeDefined();
    (dsr.rows || []).filter(r => r.transfer_direction)
      .forEach(r => expect(r.transfer_direction).toBe('REVIEW'));
    const stock = await reportSvc.getStockSummary(uid2, { date: '2026-08-17', location: PA });
    expect(stock.filled_add_label).toMatch(/the filling location/);
  });
});
