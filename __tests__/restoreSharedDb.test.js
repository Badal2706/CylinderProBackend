// F-20 / R161 — restoring ONE account inside a shared database.
//
// The restore precondition is about the target account only: it must hold no business data.
// Other accounts in the same database are irrelevant, and must come out of every step here
// byte-for-byte untouched. An account that has data is emptied first, as its own deliberate,
// gated step — never by the restore. And if a restored record's _id ever collides with another
// account's document, MongoDB refuses the insert (it never overwrites) and the restore rolls back.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-production';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { EJSON } = mongoose.mongo.BSON;

const User = require('../models/User');
const Customer = require('../models/Customer');
const Cylinder = require('../models/Cylinder');
const CylinderHistory = require('../models/CylinderHistory');
const LocationProfile = require('../models/LocationProfile');
const BusinessProfile = require('../models/BusinessProfile');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const AuditLog = require('../models/AuditLog');
const RestoreJob = require('../models/RestoreJob');
const TrustedPerson = require('../models/TrustedPerson');
const Licence = require('../models/Licence');
const backup = require('../services/backup.service');
const restore = require('../services/restore.service');
const masters = require('../services/masters.service');
const profileSvc = require('../services/profile.service');
const licenceSvc = require('../services/licence.service');
const billSvc = require('../services/bill.service');
const stepup = require('../services/stepup.service');
const N = require('../services/numbering.service');
const acct = require('../services/accountNumbering.service');
const { GAS_CAPACITIES } = require('../config/gasCapacities');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_shareddb_${Date.now()}`;
const TMP = path.join(os.tmpdir(), `shared-restore-test-${Date.now()}`);
const CH = 'AT_PLANT_CHANDISAR';
const DEFAULT_GASES = Object.keys(GAS_CAPACITIES).length;

let A, B, zipPath, aBefore, bBefore;

// ── helpers ──
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : (v && typeof v === 'object' && v._bsontype === undefined && !(v instanceof Date))
    ? Object.keys(v).sort().reduce((o, k) => (o[k] = sortKeys(v[k]), o), {}) : v;

// Every document of one account, collection by collection, as a content hash.
async function snapshotOf(userId) {
  const out = {};
  for (const spec of backup.COLLECTIONS) {
    const docs = await mongoose.connection.db.collection(spec.key).find({ user_id: userId }).sort({ _id: 1 }).toArray();
    out[spec.key] = `${docs.length}:` + crypto.createHash('sha256')
      .update(EJSON.stringify(sortKeys(EJSON.serialize(docs)), { relaxed: false })).digest('hex').slice(0, 16);
  }
  return out;
}

async function tenant(label) {
  const u = await User.create({ name: label, email: `${label}@shared.test`, password: 'Test1234!' });
  await User.collection.updateOne({ _id: u._id }, { $set: { account_code: N.deriveAccountCode(u._id) } });
  acct._clearCache();
  await masters.seedDefaultCatalog(u._id);
  await LocationProfile.create({ user_id: u._id, location: CH, label: `${label} Plant`, is_filling_location: true });
  await BusinessProfile.create({ user_id: u._id, business_name: `${label} Gases` });
  await TrustedPerson.create({ user_id: u._id, name: label, email: `${label}@shared.test`, is_bootstrap: true });
  const cust = await Customer.create({ user_id: u._id, company_name: `${label} Customer`, phone_primary: '9', holding_limit: 50 });
  await Cylinder.create({ user_id: u._id, rotational_number: `${label}-1`, gas_type: 'Oxygen', capacity: '7 m3',
    location: CH, stock_state: 'IN_STOCK' });
  await CylinderHistory.create({ user_id: u._id, cylinder_id: new mongoose.Types.ObjectId(), rotational_number: `${label}-1`,
    event_type: 'GIVEN', description: 'fixture', event_at: new Date('2026-06-15T10:00:00+05:30') });
  const gas = await GasType.findOne({ user_id: u._id, gas_type_name: 'Oxygen' }).lean();
  const size = await CylinderSize.findOne({ user_id: u._id, size_label: '7 m3' }).lean();
  for (let i = 0; i < 3; i++) {
    await billSvc.createBill(u._id, {
      customer_id: String(cust._id), bill_date: new Date('2026-06-15T10:00:00+05:30'), transaction_type: 'GIVEN',
      challan_no: `C${i}`, location: CH,
      given_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id), quantity: 0, rate: 100, personalCylindersIn: 1 }]
    });
  }
  return u;
}

async function exportTo(userId, file) {
  const out = fs.createWriteStream(file);
  out.setHeader = () => {}; out.attachment = () => {};
  await backup.exportBackup(userId, out);
  await new Promise(r => out.on('close', r));
}

async function restoreInto(userId, file) {
  const p = await restore.previewRestore(userId, fs.createReadStream(file));
  if (!p.can_restore) return { preview: p };
  const started = await restore.confirmRestore(userId, p.restore_token);
  let st;
  for (let i = 0; i < 400; i++) {
    st = await restore.getRestoreStatus(userId, started.job_id);
    if (['DONE', 'FAILED', 'ROLLBACK_FAILED'].includes(st.status)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  return { preview: p, status: st };
}

// A download through the page records BACKUP_TAKEN before streaming (profile.controller).
const recordBackupTaken = (userId, at = new Date()) => AuditLog.collection.insertOne({
  user_id: userId, action: 'BACKUP_TAKEN', target: 'Full account backup', detail: 'test', via: 'SESSION',
  person_id: null, person_name: '', createdAt: at, updatedAt: at });

beforeAll(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  await mongoose.connect(TEST_DB);
  await Promise.all([GasType.syncIndexes(), CylinderSize.syncIndexes(), User.syncIndexes(), Licence.syncIndexes(), RestoreJob.syncIndexes()]);

  A = await tenant('alpha');
  B = await tenant('beta');
  await licenceSvc.bindToExistingAccount({ email: 'alpha@shared.test', userId: A._id });

  // A's backup, exactly as the page takes it: the audit row first, then the archive.
  await recordBackupTaken(A._id);
  zipPath = path.join(TMP, 'alpha.zip');
  await exportTo(A._id, zipPath);
  aBefore = await snapshotOf(A._id);
  bBefore = await snapshotOf(B._id);
});
afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
afterEach(() => jest.restoreAllMocks());

describe('an account that has data is refused, and pointed at the purge step', () => {
  test('restore into a non-empty account: refused, needs_purge, and no way to force it', async () => {
    const { preview, status } = await restoreInto(A._id, zipPath);
    expect(status).toBeUndefined();
    expect(preview.can_restore).toBe(false);
    expect(preview.needs_purge).toBe(true);
    expect(preview.problems.join(' ')).toMatch(/already contains data/i);
    expect(preview.problems.join(' ')).toMatch(/Empty This Account/);
    await expect(restore.confirmRestore(A._id, preview.restore_token)).rejects.toThrow(/did not pass validation/i);
    // B's presence in the same database is NOT a reason to refuse any more
    expect(preview.problems.join(' ')).not.toMatch(/another account|own database/i);
  });
});

describe('emptying the account is its own gated step', () => {
  test('a wrong password is refused', async () => {
    await expect(profileSvc.emptyAccountForRestore(A._id, 'wrong', 'x')).rejects.toThrow(/Incorrect password/);
  });

  test('without an owner approval it is refused', async () => {
    await expect(profileSvc.emptyAccountForRestore(A._id, 'Test1234!', 'not-a-token')).rejects.toThrow(/Approval expired or invalid/);
  });

  test('without a backup taken in the last 30 minutes it is refused', async () => {
    jest.spyOn(stepup, 'requireOwnerStepUp').mockResolvedValue({ via: 'OTP', person_id: null, person_name: 'Owner' });
    const saved = await AuditLog.find({ user_id: A._id, action: 'BACKUP_TAKEN' }).lean();
    // native driver: Mongoose treats createdAt as immutable and would silently drop this (R112)
    await AuditLog.collection.updateMany({ user_id: A._id, action: 'BACKUP_TAKEN' }, { $set: { createdAt: new Date(Date.now() - 31 * 60 * 1000) } });
    try {
      await expect(profileSvc.emptyAccountForRestore(A._id, 'Test1234!', 'ok')).rejects.toThrow(/Download this account's backup first/);
    } finally {
      for (const d of saved) await AuditLog.collection.updateOne({ _id: d._id }, { $set: { createdAt: d.createdAt } });
    }
    expect(await snapshotOf(A._id)).toEqual(aBefore);   // nothing was touched by the refusals
  });

  test('while a restore into this account is running it is refused', async () => {
    jest.spyOn(stepup, 'requireOwnerStepUp').mockResolvedValue({ via: 'OTP', person_id: null, person_name: 'Owner' });
    const job = await RestoreJob.create({ user_id: A._id, status: 'RUNNING' });
    try {
      await expect(profileSvc.emptyAccountForRestore(A._id, 'Test1234!', 'ok')).rejects.toThrow(/restore into this account is running/i);
    } finally { await RestoreJob.deleteOne({ _id: job._id }); }
  });

  test('it removes every backed-up record of THIS account and nothing else', async () => {
    jest.spyOn(stepup, 'requireOwnerStepUp').mockResolvedValue({ via: 'OTP', person_id: null, person_name: 'Owner' });
    const res = await profileSvc.emptyAccountForRestore(A._id, 'Test1234!', 'ok');
    expect(res.removed.Bill).toBe(3);

    const after = await snapshotOf(A._id);
    for (const spec of backup.COLLECTIONS) {
      const n = Number(after[spec.key].split(':')[0]);
      const expected = { gastypes: DEFAULT_GASES, gascapacities: DEFAULT_GASES,
        cylindersizes: new Set(Object.values(GAS_CAPACITIES).flat()).size, auditlogs: 1 }[spec.key] || 0;
      expect([spec.key, n]).toEqual([spec.key, expected]);
    }
    // the purge is on record
    expect(await AuditLog.countDocuments({ user_id: A._id, action: 'ACCOUNT_PURGE' })).toBe(1);
    // login, trusted people and licence stay
    const user = await User.findById(A._id);
    expect(await user.comparePassword('Test1234!')).toBe(true);
    expect(await TrustedPerson.countDocuments({ user_id: A._id })).toBe(1);
    expect(String((await Licence.findOne({ email: 'alpha@shared.test' }).lean()).used_by)).toBe(String(A._id));
    // and B — in the same database — is byte-for-byte what it was
    expect(await snapshotOf(B._id)).toEqual(bBefore);
  });
});

describe('restoring ONE account while another has live data in the same database', () => {
  test('succeeds, brings A back byte-for-byte, and leaves B untouched', async () => {
    const { preview, status } = await restoreInto(A._id, zipPath);
    expect(preview.can_restore).toBe(true);
    expect(preview.problems).toEqual([]);
    expect(status.status).toBe('DONE');
    expect(status.mismatches).toEqual([]);

    expect(await snapshotOf(A._id)).toEqual(aBefore);   // A exactly as it was backed up
    expect(await snapshotOf(B._id)).toEqual(bBefore);   // B never touched
    expect((await User.findById(A._id).lean()).account_code).toBe(N.deriveAccountCode(A._id));
  });

  test('the new manifest records the source account id, for traceability only', async () => {
    const m = await backup.buildManifest(B._id);
    expect(m.account_id).toBe(String(B._id));
  });
});

describe('the realistic cross-tenant clash is refused before anything is written', () => {
  test('a backup whose account code another live account still uses', async () => {
    const C = await User.create({ name: 'C', email: 'c@shared.test', password: 'Test1234!' });
    await User.collection.updateOne({ _id: C._id }, { $set: { account_code: N.deriveAccountCode(C._id) } });
    await masters.seedDefaultCatalog(C._id);
    const cBefore = await snapshotOf(C._id);

    const { preview, status } = await restoreInto(C._id, zipPath);   // A's archive, A still exists
    expect(status).toBeUndefined();
    expect(preview.can_restore).toBe(false);
    expect(preview.problems.join(' ')).toMatch(/another account in this\s+database still uses \(alpha@shared\.test\)/);
    expect(await snapshotOf(C._id)).toEqual(cBefore);
    expect(await snapshotOf(A._id)).toEqual(aBefore);
  });
});

describe('an _id that collides with another account\'s document: refused by MongoDB, never overwritten', () => {
  test('the restore fails loudly, the other account keeps its document, and the target rolls back', async () => {
    // Build the collision: one of A's customers now belongs to B under the SAME _id, and A is gone
    // (so its account code is free and nothing refuses up front). Restoring A's archive must then
    // try to insert an _id that B already holds.
    const aCust = await Customer.findOne({ user_id: A._id }).lean();
    await profileSvc.purgeAccountData(A._id);
    await User.deleteOne({ _id: A._id });
    await Customer.collection.insertOne({ ...aCust, user_id: B._id, company_name: 'B owns this now' });
    const bHeld = await Customer.findById(aCust._id).lean();

    const D = await User.create({ name: 'D', email: 'd@shared.test', password: 'Test1234!' });
    await User.collection.updateOne({ _id: D._id }, { $set: { account_code: N.deriveAccountCode(D._id) } });
    await masters.seedDefaultCatalog(D._id);

    const { preview, status } = await restoreInto(D._id, zipPath);
    expect(preview.can_restore).toBe(true);           // nothing up front could know
    expect(status.status).toBe('FAILED');
    expect(status.error).toMatch(/already exists in this database under the same internal id \(while writing customers\)/);
    expect(status.error).toMatch(/nothing of theirs was touched/);
    expect(status.error).toMatch(/E11000 duplicate key/);   // the database's own refusal, kept for support

    // B's document is exactly as it was — MongoDB refused the insert, it did not overwrite
    expect(await Customer.findById(aCust._id).lean()).toEqual(bHeld);
    // D rolled back to a fresh signup: no business data, the default catalog, nothing of A's
    expect(await Customer.countDocuments({ user_id: D._id })).toBe(0);
    expect(await GasType.countDocuments({ user_id: D._id })).toBe(DEFAULT_GASES);
    expect(await RestoreJob.countDocuments({ lock_key: 'RESTORE' })).toBe(0);
  });
});
