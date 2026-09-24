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
  await GasType.findOne({ user_id: uid, gas_type_name: 'Oxygen' }) || await GasType.create({ user_id: uid, gas_type_name: 'Oxygen', is_active: true });
  await CylinderSize.findOne({ user_id: uid, size_label: '7 m3' }) || await CylinderSize.create({ user_id: uid, size_label: '7 m3', is_active: true });
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
  // The type-edit gate is the one that is still anchored to the filling site — re-designating a
  // cylinder's gas or size is a plant job. It replaced the maintenance toggle as this assertion's
  // subject when maintenance was opened up to every site (see the maintenance describe below).
  test('the gas/size edit gate is allowed at the filling location and refused elsewhere', async () => {
    const a = await cylSvc.createCylinder(uid, {
      rotational_number: 'B1-M1', gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK'
    });
    await expect(cylSvc.updateCylinder(uid, String(a.cylinder_id), { capacity: '10 m3' }))
      .resolves.toBeDefined();

    const b = await cylSvc.createCylinder(uid, {
      rotational_number: 'B1-M2', gas_type: 'Oxygen', capacity: '7 m3', location: PA, stock_state: 'IN_STOCK'
    });
    await expect(cylSvc.updateCylinder(uid, String(b.cylinder_id), { capacity: '10 m3' }))
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

// Maintenance happens at ONE designated site: the workshop (LocationProfile.is_maintenance_location),
// chosen per account exactly like the filling site and independent of it.
//
// It must never MOVE a cylinder. Under-maintenance cylinders are still IN_STOCK, so they sit in
// their site's Stock Summary anchor; relocating one on flag would shift stock between two sites
// with no movement in either ledger — the exact shape of the negative-balance bugs fixed as
// R136/R137. Requiring the cylinder to already BE at the workshop means the journey there is a
// real, documented transfer, and maintenance itself stays outside the ledgers entirely.
describe('maintenance is gated on the designated workshop', () => {
  beforeAll(async () => {
    // CH fills; make PA the workshop, to prove the two designations are independent.
    await LocationProfile.updateOne({ user_id: uid, location: PA }, { $set: { is_maintenance_location: true } });
  });

  test('the registry reports both designations separately', async () => {
    const r = await locationService.getUserLocations(uid);
    expect(r.fillingLocationCode).toBe(CH);
    expect(r.maintenanceLocationCode).toBe(PA);
  });

  test('a cylinder standing at the workshop can be flagged', async () => {
    const c = await cylSvc.createCylinder(uid, {
      rotational_number: 'B1-MT1', gas_type: 'Oxygen', capacity: '7 m3', location: PA, stock_state: 'IN_STOCK'
    });
    await expect(cylSvc.setMaintenance(uid, String(c.cylinder_id), true)).resolves.toBeDefined();
  });

  test('flagging does NOT move it', async () => {
    const c = await Cylinder.findOne({ user_id: uid, rotational_number: 'B1-MT1' }).lean();
    expect(c.location).toBe(PA);
    expect(c.stock_state).toBe('IN_STOCK');
    expect(c.under_maintenance).toBe(true);
  });

  test('a cylinder anywhere else is refused, and told where to send it', async () => {
    const c = await cylSvc.createCylinder(uid, {
      rotational_number: 'B1-MT2', gas_type: 'Oxygen', capacity: '7 m3', location: CH, stock_state: 'IN_STOCK'
    });
    const err = await cylSvc.setMaintenance(uid, String(c.cylinder_id), true).catch(e => e);
    expect(err.message).toMatch(/serviced at Palanpur Office/);
    expect(err.message).toMatch(/transfer it/i);
  });

  test('the DESTINATION named is the workshop, not the filling site', async () => {
    // The message mentions both sites, and should: where it is now, and where it has to go. What
    // must not happen is the old behaviour, where the filling site was named as the destination.
    const c = await Cylinder.findOne({ user_id: uid, rotational_number: 'B1-MT2' }).lean();
    const err = await cylSvc.setMaintenance(uid, String(c._id), true).catch(e => e);
    expect(err.message).toMatch(/serviced at Palanpur Office/);
    expect(err.message).toMatch(/transfer it to Palanpur Office/);
    expect(err.message).not.toMatch(/serviced at Chandisar Plant/);
    expect(err.message).not.toMatch(/transfer it to Chandisar Plant/);
  });

  test('a cylinder out with a customer is refused even at the workshop', async () => {
    const c = await cylSvc.createCylinder(uid, {
      rotational_number: 'B1-MT3', gas_type: 'Oxygen', capacity: '7 m3', location: PA, stock_state: 'AT_CUSTOMER'
    });
    await expect(cylSvc.setMaintenance(uid, String(c.cylinder_id), true))
      .rejects.toThrow(/out with a customer/i);
  });

  test('the edit form obeys the same rule — it used to bypass it entirely', async () => {
    // updateCylinder accepted `under_maintenance` as a plain field with no gate, so the edit form
    // could flag a cylinder anywhere while the dedicated endpoint refused.
    const c = await Cylinder.findOne({ user_id: uid, rotational_number: 'B1-MT2' }).lean();
    await expect(cylSvc.updateCylinder(uid, String(c._id), { under_maintenance: true }))
      .rejects.toThrow(/serviced at Palanpur Office/);
  });

  test('returning to service is never gated, and leaves it where it is', async () => {
    const c = await Cylinder.findOne({ user_id: uid, rotational_number: 'B1-MT1' }).lean();
    await cylSvc.setMaintenance(uid, String(c._id), false);
    const after = await Cylinder.findOne({ user_id: uid, rotational_number: 'B1-MT1' }).lean();
    expect(after.under_maintenance).toBe(false);
    expect(after.location).toBe(PA);
    expect(after.maintenance_since).toBeNull();
  });

  test('at most one workshop per account, enforced by the database', async () => {
    await expect(
      LocationProfile.updateOne({ user_id: uid, location: CH }, { $set: { is_maintenance_location: true } })
    ).rejects.toMatchObject({ code: 11000 });
  });
});
