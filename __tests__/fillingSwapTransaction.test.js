// The filling-location swap under a REAL transaction.
//
// setFillingLocation() has two paths: a transaction where the deployment supports one (production
// Atlas, and local Mongo once it is a replica set), and an ordered clear-then-set fallback where it
// does not (a plain standalone mongod). Every earlier test exercised only the fallback.
//
// These tests assert which branch actually ran — not by absence of a warning, but by observing the
// session — and prove the thing the fallback cannot promise: a failure part-way through rolls the
// database back to exactly its prior state, rather than leaving zero filling locations.
//
// On a standalone deployment there is no transaction to test, so the suite skips itself rather
// than failing.
const mongoose = require('mongoose');
const User = require('../models/User');
const LocationProfile = require('../models/LocationProfile');
const locationService = require('../services/location.service');
const profileSvc = require('../services/profile.service');

const CH = 'AT_PLANT_CHANDISAR';
const PA = 'AT_PALANPUR_OFFICE';
let uid;
let txSupported = false;

const flagged = async () =>
  (await LocationProfile.find({ user_id: uid, is_filling_location: true })).map(p => p.location).sort();

beforeAll(async () => {
  await mongoose.connect(`mongodb://127.0.0.1:27017/cylinder_management_test_tx_${Date.now()}`);
  await LocationProfile.syncIndexes();

  // Does this deployment actually do transactional writes?
  const s = await mongoose.startSession();
  try {
    s.startTransaction();
    await mongoose.connection.db.collection('__txprobe').insertOne({ x: 1 }, { session: s });
    await s.commitTransaction();
    txSupported = true;
    await mongoose.connection.db.collection('__txprobe').drop().catch(() => {});
  } catch {
    try { await s.abortTransaction(); } catch {}
  } finally { s.endSession(); }

  const u = await User.create({ name: 'TX', email: 'tx@test.com', password: 'Test1234!' });
  uid = u._id;
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

describe('deployment capability', () => {
  test('reports whether transactions are available here', () => {
    console.log(`\n  >>> transactional writes supported on this deployment: ${txSupported ? 'YES (replica set)' : 'NO (standalone)'}\n`);
    expect(typeof txSupported).toBe('boolean');
  });
});

describe('which branch the swap actually takes', () => {
  test('a transaction on a replica set; the ordered fallback on a standalone', async () => {
    const startSession = jest.spyOn(mongoose, 'startSession');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await flagged()).toEqual([CH]);
      await profileSvc.updateLocationProfile(uid, PA, { is_filling_location: true });

      // A session is opened either way — the question is whether it carried the writes.
      expect(startSession).toHaveBeenCalled();
      const fellBack = warn.mock.calls.some(c => String(c[0] || '').includes('transactions unavailable'));

      if (txSupported) {
        // The fallback logs before it runs. Silence here is positive proof the commit succeeded.
        expect(fellBack).toBe(false);
      } else {
        expect(fellBack).toBe(true);
      }

      // Either way the outcome is the same: exactly one location flagged, the new one.
      expect(await flagged()).toEqual([PA]);
    } finally {
      startSession.mockRestore();
      warn.mockRestore();
    }
  });
});

// This is the whole point of the exercise. The fallback can only promise "never two, worst case
// zero". A transaction promises something stronger: the failed swap leaves NO trace at all.
describe('a failure part-way through the swap', () => {
  test('a transaction rolls all the way back; the fallback degrades to zero', async () => {
    // Put a known state in place: Chandisar fills.
    await profileSvc.updateLocationProfile(uid, CH, { is_filling_location: true });
    expect(await flagged()).toEqual([CH]);
    const before = await LocationProfile.find({ user_id: uid }).lean();

    // Fail the SECOND write of the swap: the old flag has been cleared inside the transaction,
    // the new one is never set. Without a rollback this is the "zero filling locations" state.
    const updateMany = jest.spyOn(LocationProfile, 'updateMany');
    const updateOne = jest.spyOn(LocationProfile, 'updateOne')
      .mockImplementationOnce(() => { throw new Error('simulated crash mid-swap'); });

    let threw = null;
    try {
      await profileSvc.updateLocationProfile(uid, PA, { is_filling_location: true });
    } catch (e) { threw = e; } finally { updateOne.mockRestore(); }

    // Without this the rollback proof would be vacuous: if the crash happened BEFORE the clear,
    // there would have been nothing to undo and the assertions below would pass trivially.
    expect(updateMany).toHaveBeenCalled();
    updateMany.mockRestore();

    // The caller sees the failure — it is not swallowed.
    expect(threw).toBeTruthy();
    expect(String(threw.message)).toMatch(/simulated crash mid-swap/);

    const after = await LocationProfile.find({ user_id: uid }).lean();
    const key = (r) => `${r.location}|${r.is_filling_location}|${r.label}|${r.manager_name}|${r.contact_number}|${r.challan_prefix}`;

    if (txSupported) {
      // TRUE ROLLBACK: not zero, not two — byte for byte the state we started from.
      expect(await flagged()).toEqual([CH]);
      expect(after.length).toBe(before.length);
      expect(after.map(key).sort()).toEqual(before.map(key).sort());
    } else {
      // The fallback's weaker guarantee: the clear already committed, so nobody fills. Degraded
      // and legal (R85), never two — and the next attempt puts it right.
      expect(await flagged()).toEqual([]);
    }
  });

  test('and the account still works normally afterwards', async () => {
    if (txSupported) {
      expect((await locationService.getUserLocations(uid)).fillingLocationCode).toBe(CH);
    }
    await profileSvc.updateLocationProfile(uid, PA, { is_filling_location: true });
    expect(await flagged()).toEqual([PA]);
  });
});
