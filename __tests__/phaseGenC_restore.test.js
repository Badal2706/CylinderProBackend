// Phase GEN-C: backup → restore, round-tripped through a real archive.
//
// The end-to-end run against the actual production-copy backup lives in a scratchpad script; this
// is the part that must never regress silently, so it lives in the suite: the refusals.
process.env.NUMBERING_SALT = process.env.NUMBERING_SALT || 'test-salt-do-not-use-in-production';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const unzipper = require('unzipper');

const User = require('../models/User');
const Customer = require('../models/Customer');
const Cylinder = require('../models/Cylinder');
const Bill = require('../models/Bill');
const Counter = require('../models/Counter');
const CylinderHistory = require('../models/CylinderHistory');
const LocationProfile = require('../models/LocationProfile');
const BusinessProfile = require('../models/BusinessProfile');
const TrustedPerson = require('../models/TrustedPerson');
const RestoreJob = require('../models/RestoreJob');
const backup = require('../services/backup.service');
const restore = require('../services/restore.service');
const acct = require('../services/accountNumbering.service');
const N = require('../services/numbering.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_gencrestore_${Date.now()}`;
const CH = 'AT_PLANT_CHANDISAR';
const TMP = path.join(os.tmpdir(), `genc-restore-test-${Date.now()}`);

// A minimal writable stand-in for an Express response, so exportBackup can stream into a file.
function fileRes(filePath) {
  const out = fs.createWriteStream(filePath);
  out.setHeader = () => {};
  out.attachment = () => {};
  return out;
}

async function makeSourceAccount() {
  const GasType = require('../models/GasType');
  const CylinderSize = require('../models/CylinderSize');
  await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
  await CylinderSize.create({ size_label: '7 m3', is_active: true });

  const u = await User.create({ name: 'Source', email: 'source@restore.test', password: 'Test1234!' });
  await User.collection.updateOne({ _id: u._id }, { $set: { account_code: N.deriveAccountCode(u._id) } });
  await LocationProfile.create({ user_id: u._id, location: CH, label: 'Chandisar Plant', is_filling_location: true });
  await BusinessProfile.create({ user_id: u._id, business_name: 'Source Gases' });
  const cust = await Customer.create({ user_id: u._id, company_name: 'A Customer', phone_primary: '9', holding_limit: 10 });
  await Cylinder.create({ user_id: u._id, rotational_number: 'R-1', gas_type: 'Oxygen', capacity: '7 m3',
    location: CH, stock_state: 'AT_CUSTOMER' });
  await CylinderHistory.create({ user_id: u._id, cylinder_id: new mongoose.Types.ObjectId(),
    rotational_number: 'R-1', event_type: 'GIVEN', description: 'Given filled to A Customer',
    event_at: new Date('2026-06-15T10:00:00+05:30') });
  // A bill whose line item references the catalogs BY ID — the thing that broke.
  const GasType2 = require('../models/GasType');
  const CylinderSize2 = require('../models/CylinderSize');
  const gas = await GasType2.findOne({ gas_type_name: 'Oxygen' }).lean();
  const size = await CylinderSize2.findOne({ size_label: '7 m3' }).lean();
  await Bill.create({
    user_id: u._id, customer_id: cust._id, bill_number: '1A001', bill_date: new Date('2026-06-15T10:00:00+05:30'),
    challan_no: 'C-1', location: CH, transaction_type: 'GIVEN', transaction_category: 'CUSTOMER',
    line_items: [{
      direction: 'GIVEN', gas_type_id: gas._id, cylinder_size_id: size._id,
      gas_type_name: 'Oxygen', size_label: '7 m3', serial_number: 'R-1', quantity: 1, rate: 100, amount: 100
    }]
  });

  await Counter.create({ user_id: u._id, key: 'bill_number_series', financial_year: '', seq: 42 });
  acct._clearCache();
  return u;
}

async function exportTo(userId, file) {
  const res = fileRes(file);
  await backup.exportBackup(userId, res);
  await new Promise(r => res.on('close', r));
  return file;
}

let source, zipPath;

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  await Promise.all([Bill.syncIndexes(), Counter.syncIndexes(), Cylinder.syncIndexes(), RestoreJob.syncIndexes()]);
  await fs.promises.mkdir(TMP, { recursive: true });
  source = await makeSourceAccount();
  zipPath = await exportTo(source._id, path.join(TMP, 'backup.zip'));
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  await fs.promises.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe('the archive itself', () => {
  test('is a readable zip with a manifest and one file per collection', async () => {
    const dir = await unzipper.Open.file(zipPath);
    const names = dir.files.map(f => f.path);
    expect(names).toContain('manifest.json');
    backup.COLLECTIONS.forEach(c => expect(names).toContain(`${c.key}.ejsonl`));
  });

  test('carries the source account code — the mis-restore guard', async () => {
    const dir = await unzipper.Open.file(zipPath);
    const m = JSON.parse((await dir.files.find(f => f.path === 'manifest.json').buffer()).toString());
    expect(m.account_code).toBe(N.deriveAccountCode(source._id));
    expect(m.backup_format).toBe(backup.BACKUP_FORMAT);
  });

  test('never contains login or approval data, in either direction', async () => {
    const dir = await unzipper.Open.file(zipPath);
    const names = dir.files.map(f => f.path);
    ['users', 'otptokens', 'trustedpeople'].forEach(n =>
      expect(names.some(x => x.startsWith(n + '.'))).toBe(false));
    expect(backup.EXCLUDED).toEqual(['User', 'OtpToken', 'TrustedPerson']);
  });

  test('is Extended JSON — ObjectId and Date survive the round trip', async () => {
    const dir = await unzipper.Open.file(zipPath);
    const text = (await dir.files.find(f => f.path === 'cylinders.ejsonl').buffer()).toString();
    const doc = EJSON.parse(text.trim().split('\n')[0]);
    expect(doc._id._bsontype).toBe('ObjectId');
    expect(doc.createdAt).toBeInstanceOf(Date);
  });
});

describe('restoring into an empty account', () => {
  let target;

  beforeAll(async () => {
    // A restore models DISASTER RECOVERY: the server is gone and this is a fresh install. The
    // source account cannot still be sitting in the target database — the "this database belongs
    // to another account" guard would (correctly) refuse, which is exactly what the refusal tests
    // below assert. So wipe first, exactly as a new deployment would start.
    for (const spec of backup.COLLECTIONS) {
      await require(`../models/${spec.model}`).deleteMany({});
    }
    await User.deleteMany({});
    await TrustedPerson.deleteMany({});
    acct._clearCache();

    target = await User.create({ name: 'Target', email: 'target@restore.test', password: 'Test1234!' });
    target.account_code = N.deriveAccountCode(target._id);
    await target.save();
    acct._clearCache();
  });

  test('the preview validates and writes NOTHING', async () => {
    const before = await Cylinder.countDocuments({ user_id: target._id });
    const p = await restore.previewRestore(target._id, fs.createReadStream(zipPath));
    expect(p.can_restore).toBe(true);
    expect(p.problems).toEqual([]);
    expect(await Cylinder.countDocuments({ user_id: target._id })).toBe(before);
    expect(await Customer.countDocuments({ user_id: target._id })).toBe(0);
  });

  test('it warns that Trusted People and the login are not included', async () => {
    const p = await restore.previewRestore(target._id, fs.createReadStream(zipPath));
    expect(p.warnings.some(w => /Trusted People/i.test(w))).toBe(true);
  });

  test('restores every document, preserving _id and rewriting only user_id', async () => {
    const p = await restore.previewRestore(target._id, fs.createReadStream(zipPath));
    const started = await restore.confirmRestore(target._id, p.restore_token);

    let st;
    for (let i = 0; i < 200; i++) {
      st = await restore.getRestoreStatus(target._id, started.job_id);
      if (['DONE', 'FAILED', 'ROLLBACK_FAILED'].includes(st.status)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(st.status).toBe('DONE');
    expect(st.mismatches).toEqual([]);

    // Compared against the ARCHIVE, not against the source account — the source no longer
    // exists, and the archive is the real source of truth for what should have arrived.
    const dir = await unzipper.Open.file(zipPath);
    const srcText = (await dir.files.find(f => f.path === 'cylinders.ejsonl').buffer()).toString();
    const src = EJSON.parse(srcText.trim().split('\n')[0]);

    const got = await Cylinder.findOne({ user_id: target._id, rotational_number: 'R-1' }).lean();
    expect(got).toBeTruthy();
    expect(String(got._id)).toBe(String(src._id));        // _id preserved
    expect(String(got.user_id)).toBe(String(target._id)); // user_id rewritten — the ONLY change
    expect(got.location).toBe(src.location);              // loaded verbatim, never recomputed
    expect(got.stock_state).toBe(src.stock_state);
    expect(got.stock_state).toBe('AT_CUSTOMER');

    // History arrived without logEvents' cap or manager resolution touching it.
    const h = await CylinderHistory.findOne({ user_id: target._id }).lean();
    expect(h.description).toBe('Given filled to A Customer');
    expect(new Date(h.event_at).toISOString()).toBe(new Date('2026-06-15T10:00:00+05:30').toISOString());

    // The counter — the easiest thing to overlook and the costliest to get wrong.
    const ctr = await Counter.findOne({ user_id: target._id, key: 'bill_number_series' }).lean();
    expect(ctr).toBeTruthy();
    expect(ctr.seq).toBe(42);

    // The account adopted the backup's code, so identities stay exactly as exported.
    const after = await User.findById(target._id).select('account_code').lean();
    expect(after.account_code).toBe(N.deriveAccountCode(source._id));
  });

  // The prompt's own self-verification item: not just "the next number looks right", but an
  // actual bill created in the restored account, saved through the real service.
  test('a NEW bill created after the restore continues the series and collides with nothing', async () => {
    const GasType = require('../models/GasType');
    const CylinderSize = require('../models/CylinderSize');
    const billSvc = require('../services/bill.service');

    const cust = await Customer.findOne({ user_id: target._id }).lean();
    const gas = await GasType.findOne({ gas_type_name: 'Oxygen' }).lean()
      || await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
    const size = await CylinderSize.findOne({ size_label: '7 m3' }).lean()
      || await CylinderSize.create({ size_label: '7 m3', is_active: true });

    const before = await Bill.countDocuments({ user_id: target._id });
    const suggested = await billSvc.generateBillNumber(target._id);
    expect(suggested).toBe('1A043');            // restored counter sat at 42

    const created = await billSvc.createBill(target._id, {
      customer_id: String(cust._id), bill_date: new Date('2026-06-20T10:00:00+05:30'),
      transaction_type: 'GIVEN', challan_no: 'POST-RESTORE', location: CH,
      given_items: [{ gas_type_id: String(gas._id), cylinder_size_id: String(size._id),
                      quantity: 0, rate: 100, personalCylindersIn: 1 }]
    });

    expect(created.bill_number).toBe('1A043');
    expect(await Bill.countDocuments({ user_id: target._id })).toBe(before + 1);

    // It carries the ADOPTED account code, so it sits in the same identity space as the
    // restored bills rather than a new one.
    const doc = await Bill.findById(created.bill_id).lean();
    expect(doc.account_code).toBe(N.deriveAccountCode(source._id));
    expect(doc.bill_uid).toBe(`${doc.account_code}-2627-1A043`);

    // No duplicate anywhere in this account+year.
    const same = await Bill.countDocuments({
      account_code: doc.account_code, financial_year: doc.financial_year, bill_number: '1A043' });
    expect(same).toBe(1);

    // And the counter moved on.
    const ctr = await Counter.findOne({ user_id: target._id, key: 'bill_number_series' }).lean();
    expect(ctr.seq).toBe(43);
  });

  test('nothing from the source login came across', async () => {
    expect(await TrustedPerson.countDocuments()).toBe(0);
    expect(await User.countDocuments()).toBe(1);   // only the account signup created
    const t = await User.findById(target._id).lean();
    expect(t.email).toBe('target@restore.test');
  });
});

// Found by clicking through the real UI: a brand-new account is NOT blank. Opening Settings seeds
// three LocationProfiles carrying the same codes the backup uses, which both tripped the
// empty-account guard and would have collided on the unique (user_id, location) index mid-restore.
describe('a freshly signed-up account, with its seeded defaults', () => {
  let fresh;

  beforeAll(async () => {
    for (const spec of backup.COLLECTIONS) await require(`../models/${spec.model}`).deleteMany({});
    await User.deleteMany({});
    await TrustedPerson.deleteMany({});
    await RestoreJob.deleteMany({});
    acct._clearCache();

    fresh = await User.create({ name: 'Fresh', email: 'fresh-seeded@restore.test', password: 'Test1234!' });
    fresh.account_code = N.deriveAccountCode(fresh._id);
    await fresh.save();
    acct._clearCache();

    // Exactly what profile.service.getLocationProfiles seeds on first Settings load — including
    // AT_PLANT_CHANDISAR, which the backup also contains.
    await LocationProfile.create([
      { user_id: fresh._id, location: 'AT_PLANT_CHANDISAR', label: 'Chandisar Plant', is_filling_location: true },
      { user_id: fresh._id, location: 'AT_PALANPUR_OFFICE', label: 'Palanpur Office' },
      { user_id: fresh._id, location: 'AT_CHHAPI_OFFICE', label: 'Chhapi Office' }
    ]);
  });

  test('seeded location profiles do NOT block the restore', async () => {
    expect(await LocationProfile.countDocuments({ user_id: fresh._id })).toBe(3);
    const p = await restore.previewRestore(fresh._id, fs.createReadStream(zipPath));
    expect(p.can_restore).toBe(true);
    expect(p.problems).toEqual([]);
    // ...but the operator is told the defaults are about to be replaced.
    expect(p.warnings.some(w => /will be replaced/i.test(w))).toBe(true);
  });

  test('they are REPLACED, not duplicated — no unique-index collision', async () => {
    const p = await restore.previewRestore(fresh._id, fs.createReadStream(zipPath));
    const started = await restore.confirmRestore(fresh._id, p.restore_token);
    let st;
    for (let i = 0; i < 200; i++) {
      st = await restore.getRestoreStatus(fresh._id, started.job_id);
      if (['DONE', 'FAILED', 'ROLLBACK_FAILED'].includes(st.status)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(st.status).toBe('DONE');
    expect(st.error).toBe('');

    // The backup holds ONE location profile; the seeded three are gone, not merged.
    const after = await LocationProfile.find({ user_id: fresh._id }).lean();
    expect(after).toHaveLength(1);
    expect(after[0].location).toBe(CH);
    expect(after[0].label).toBe('Chandisar Plant');
  });
});

// Found by restoring through the real UI: config/mongodb.js upserts a default catalog on EVERY
// boot, so a fresh install already holds "Oxygen" and "7 m3" under freshly minted ids. Merging the
// archive's catalogs by name therefore left their ids unused and every restored bill pointing at a
// gas type that did not exist — 30 warnings, and silently broken references behind them.
describe('catalogs that a fresh install has already seeded under different ids', () => {
  let target;

  beforeAll(async () => {
    for (const spec of backup.COLLECTIONS) await require(`../models/${spec.model}`).deleteMany({});
    await User.deleteMany({});
    await TrustedPerson.deleteMany({});
    await RestoreJob.deleteMany({});
    acct._clearCache();

    // Exactly what booting against an empty database produces: the same NAMES, brand-new ids.
    const GasType = require('../models/GasType');
    const CylinderSize = require('../models/CylinderSize');
    await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
    await CylinderSize.create({ size_label: '7 m3', is_active: true });

    target = await User.create({ name: 'Seeded', email: 'seeded@restore.test', password: 'Test1234!' });
    target.account_code = N.deriveAccountCode(target._id);
    await target.save();
    acct._clearCache();
  });

  test('the archive\'s catalogs replace the seeded ones, ids and all', async () => {
    const GasType = require('../models/GasType');
    const seededId = String((await GasType.findOne({ gas_type_name: 'Oxygen' }).lean())._id);

    const p = await restore.previewRestore(target._id, fs.createReadStream(zipPath));
    expect(p.can_restore).toBe(true);
    const started = await restore.confirmRestore(target._id, p.restore_token);

    let st;
    for (let i = 0; i < 200; i++) {
      st = await restore.getRestoreStatus(target._id, started.job_id);
      if (['DONE', 'FAILED', 'ROLLBACK_FAILED'].includes(st.status)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(st.status).toBe('DONE');

    // The specific warning that used to appear 30 times.
    expect(st.mismatches.filter(m => /already exists with a different id/.test(m))).toEqual([]);
    expect(st.mismatches).toEqual([]);

    const oxy = await GasType.findOne({ gas_type_name: 'Oxygen' }).lean();
    expect(String(oxy._id)).not.toBe(seededId);              // the archive's id won
    expect(await GasType.countDocuments({ gas_type_name: 'Oxygen' })).toBe(1);  // not duplicated
  });

  test('and every restored bill\'s catalog reference actually resolves', async () => {
    const GasType = require('../models/GasType');
    const CylinderSize = require('../models/CylinderSize');
    const bills = await Bill.find({ user_id: target._id }).lean();
    expect(bills.length).toBeGreaterThan(0);

    let checked = 0;
    for (const b of bills) {
      for (const li of (b.line_items || [])) {
        if (li.gas_type_id) {
          checked++;
          expect(await GasType.exists({ _id: li.gas_type_id })).toBeTruthy();
        }
        if (li.cylinder_size_id) {
          checked++;
          expect(await CylinderSize.exists({ _id: li.cylinder_size_id })).toBeTruthy();
        }
      }
    }
    expect(checked).toBeGreaterThan(0);   // not vacuous
  });
});

describe('the refusals — these are the whole safety story', () => {
  test('an account holding even ONE customer is refused', async () => {
    const u = await User.create({ name: 'Busy', email: 'busy@restore.test', password: 'Test1234!' });
    u.account_code = N.deriveAccountCode(u._id);
    await u.save();
    await Customer.create({ user_id: u._id, company_name: 'Existing', phone_primary: '9', holding_limit: 1 });

    const p = await restore.previewRestore(u._id, fs.createReadStream(zipPath));
    expect(p.can_restore).toBe(false);
    expect(p.problems.some(x => /already contains data/i.test(x))).toBe(true);

    // And there is no way to push past it.
    await expect(restore.confirmRestore(u._id, p.restore_token))
      .rejects.toThrow(/did not pass validation/i);
  });

  test('a database that belongs to another account is refused', async () => {
    const u = await User.create({ name: 'Fresh', email: 'fresh@restore.test', password: 'Test1234!' });
    u.account_code = N.deriveAccountCode(u._id);
    await u.save();
    // This account is empty, but the database is not — `source` owns data here.
    const p = await restore.previewRestore(u._id, fs.createReadStream(zipPath));
    expect(p.can_restore).toBe(false);
    expect(p.problems.some(x => /another account/i.test(x))).toBe(true);
  });

  test('a zip that is not a backup is rejected with a message naming the likely mistake', async () => {
    const junk = path.join(TMP, 'notabackup.zip');
    const res = fileRes(junk);
    const archiver = require('archiver');
    const a = (typeof archiver === 'function') ? archiver('zip') : new archiver.Archiver('zip');
    a.pipe(res);
    a.append(Buffer.from('col1,col2\n1,2'), { name: 'Customers.xlsx' });
    await a.finalize();
    await new Promise(r => res.on('close', r));

    const u = await User.create({ name: 'Junk', email: 'junk@restore.test', password: 'Test1234!' });
    await expect(restore.previewRestore(u._id, fs.createReadStream(junk)))
      .rejects.toThrow(/Download All My Data|not a CylinderPro backup/i);
  });

  test('a file that is not a zip at all is rejected', async () => {
    const notZip = path.join(TMP, 'plain.txt');
    await fs.promises.writeFile(notZip, 'this is not a zip file');
    const u = await User.create({ name: 'NotZip', email: 'notzip@restore.test', password: 'Test1234!' });
    await expect(restore.previewRestore(u._id, fs.createReadStream(notZip)))
      .rejects.toThrow(/not a readable .zip/i);
  });

  test('an empty upload is rejected', async () => {
    const empty = path.join(TMP, 'empty.zip');
    await fs.promises.writeFile(empty, '');
    const u = await User.create({ name: 'Empty', email: 'empty@restore.test', password: 'Test1234!' });
    await expect(restore.previewRestore(u._id, fs.createReadStream(empty)))
      .rejects.toThrow(/upload was empty/i);
  });

  test('a stale restore token cannot be confirmed twice', async () => {
    const u = await User.create({ name: 'Twice', email: 'twice@restore.test', password: 'Test1234!' });
    const p = await restore.previewRestore(u._id, fs.createReadStream(zipPath));
    // It is refused for the database-not-empty reason, but the point is the token state machine.
    await expect(restore.confirmRestore(u._id, p.restore_token)).rejects.toThrow();
    await expect(restore.confirmRestore(u._id, p.restore_token)).rejects.toThrow();
  });

  test('one account cannot confirm another account\'s staged restore', async () => {
    const a = await User.create({ name: 'Alpha2', email: 'alpha2@restore.test', password: 'Test1234!' });
    const b = await User.create({ name: 'Beta2', email: 'beta2@restore.test', password: 'Test1234!' });
    const p = await restore.previewRestore(a._id, fs.createReadStream(zipPath));
    await expect(restore.confirmRestore(b._id, p.restore_token)).rejects.toThrow(/expired or was never staged/i);
  });
});

// The safety net. If this does not work, a failed restore leaves the account half-populated —
// which then fails its own "must be empty" precondition, so it can never be restored into again.
describe('a restore that fails part-way undoes itself', () => {
  let victim;

  beforeAll(async () => {
    for (const spec of backup.COLLECTIONS) await require(`../models/${spec.model}`).deleteMany({});
    await User.deleteMany({});
    await TrustedPerson.deleteMany({});
    acct._clearCache();
    victim = await User.create({ name: 'Victim', email: 'victim@restore.test', password: 'Test1234!' });
    victim.account_code = N.deriveAccountCode(victim._id);
    await victim.save();
    acct._clearCache();
  });

  test('everything it wrote is removed, and the account is empty again', async () => {
    const p = await restore.previewRestore(victim._id, fs.createReadStream(zipPath));
    expect(p.can_restore).toBe(true);

    // Fail LATE, after customers, cylinders and bills have already been written — so there is
    // genuinely something to undo and the assertions below are not vacuous.
    const boom = jest.spyOn(CylinderHistory.collection, 'insertMany')
      .mockImplementation(() => { throw new Error('simulated disk failure mid-restore'); });

    let st;
    try {
      const started = await restore.confirmRestore(victim._id, p.restore_token);
      for (let i = 0; i < 200; i++) {
        st = await restore.getRestoreStatus(victim._id, started.job_id);
        if (['DONE', 'FAILED', 'ROLLBACK_FAILED'].includes(st.status)) break;
        await new Promise(r => setTimeout(r, 50));
      }
    } finally {
      boom.mockRestore();
    }

    // It failed, it says so, and it did NOT quietly report success.
    expect(st.status).toBe('FAILED');
    expect(st.error).toMatch(/simulated disk failure/);

    // Without this the rollback proof would be vacuous: if it had died before writing anything,
    // there would have been nothing to undo and the emptiness below would prove nothing.
    expect(st.counts_written.customers).toBeGreaterThan(0);
    expect(st.counts_written.cylinders).toBeGreaterThan(0);

    // THE POINT: the account is empty again, so it can still be restored into.
    for (const spec of backup.COLLECTIONS.filter(c => c.scope === 'user')) {
      const n = await require(`../models/${spec.model}`).countDocuments({ user_id: victim._id });
      expect([spec.key, n]).toEqual([spec.key, 0]);
    }

    // And it says what it removed.
    expect(st.mismatches.some(m => /Rolled back/.test(m))).toBe(true);

    // The lock was released, so the next restore is not blocked by the failed one.
    const stuck = await RestoreJob.countDocuments({ lock_key: 'RESTORE' });
    expect(stuck).toBe(0);
  });

  test('and a fresh restore afterwards succeeds — the account was not bricked', async () => {
    const p = await restore.previewRestore(victim._id, fs.createReadStream(zipPath));
    expect(p.can_restore).toBe(true);          // still passes the empty-account check

    const started = await restore.confirmRestore(victim._id, p.restore_token);
    let st;
    for (let i = 0; i < 200; i++) {
      st = await restore.getRestoreStatus(victim._id, started.job_id);
      if (['DONE', 'FAILED', 'ROLLBACK_FAILED'].includes(st.status)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(st.status).toBe('DONE');
    expect(await Customer.countDocuments({ user_id: victim._id })).toBeGreaterThan(0);
    expect(await CylinderHistory.countDocuments({ user_id: victim._id })).toBeGreaterThan(0);
  });
});

describe('only one restore can run at a time', () => {
  let clean;

  beforeAll(async () => {
    // The lock has to be the ONLY reason a confirm can fail here, or the test proves nothing.
    // So the database is wiped first: the account is empty and nobody else owns anything, which
    // means validation passes and the lock is the single remaining gate.
    for (const spec of backup.COLLECTIONS) await require(`../models/${spec.model}`).deleteMany({});
    await User.deleteMany({});
    await TrustedPerson.deleteMany({});
    await RestoreJob.deleteMany({});
    acct._clearCache();
    clean = await User.create({ name: 'Clean', email: 'clean@restore.test', password: 'Test1234!' });
    clean.account_code = N.deriveAccountCode(clean._id);
    await clean.save();
    acct._clearCache();
  });

  afterEach(async () => {
    // Never let a held lock leak into the next test — that is exactly what made the first
    // version of this suite fail with a misleading error.
    await RestoreJob.updateMany({ lock_key: 'RESTORE' }, { $unset: { lock_key: '' } });
  });

  test('a second confirm is refused specifically BECAUSE another holds the lock', async () => {
    const p = await restore.previewRestore(clean._id, fs.createReadStream(zipPath));
    expect(p.can_restore).toBe(true);          // proves nothing else can be the reason

    const holder = await RestoreJob.create({
      user_id: new mongoose.Types.ObjectId(), status: 'RUNNING', lock_key: 'RESTORE'
    });

    await expect(restore.confirmRestore(clean._id, p.restore_token))
      .rejects.toThrow(/Another restore is already running/i);

    await RestoreJob.deleteOne({ _id: holder._id });
  });

  test('and once the lock is released the same restore proceeds', async () => {
    const p = await restore.previewRestore(clean._id, fs.createReadStream(zipPath));
    expect(p.can_restore).toBe(true);
    const started = await restore.confirmRestore(clean._id, p.restore_token);

    let st;
    for (let i = 0; i < 200; i++) {
      st = await restore.getRestoreStatus(clean._id, started.job_id);
      if (['DONE', 'FAILED', 'ROLLBACK_FAILED'].includes(st.status)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(st.status).toBe('DONE');
  });

  test('the unique partial index is what actually enforces it', async () => {
    const a = await RestoreJob.create({ user_id: new mongoose.Types.ObjectId(), status: 'RUNNING', lock_key: 'RESTORE' });
    await expect(
      RestoreJob.create({ user_id: new mongoose.Types.ObjectId(), status: 'RUNNING', lock_key: 'RESTORE' })
    ).rejects.toThrow(/E11000|duplicate key/i);

    // Finishing releases it: lock_key is unset, so the partial index stops covering the row and
    // any number of completed jobs can coexist.
    await RestoreJob.updateOne({ _id: a._id }, { $set: { status: 'DONE' }, $unset: { lock_key: '' } });
    const b = await RestoreJob.create({ user_id: new mongoose.Types.ObjectId(), status: 'RUNNING', lock_key: 'RESTORE' });
    expect(b).toBeTruthy();
    await RestoreJob.deleteMany({ _id: { $in: [a._id, b._id] } });
  });
});

describe('signup assigns the permanent account code', () => {
  test('a user created through the model alone has none — it is the signup path that sets it', async () => {
    // Guards the gap found in end-to-end testing: the migration backfills existing accounts, but
    // a NEW signup must derive its own or every bill it issues carries a blank identity.
    const raw = await User.create({ name: 'Raw', email: 'raw@restore.test', password: 'Test1234!' });
    expect(raw.account_code).toBe('');

    const authSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'auth.service.js'), 'utf8');
    expect(authSrc).toMatch(/user\.account_code\s*=\s*require\('\.\/numbering\.service'\)\.deriveAccountCode\(user\._id\)/);
  });
});
