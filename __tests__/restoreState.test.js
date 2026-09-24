// R162 — the account's restore_state: none | empty_pending_restore | restore_in_progress.
//
// Empty This Account moves an account to empty_pending_restore; a restore that starts writing
// moves it to restore_in_progress and back to none when it finishes. While the state is not none,
// business writes are refused (creation in both states, every change while a restore is writing).
// A restore that dies mid-write leaves restore_in_progress with no job running any more, and
// Settings offers two ways out — both purge the account in full first, gated exactly like Empty
// This Account. A fresh signup that never emptied anything is never touched by any of it.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-production';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { EJSON } = mongoose.mongo.BSON;

const User = require('../models/User');
const Customer = require('../models/Customer');
const Cylinder = require('../models/Cylinder');
const LocationProfile = require('../models/LocationProfile');
const BusinessProfile = require('../models/BusinessProfile');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const AuditLog = require('../models/AuditLog');
const RestoreJob = require('../models/RestoreJob');
const TrustedPerson = require('../models/TrustedPerson');
const backup = require('../services/backup.service');
const restore = require('../services/restore.service');
const masters = require('../services/masters.service');
const profileSvc = require('../services/profile.service');
const billSvc = require('../services/bill.service');
const stepup = require('../services/stepup.service');
const N = require('../services/numbering.service');
const acct = require('../services/accountNumbering.service');
const { GAS_CAPACITIES } = require('../config/gasCapacities');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_restorestate_${Date.now()}`;
const TMP = path.join(os.tmpdir(), `restore-state-test-${Date.now()}`);
const CH = 'AT_PLANT_CHANDISAR';
const DEFAULT_GASES = Object.keys(GAS_CAPACITIES).length;
const DEFAULT_SIZES = new Set(Object.values(GAS_CAPACITIES).flat()).size;
const PW = 'Test1234!';

let A, B, zipPath, aArchived, bBefore, server, base;

// ── helpers ──
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : (v && typeof v === 'object' && v._bsontype === undefined && !(v instanceof Date))
    ? Object.keys(v).sort().reduce((o, k) => (o[k] = sortKeys(v[k]), o), {}) : v;

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
  const u = await User.create({ name: label, email: `${label}@state.test`, password: PW });
  await User.collection.updateOne({ _id: u._id }, { $set: { account_code: N.deriveAccountCode(u._id) } });
  acct._clearCache();
  await masters.seedDefaultCatalog(u._id);
  await LocationProfile.create({ user_id: u._id, location: CH, label: `${label} Plant`, is_filling_location: true });
  await BusinessProfile.create({ user_id: u._id, business_name: `${label} Gases` });
  await TrustedPerson.create({ user_id: u._id, name: label, email: `${label}@state.test`, is_bootstrap: true });
  const cust = await Customer.create({ user_id: u._id, company_name: `${label} Customer`, phone_primary: '9', holding_limit: 50 });
  await Cylinder.create({ user_id: u._id, rotational_number: `${label}-1`, gas_type: 'Oxygen', capacity: '7 m3',
    location: CH, stock_state: 'IN_STOCK' });
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
  return { preview: p, status: st, jobId: started.job_id };
}

// A backup of an account that no longer exists — so its account code is free and it can be
// restored into any empty account (as in a disaster recovery onto a fresh signup).
async function orphanZip(label) {
  const G = await tenant(label);
  const file = path.join(TMP, `${label}.zip`);
  await exportTo(G._id, file);
  await profileSvc.purgeAccountData(G._id);
  await User.deleteOne({ _id: G._id });
  return file;
}

const recordBackupTaken = (userId) => AuditLog.collection.insertOne({
  user_id: userId, action: 'BACKUP_TAKEN', target: 'Full account backup', detail: 'test', via: 'SESSION',
  person_id: null, person_name: '', createdAt: new Date(), updatedAt: new Date() });

const ownerApproves = () =>
  jest.spyOn(stepup, 'requireOwnerStepUp').mockResolvedValue({ via: 'OTP', person_id: null, person_name: 'Owner' });

const stateOf = async (userId) => (await User.findById(userId).select('restore_state').lean()).restore_state;
const setState = (userId, s) => User.updateOne({ _id: userId }, { $set: { restore_state: s } });

// A restore that died mid-write: part of the backup is in, the job still says RUNNING with a
// heartbeat that stopped a while ago, it still holds the lock, and the account says in progress.
async function simulateCrash(userId, { heartbeatAgoMs = 10 * 60 * 1000 } = {}) {
  await profileSvc.purgeAccountData(userId);
  const r = await restoreInto(userId, zipPath);              // a real restore writes the data…
  expect(r.status.status).toBe('DONE');
  await Customer.deleteMany({ user_id: userId });            // …and a crash leaves only part of it
  await setState(userId, 'restore_in_progress');
  const at = new Date(Date.now() - heartbeatAgoMs);
  return RestoreJob.create({ user_id: userId, status: 'RUNNING', lock_key: 'RESTORE',
    started_at: at, heartbeat_at: at });
}

// ── the real routers behind a throwaway app, so the gate is tested as the browser meets it ──
const token = (u) => jwt.sign({ id: u._id, name: u.name, email: u.email, tv: 0 }, process.env.JWT_SECRET, { expiresIn: 600 });
async function call(u, method, url, body) {
  const r = await fetch(base + url, {
    method, headers: { Authorization: `Bearer ${token(u)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const gated = (r) => r.status === 409 && r.json && r.json.code === 'RESTORE_STATE';

beforeAll(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  await mongoose.connect(TEST_DB);
  await Promise.all([GasType.syncIndexes(), CylinderSize.syncIndexes(), User.syncIndexes(), RestoreJob.syncIndexes(),
    LocationProfile.syncIndexes()]);

  A = await tenant('alpha');
  B = await tenant('beta');
  await recordBackupTaken(A._id);
  zipPath = path.join(TMP, 'alpha.zip');
  await exportTo(A._id, zipPath);
  aArchived = await snapshotOf(A._id);
  bBefore = await snapshotOf(B._id);

  const app = express();
  app.use(express.json());
  app.use('/api/customers', require('../routes/customers'));
  app.use('/api/bills', require('../routes/bills'));
  app.use('/api/payments', require('../routes/payments'));
  app.use('/api/cylinders', require('../routes/cylinders'));
  app.use('/api/masters', require('../routes/masters'));
  app.use('/api/profile', require('../routes/profile'));
  app.use('/api/filling-log', require('../routes/fillingLog'));
  app.use('/api/trusted-people', require('../routes/trustedPeople'));
  app.use('/api/step-up', require('../routes/stepup'));
  app.use('/api/purity-certificates', require('../routes/purityCertificates'));
  app.use((err, req, res, next) => { if (!err.status) console.error(err.stack); res.status(err.status || 500).json({ error: err.message }); });
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(r => server.close(r));
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await RestoreJob.updateMany({ lock_key: 'RESTORE' }, { $unset: { lock_key: '' } });
});

// Every business-record creation route, as the browser calls it.
const CREATES = (custId) => [
  ['POST', '/api/customers', { company_name: 'New Co', phone_primary: '9' }],
  ['POST', '/api/customers/import', { rows: [] }],
  ['POST', `/api/customers/${custId}/rental-summary`, {}],
  ['POST', '/api/cylinders', { rotational_number: 'X1', gas_type: 'Oxygen', capacity: '7 m3' }],
  ['POST', '/api/cylinders/import', { rows: [] }],
  ['POST', '/api/bills', {}],
  ['POST', '/api/bills/drafts', {}],
  ['POST', '/api/payments', {}],
  ['POST', '/api/purity-certificates', {}],
  ['POST', '/api/filling-log', {}],
  ['PUT', '/api/filling-log', {}]
];
// Changes that are fine while merely waiting for a restore, and refused while one writes.
const CHANGES = (custId) => [
  ['PUT', `/api/customers/${custId}`, { company_name: 'Renamed' }],
  ['PATCH', `/api/customers/${custId}/hidden`, { hidden: true }],
  ['DELETE', `/api/customers/${custId}`],
  ['PUT', '/api/cylinders/000000000000000000000000', {}],
  ['DELETE', '/api/bills/000000000000000000000000'],
  ['PUT', '/api/payments/000000000000000000000000', {}],
  ['POST', '/api/masters/gas-types', { gas_type_name: 'Xenon' }],
  ['POST', '/api/trusted-people', { name: 'X', email: 'x@x.test' }],
  ['PUT', '/api/profile/business', {}],
  ['POST', '/api/profile/locations', {}],
  ['POST', '/api/profile/empty-account', {}],
  ['POST', '/api/profile/restore/confirm', {}],
  ['DELETE', '/api/profile/delete-account', {}],
  ['GET', '/api/profile/backup']
];

describe('a fresh signup that never emptied anything is never touched', () => {
  test('a new account starts at none and every write works', async () => {
    const F = await User.create({ name: 'fresh', email: 'fresh@state.test', password: PW });
    expect(await stateOf(F._id)).toBe('none');
    const r = await call(F, 'POST', '/api/customers', { company_name: 'Fresh Co', phone_primary: '9' });
    expect(r.status).toBe(200);
    expect(await Customer.countDocuments({ user_id: F._id })).toBe(1);
    const s = await restore.getRestoreState(F._id);
    expect(s).toMatchObject({ restore_state: 'none', unfinished: false, running_job_id: null, last_job: null });
  });

  test('an account created before R162 (no field at all) reads as none and is not gated', async () => {
    const O = await User.create({ name: 'old', email: 'old@state.test', password: PW });
    await User.collection.updateOne({ _id: O._id }, { $unset: { restore_state: '' } });
    expect((await User.collection.findOne({ _id: O._id })).restore_state).toBeUndefined();
    const r = await call(O, 'POST', '/api/customers', { company_name: 'Old Co', phone_primary: '9' });
    expect(r.status).toBe(200);
    expect((await restore.getRestoreState(O._id)).restore_state).toBe('none');
  });

  test('a fresh account restoring a backup goes none → restore_in_progress → none', async () => {
    const F = await User.create({ name: 'fresh2', email: 'fresh2@state.test', password: PW });
    await masters.seedDefaultCatalog(F._id);
    const { status, jobId } = await restoreInto(F._id, await orphanZip('gamma'));
    expect(status.status).toBe('DONE');
    expect(await stateOf(F._id)).toBe('none');
    expect((await RestoreJob.findById(jobId).lean()).prior_state).toBe('none');
  });
});

describe('the write gate, route by route', () => {
  // A throwaway tenant: in the waiting state the change routes are NOT refused, so they really do
  // rename, hide and delete — which must not happen to the fixtures the later tests compare with.
  let Z, custId;
  beforeAll(async () => {
    Z = await tenant('zeta');
    custId = String((await Customer.findOne({ user_id: Z._id }).lean())._id);
  });

  test('empty_pending_restore: every creation route is refused with the Settings pointer', async () => {
    await setState(Z._id, 'empty_pending_restore');
    const before = await snapshotOf(Z._id);
    for (const [m, url, body] of CREATES(custId)) {
      const r = await call(Z, m, url, body);
      expect([m, url, gated(r)]).toEqual([m, url, true]);
      expect(r.json.error).toMatch(/Settings → Data & Privacy/);
      expect(r.json.restore_state).toBe('empty_pending_restore');
    }
    expect(await snapshotOf(Z._id)).toEqual(before);
  });

  test('restore_in_progress: every creation AND every change is refused; reads stay open', async () => {
    await setState(Z._id, 'restore_in_progress');
    const before = await snapshotOf(Z._id);
    for (const [m, url, body] of [...CREATES(custId), ...CHANGES(custId)]) {
      const r = await call(Z, m, url, body);
      expect([m, url, gated(r)]).toEqual([m, url, true]);
      expect(r.json.restore_state).toBe('restore_in_progress');
    }
    expect(await snapshotOf(Z._id)).toEqual(before);
    for (const url of ['/api/customers', '/api/bills', '/api/profile/restore-state', '/api/masters/gas-types']) {
      expect([url, (await call(Z, 'GET', url)).status]).toEqual([url, 200]);
    }
    // the ways out stay reachable
    for (const [m, url, body] of [['POST', '/api/profile/verify-password', { password: PW }],
      ['POST', '/api/profile/restore-recovery', {}], ['POST', '/api/step-up/otp/send', {}]]) {
      expect([url, gated(await call(Z, m, url, body))]).toEqual([url, false]);
    }
  });

  test('another account in the same database is never gated by this one', async () => {
    await setState(Z._id, 'restore_in_progress');
    const r = await call(B, 'POST', '/api/customers', { company_name: 'B keeps working', phone_primary: '9' });
    expect(r.status).toBe(200);
    await Customer.deleteOne({ user_id: B._id, company_name: 'B keeps working' });
    expect(await snapshotOf(B._id)).toEqual(bBefore);
  });

  test('back to none: writes work again immediately, with no restart or re-login', async () => {
    await setState(Z._id, 'restore_in_progress');
    expect(gated(await call(Z, 'POST', '/api/customers', { company_name: 'Blocked', phone_primary: '9' }))).toBe(true);
    await setState(Z._id, 'none');
    const r = await call(Z, 'POST', '/api/customers', { company_name: 'Straight after', phone_primary: '9' });
    expect(r.status).toBe(200);
    expect(await Customer.countDocuments({ user_id: Z._id, company_name: 'Straight after' })).toBe(1);
  });

  // Last, because in this state these calls are allowed through and really change Z.
  test('empty_pending_restore: settings and other changes are NOT refused by the gate', async () => {
    await setState(Z._id, 'empty_pending_restore');
    for (const [m, url, body] of CHANGES(custId)) {
      const r = await call(Z, m, url, body);
      expect([m, url, gated(r)]).toEqual([m, url, false]);
    }
  });
});

describe('transitions', () => {
  test('Empty This Account → empty_pending_restore', async () => {
    ownerApproves();
    await profileSvc.emptyAccountForRestore(A._id, PW, 'ok');
    expect(await stateOf(A._id)).toBe('empty_pending_restore');
    expect((await restore.getRestoreState(A._id))).toMatchObject({ restore_state: 'empty_pending_restore', unfinished: false });
  });

  test('cancel needs the password and the owner, and only applies while waiting', async () => {
    await expect(profileSvc.cancelPendingRestore(A._id, 'wrong', 'x')).rejects.toThrow(/Incorrect password/);
    await expect(profileSvc.cancelPendingRestore(A._id, PW, 'not-a-token')).rejects.toThrow(/Approval expired or invalid/);
    expect(await stateOf(A._id)).toBe('empty_pending_restore');
    ownerApproves();
    await expect(profileSvc.cancelPendingRestore(B._id, PW, 'ok')).rejects.toThrow(/not waiting for a restore/);
  });

  test('cancel from empty_pending_restore → none, nothing else changes', async () => {
    ownerApproves();
    const before = await snapshotOf(A._id);
    const r = await profileSvc.cancelPendingRestore(A._id, PW, 'ok');
    expect(r.restore_state).toBe('none');
    expect(await stateOf(A._id)).toBe('none');
    const after = await snapshotOf(A._id);
    expect({ ...after, auditlogs: 0 }).toEqual({ ...before, auditlogs: 0 });   // one RESTORE_CANCEL row
    expect(await AuditLog.countDocuments({ user_id: A._id, action: 'RESTORE_CANCEL' })).toBe(1);
  });

  test('restore into an emptied account: empty_pending_restore → none, A back byte-for-byte', async () => {
    ownerApproves();
    await recordBackupTaken(A._id);
    await profileSvc.emptyAccountForRestore(A._id, PW, 'ok');
    const { status, jobId } = await restoreInto(A._id, zipPath);
    expect(status.status).toBe('DONE');
    expect(await stateOf(A._id)).toBe('none');
    expect((await RestoreJob.findById(jobId).lean()).prior_state).toBe('empty_pending_restore');
    expect(await snapshotOf(A._id)).toEqual(aArchived);
    expect(await snapshotOf(B._id)).toEqual(bBefore);
  });

  test('a restore that fails before writing deletes NOTHING and leaves the state alone', async () => {
    // The old code rolled back on ANY failure — including "the account is no longer empty", which
    // happens before a single write — and so deleted exactly the data that refusal protects.
    const E = await User.create({ name: 'eps', email: 'eps@state.test', password: PW });
    await masters.seedDefaultCatalog(E._id);
    const p = await restore.previewRestore(E._id, fs.createReadStream(await orphanZip('delta')));
    expect(p.problems).toEqual([]);
    await Customer.create({ user_id: E._id, company_name: 'Arrived after the preview', phone_primary: '9' });   // no longer empty
    const eBefore = await snapshotOf(E._id);
    const started = await restore.confirmRestore(E._id, p.restore_token);
    let st;
    for (let i = 0; i < 200; i++) {
      st = await restore.getRestoreStatus(E._id, started.job_id);
      if (st.status !== 'RUNNING') break;
      await new Promise(r => setTimeout(r, 25));
    }
    expect(st.status).toBe('FAILED');
    expect(st.error).toMatch(/no longer empty/);
    expect(await snapshotOf(E._id)).toEqual(eBefore);       // the customer and the catalog survive
    expect(await stateOf(E._id)).toBe('none');
  });

  test('a restore that fails after writing rolls back and returns to the state it started from', async () => {
    // Build an _id collision with B, exactly as restoreSharedDb does, into an account that was
    // emptied first (so it starts in empty_pending_restore).
    const H = await tenant('eta');
    const hZip = path.join(TMP, 'eta.zip');
    await exportTo(H._id, hZip);
    const hCust = await Customer.findOne({ user_id: H._id }).lean();
    await profileSvc.purgeAccountData(H._id);
    await User.deleteOne({ _id: H._id });
    await Customer.collection.insertOne({ ...hCust, user_id: B._id, company_name: 'B holds this _id' });

    const T = await User.create({ name: 'theta', email: 'theta@state.test', password: PW });
    await masters.seedDefaultCatalog(T._id);
    await setState(T._id, 'empty_pending_restore');
    const { status, jobId } = await restoreInto(T._id, hZip);
    expect(status.status).toBe('FAILED');
    expect((await RestoreJob.findById(jobId).lean()).prior_state).toBe('empty_pending_restore');
    expect(await stateOf(T._id)).toBe('empty_pending_restore');
    expect(await Customer.countDocuments({ user_id: T._id })).toBe(0);
    expect(await GasType.countDocuments({ user_id: T._id })).toBe(DEFAULT_GASES);
    await Customer.deleteOne({ _id: hCust._id, user_id: B._id });
    expect(await snapshotOf(B._id)).toEqual(bBefore);
  });

  test('a job that was declared dead before it wrote anything stops without touching anything', async () => {
    const M = await User.create({ name: 'mu', email: 'mu@state.test', password: PW });
    await masters.seedDefaultCatalog(M._id);
    const p = await restore.previewRestore(M._id, fs.createReadStream(await orphanZip('iota')));
    expect(p.can_restore).toBe(true);
    const mBefore = await snapshotOf(M._id);
    // declared dead (say, by another instance) before this process got to its first write
    await RestoreJob.updateOne({ _id: p.restore_token }, { $set: { status: 'INTERRUPTED' } });
    await restore.runRestore(p.restore_token);
    expect((await RestoreJob.findById(p.restore_token).lean()).status).toBe('INTERRUPTED');
    expect(await snapshotOf(M._id)).toEqual(mBefore);        // no write, no rollback
    expect(await stateOf(M._id)).toBe('none');
  });
});

describe('a restore that died mid-write', () => {
  test('is detected: the job becomes INTERRUPTED, the lock is released, Settings sees it as unfinished', async () => {
    const job = await simulateCrash(A._id);
    const s = await restore.getRestoreState(A._id);
    expect(s).toMatchObject({ restore_state: 'restore_in_progress', unfinished: true, running_job_id: null });
    expect(s.last_job.status).toBe('INTERRUPTED');
    const j = await RestoreJob.findById(job._id).lean();
    expect(j.status).toBe('INTERRUPTED');
    expect(j.lock_key).toBeUndefined();
    // the lock is free for every account again
    const other = await RestoreJob.create({ user_id: B._id, status: 'RUNNING', lock_key: 'RESTORE', heartbeat_at: new Date() });
    await RestoreJob.deleteOne({ _id: other._id });
    // and business writes stay refused throughout
    expect(gated(await call(A, 'POST', '/api/customers', { company_name: 'No', phone_primary: '9' }))).toBe(true);
    expect(gated(await call(A, 'PUT', '/api/profile/business', {}))).toBe(true);
  });

  test('recovery needs the password and the OWNER, exactly like Empty This Account', async () => {
    await expect(profileSvc.recoverUnfinishedRestore(A._id, 'wrong', 'x', 'discard')).rejects.toThrow(/Incorrect password/);
    await expect(profileSvc.recoverUnfinishedRestore(A._id, PW, 'not-a-token', 'discard')).rejects.toThrow(/Approval expired or invalid/);
    // a regular trusted-person approval is not enough
    const regular = jwt.sign({ id: String(A._id), step_up: true, scope: 'regular', via: 'OTP', person_id: String(new mongoose.Types.ObjectId()) },
      process.env.JWT_SECRET, { expiresIn: 600 });
    await expect(profileSvc.recoverUnfinishedRestore(A._id, PW, regular, 'discard')).rejects.toThrow(/owner/i);
    await expect(profileSvc.recoverUnfinishedRestore(A._id, PW, 'x', 'resume')).rejects.toThrow(/try the restore again or to remove/);
    expect(await stateOf(A._id)).toBe('restore_in_progress');
  });

  test('"Remove the partial data": full purge, default catalog once (no duplicates), back to none', async () => {
    ownerApproves();
    const r = await profileSvc.recoverUnfinishedRestore(A._id, PW, 'ok', 'discard');
    expect(r.restore_state).toBe('none');
    expect(await stateOf(A._id)).toBe('none');
    for (const k of ['customers', 'cylinders', 'bills', 'payments', 'cylinderhistories', 'locationprofiles', 'businessprofiles', 'counters']) {
      expect([k, await mongoose.connection.db.collection(k).countDocuments({ user_id: A._id })]).toEqual([k, 0]);
    }
    expect(await GasType.countDocuments({ user_id: A._id })).toBe(DEFAULT_GASES);
    expect(await CylinderSize.countDocuments({ user_id: A._id })).toBe(DEFAULT_SIZES);
    // one row per name — nothing left over from the half-written catalog
    const names = await GasType.distinct('gas_type_name', { user_id: A._id });
    expect(names.length).toBe(DEFAULT_GASES);
    expect(await AuditLog.countDocuments({ user_id: A._id, action: 'ACCOUNT_PURGE' })).toBe(1);
    // unblocked at once
    const c = await call(A, 'POST', '/api/customers', { company_name: 'Straight after recovery', phone_primary: '9' });
    expect(c.status).toBe(200);
    expect(await snapshotOf(B._id)).toEqual(bBefore);
  });

  test('"Try again": full purge, waiting for the upload, then the restore brings A back byte-for-byte', async () => {
    await simulateCrash(A._id);
    await restore.getRestoreState(A._id);                    // reaps the dead job
    ownerApproves();
    const r = await profileSvc.recoverUnfinishedRestore(A._id, PW, 'ok', 'retry');
    expect(r.restore_state).toBe('empty_pending_restore');
    expect(await GasType.countDocuments({ user_id: A._id })).toBe(DEFAULT_GASES);
    expect(gated(await call(A, 'POST', '/api/customers', { company_name: 'Still waiting', phone_primary: '9' }))).toBe(true);

    const { status } = await restoreInto(A._id, zipPath);
    expect(status.status).toBe('DONE');
    expect(await stateOf(A._id)).toBe('none');
    expect(await snapshotOf(A._id)).toEqual(aArchived);       // no duplicate gas types or sizes
    expect(await snapshotOf(B._id)).toEqual(bBefore);
  });

  test('recovery is refused when there is nothing unfinished', async () => {
    ownerApproves();
    await expect(profileSvc.recoverUnfinishedRestore(A._id, PW, 'ok', 'discard')).rejects.toThrow(/no unfinished restore/);
  });
});

describe('what counts as dead', () => {
  test('a job with a fresh heartbeat (another live process) is left alone', async () => {
    const j = await RestoreJob.create({ user_id: B._id, status: 'RUNNING', lock_key: 'RESTORE', heartbeat_at: new Date() });
    expect(await restore.reapDeadJobs()).toBe(0);
    expect((await RestoreJob.findById(j._id).lean()).status).toBe('RUNNING');
    await RestoreJob.deleteOne({ _id: j._id });
  });

  test('a job running in THIS process is never reaped, however quiet its heartbeat', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const j = await RestoreJob.create({ user_id: B._id, status: 'RUNNING', lock_key: 'RESTORE', heartbeat_at: old });
    restore._activeJobs.add(String(j._id));
    try {
      expect(await restore.reapDeadJobs()).toBe(0);
      expect((await RestoreJob.findById(j._id).lean()).status).toBe('RUNNING');
    } finally {
      restore._activeJobs.delete(String(j._id));
      await RestoreJob.deleteOne({ _id: j._id });
    }
  });

  test('silent for longer than DEAD_AFTER_MS and not ours: dead', async () => {
    const j = await RestoreJob.create({ user_id: B._id, status: 'RUNNING', lock_key: 'RESTORE',
      heartbeat_at: new Date(Date.now() - restore.DEAD_AFTER_MS - 1000) });
    expect(await restore.reapDeadJobs()).toBe(1);
    expect((await RestoreJob.findById(j._id).lean()).status).toBe('INTERRUPTED');
    await RestoreJob.deleteOne({ _id: j._id });
  });

  test('at startup every RUNNING job is interrupted at once, fresh heartbeat or not', async () => {
    const j = await RestoreJob.create({ user_id: B._id, status: 'RUNNING', lock_key: 'RESTORE', heartbeat_at: new Date() });
    expect(await restore.interruptOrphansAtBoot()).toBe(1);
    const got = await RestoreJob.findById(j._id).lean();
    expect(got.status).toBe('INTERRUPTED');
    expect(got.lock_key).toBeUndefined();
    await RestoreJob.deleteOne({ _id: j._id });
  });
});

describe('opening Settings mid-restore does not seed a location the restore would collide with', () => {
  test('no default location is created while a restore is writing; it is once back to normal', async () => {
    const K = await User.create({ name: 'kappa', email: 'kappa@state.test', password: PW });
    await setState(K._id, 'restore_in_progress');
    await profileSvc.getLocationProfiles(K._id);
    expect(await LocationProfile.countDocuments({ user_id: K._id })).toBe(0);
    await setState(K._id, 'none');
    await profileSvc.getLocationProfiles(K._id);
    expect(await LocationProfile.countDocuments({ user_id: K._id })).toBe(1);
  });
});
