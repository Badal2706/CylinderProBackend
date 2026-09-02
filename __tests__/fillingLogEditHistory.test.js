// Editing a saved Filling List must not manufacture history.
//
// The reported scenario, exactly:
//   Morning : save [1, 2, 3]
//   Evening : edit the same day to [4, 5, 1]
//
// Two rules are under test.
//   · A serial REMOVED by the edit gets nothing from a save it is no longer part of.
//   · A serial that SURVIVES the edit is logged ONCE for that day, not once per save — the
//     cylinder was filled once and the typing was corrected, which is not the same event twice.
//
// Plus the location check: a serial that is not standing at the filling site produces a warning
// naming it and where it actually is, and the save still succeeds (R33 — the list is a log, and
// must never be gated on the software's own picture of where a cylinder is).
const mongoose = require('mongoose');

const DB = 'mongodb://127.0.0.1:27017/cylinder_management_test_fillhist_' + Date.now();

let User, Cylinder, LocationProfile, CylinderHistory, FillingLogEntry, fillingLog;
let uid;
const DAY = '2026-08-20';
const OTHER_DAY = '2026-08-21';
const FILLING = 'AT_MAIN_PLANT';
const DEPOT = 'AT_DEPOT';

const ent = (n) => ({ rotational_number: n, gas_type: 'Oxygen', capacity: '7 m3' });

async function filledCount(rot, date) {
  const q = { user_id: uid, event_type: 'FILLED', rotational_number: rot };
  if (date) {
    const { istDayRange } = require('../utils/istDay');
    const { start, end } = istDayRange(date);
    q.event_at = { $gte: start, $lte: end };
  }
  return CylinderHistory.countDocuments(q);
}

beforeAll(async () => {
  process.env.MONGODB_URI = DB;
  await mongoose.connect(DB);
  User = require('../models/User');
  Cylinder = require('../models/Cylinder');
  LocationProfile = require('../models/LocationProfile');
  CylinderHistory = require('../models/CylinderHistory');
  FillingLogEntry = require('../models/FillingLogEntry');
  fillingLog = require('../services/fillingLog.service');

  const u = await User.create({ name: 'Fill', email: 'fill@example.invalid', password: 'x' });
  uid = u._id;
  await LocationProfile.create({ user_id: uid, location: FILLING, label: 'Main Plant',
    is_filling_location: true, is_maintenance_location: true });
  await LocationProfile.create({ user_id: uid, location: DEPOT, label: 'Depot' });

  for (const n of ['1', '2', '3', '4']) {
    await Cylinder.create({ user_id: uid, rotational_number: n, gas_type: 'Oxygen',
      capacity: '7 m3', location: FILLING, stock_state: 'IN_STOCK' });
  }
  // 5 is at the other site; 6 is out with a customer. Both exercise the location warning.
  await Cylinder.create({ user_id: uid, rotational_number: '5', gas_type: 'Oxygen',
    capacity: '7 m3', location: DEPOT, stock_state: 'IN_STOCK' });
  await Cylinder.create({ user_id: uid, rotational_number: '6', gas_type: 'Oxygen',
    capacity: '7 m3', location: FILLING, stock_state: 'AT_CUSTOMER' });
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

describe('Filling List edit — history is not duplicated', () => {
  test('the morning save logs each serial once', async () => {
    await fillingLog.saveDay(uid, { date: DAY, entries: [ent('1'), ent('2'), ent('3')] });
    expect(await filledCount('1', DAY)).toBe(1);
    expect(await filledCount('2', DAY)).toBe(1);
    expect(await filledCount('3', DAY)).toBe(1);
  });

  test('the evening edit leaves REMOVED serials with exactly one entry', async () => {
    await fillingLog.saveDay(uid, { date: DAY, entries: [ent('4'), ent('5'), ent('1')] });
    // 2 and 3 are no longer on the list at all — the edit must not have touched them.
    expect(await filledCount('2', DAY)).toBe(1);
    expect(await filledCount('3', DAY)).toBe(1);
  });

  test('a serial that SURVIVES the edit is still logged only once for that day', async () => {
    expect(await filledCount('1', DAY)).toBe(1);
  });

  test('serials ADDED by the edit are logged', async () => {
    expect(await filledCount('4', DAY)).toBe(1);
    expect(await filledCount('5', DAY)).toBe(1);
  });

  test('re-saving an unchanged list adds nothing at all', async () => {
    const before = await CylinderHistory.countDocuments({ user_id: uid, event_type: 'FILLED' });
    await fillingLog.saveDay(uid, { date: DAY, entries: [ent('4'), ent('5'), ent('1')] });
    await fillingLog.saveDay(uid, { date: DAY, entries: [ent('4'), ent('5'), ent('1')] });
    expect(await CylinderHistory.countDocuments({ user_id: uid, event_type: 'FILLED' })).toBe(before);
  });

  test('the same serial filled on a DIFFERENT day is logged again', async () => {
    await fillingLog.saveDay(uid, { date: OTHER_DAY, entries: [ent('1')] });
    expect(await filledCount('1', OTHER_DAY)).toBe(1);
    expect(await filledCount('1')).toBe(2);          // one per day, two days
  });

  test('the day’s log rows still reflect the last save exactly', async () => {
    const rows = await FillingLogEntry.find({ user_id: uid, date: DAY }).lean();
    expect(rows.map(r => r.rotational_number).sort()).toEqual(['1', '4', '5']);
  });
});

describe('Filling List location check', () => {
  test('warns for a serial at another site, and still saves', async () => {
    const res = await fillingLog.saveDay(uid, { date: '2026-08-22', entries: [ent('1'), ent('5')] });
    expect(res.entries.length).toBe(2);                       // saved regardless — R33
    const w = res.warnings.find(x => x.rotational_number === '5');
    expect(w).toBeTruthy();
    expect(w.message).toContain('5');
    expect(w.message).toContain('Depot');                     // names where it actually is
    expect(w.message).toContain('Main Plant');                // and where it should be
  });

  test('warns for a serial out with a customer', async () => {
    const res = await fillingLog.saveDay(uid, { date: '2026-08-23', entries: [ent('6')] });
    const w = res.warnings.find(x => x.rotational_number === '6');
    expect(w).toBeTruthy();
    expect(w.message).toMatch(/out with a customer/i);
  });

  test('no warning when everything is at the filling site', async () => {
    const res = await fillingLog.saveDay(uid, { date: '2026-08-24', entries: [ent('1'), ent('4')] });
    expect(res.warnings).toEqual([]);
  });

  test('the check never blocks: warned entries are still stored', async () => {
    const rows = await FillingLogEntry.find({ user_id: uid, date: '2026-08-22' }).lean();
    expect(rows.map(r => r.rotational_number).sort()).toEqual(['1', '5']);
  });
});
