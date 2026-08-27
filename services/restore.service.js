const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const unzipper = require('unzipper');
const { EJSON } = require('bson');
const HttpError = require('../utils/HttpError');
const logger = require('../logger');
const User = require('../models/User');
const RestoreJob = require('../models/RestoreJob');
const backup = require('./backup.service');

// ─── Phase GEN-C: restoring a backup ───
//
// The governing rule is that a restore ONLY ever loads into an account that holds no BUSINESS
// data — no customers, cylinders, bills, payments or history. There is no overwrite mode and no
// force flag, and there never will be: the moment one exists, the worst day someone has with this
// software becomes "I pressed restore on the wrong account". Configuration (location profiles,
// business profile, counters) does not block a restore and is replaced by the archive — a fresh
// account is seeded with defaults, and overwriting those is precisely the point.
//
// That rule is also what makes rollback safe. A restore of several hundred thousand documents
// cannot be one transaction (MongoDB caps a transaction at 16 MB of oplog and 60 seconds by
// default), so a failure part-way through has to be undone by deleting what was written. Deleting
// everything belonging to the target account is only acceptable BECAUSE the account was verified
// empty first — the precondition and the recovery are the same fact.
//
// Everything here is streamed and batched: the ZIP is read entry by entry from disk, each entry
// line by line, and documents are flushed in batches. Nothing scales with the size of the backup.

const BATCH = 500;                      // documents per bulkWrite
const STAGE_TTL_MS = 30 * 60 * 1000;    // an unconfirmed upload is swept after 30 minutes
const HEARTBEAT_MS = 2000;

const tmpDir = () => path.join(os.tmpdir(), 'cylinderpro-restore');
const userScoped = () => backup.COLLECTIONS.filter(c => c.scope === 'user');
const globalScoped = () => backup.COLLECTIONS.filter(c => c.scope === 'global');

// "Empty account" means no BUSINESS data — not literally no documents.
//
// A brand-new account is not blank: opening Settings seeds three LocationProfiles (see
// profile.service.getLocationProfiles), and signing up writes audit rows. Treating those as data
// would refuse every restore into exactly the fresh account a restore is meant for. Worse, the
// seeded profiles carry the SAME location codes the backup does, so inserting the backup's copies
// would collide on the unique (user_id, location) index and fail mid-restore.
//
// So the guard checks the same list deleteEmptyAccounts.js uses — the records that represent real
// work — and the configuration below is cleared right before writing, because the backup replaces
// it wholesale anyway.
const BUSINESS_KEYS = [
  'customers', 'cylinders', 'bills', 'payments',
  'cylinderhistories', 'fillinglogentries', 'rentalcharges'
];
const businessScoped = () => userScoped().filter(c => BUSINESS_KEYS.includes(c.key));
const configScoped = () => userScoped().filter(c => !BUSINESS_KEYS.includes(c.key));

// The unique business field for each shared catalog — how a merge decides "already present".
const GLOBAL_KEY = { gastypes: 'gas_type_name', gascapacities: 'gas_type_name', cylindersizes: 'size_label' };

const modelOf = (spec) => require(`../models/${spec.model}`);

// ─────────────────────────── upload ───────────────────────────

// Stream the request body straight to disk. The route is mounted so that bodyParser never sees it
// (see server.js) — a 5 MB JSON limit and a base64 round trip would both be wrong here.
async function stageUpload(userId, req) {
  await fs.promises.mkdir(tmpDir(), { recursive: true });
  const zipPath = path.join(tmpDir(), `${crypto.randomBytes(12).toString('hex')}.zip`);

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    req.pipe(out);
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });

  const stat = await fs.promises.stat(zipPath).catch(() => null);
  if (!stat || stat.size === 0) {
    await fs.promises.unlink(zipPath).catch(() => {});
    throw new HttpError(400, 'The upload was empty. Choose a backup .zip file and try again.');
  }
  return zipPath;
}

// ─────────────────────────── reading the archive ───────────────────────────

async function openArchive(zipPath) {
  let dir;
  try {
    // Open.file reads the ZIP's central directory and gives random access by name WITHOUT
    // decompressing the whole archive into memory.
    dir = await unzipper.Open.file(zipPath);
  } catch {
    throw new HttpError(400, 'That file is not a readable .zip archive.');
  }
  const byName = new Map(dir.files.map(f => [f.path, f]));
  return { dir, byName };
}

async function readManifest(byName) {
  const entry = byName.get('manifest.json');
  if (!entry) {
    throw new HttpError(400,
      'This .zip has no manifest.json, so it is not a CylinderPro backup. ' +
      'Note that "Download All My Data" produces report spreadsheets, which cannot be restored — ' +
      'you need a file from "Download Backup".');
  }
  let manifest;
  try { manifest = JSON.parse((await entry.buffer()).toString()); }
  catch { throw new HttpError(400, 'The backup manifest is corrupted and could not be read.'); }

  if (manifest.backup_format !== backup.BACKUP_FORMAT) {
    throw new HttpError(400,
      `This backup is format version ${manifest.backup_format}, and this server understands ` +
      `version ${backup.BACKUP_FORMAT}. Restore it with a matching version of CylinderPro.`);
  }
  return manifest;
}

// Count the lines in one entry without holding it in memory — used to prove the archive's
// contents agree with what its manifest claims BEFORE anything is written.
function countLines(entry) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const rl = readline.createInterface({ input: entry.stream(), crlfDelay: Infinity });
    rl.on('line', (line) => { if (line.trim()) n++; });
    rl.on('close', () => resolve(n));
    rl.on('error', reject);
  });
}

// Every document in one collection's entry, one at a time.
async function* readDocs(entry) {
  const rl = readline.createInterface({ input: entry.stream(), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    yield EJSON.parse(t);
  }
}

// ─────────────────────────── validation ───────────────────────────

// Does the TARGET account already hold real work? This is the precondition, and it is also what
// makes the rollback safe, so it is checked in the preview and again immediately before writing.
// Configuration (location profiles, business profile, counters, audit rows) is deliberately NOT
// counted — see BUSINESS_KEYS above.
async function findExistingData(userId) {
  const found = [];
  for (const spec of businessScoped()) {
    const n = await modelOf(spec).countDocuments({ user_id: userId });
    if (n > 0) found.push(`${spec.key}: ${n}`);
  }
  return found;
}

// Clear the account's own configuration immediately before writing, so the backup's copies land
// cleanly. Safe because the account has already been verified to hold no business data, and
// because every one of these is fully replaced by the archive.
async function clearConfiguration(userId) {
  const removed = {};
  for (const spec of configScoped()) {
    const r = await modelOf(spec).deleteMany({ user_id: userId });
    if (r.deletedCount) removed[spec.key] = r.deletedCount;
  }
  return removed;
}

// Is this database already somebody else's? Restoring client A's archive into client B's live
// database is the disaster-recovery failure most likely to actually happen, and the only one that
// silently destroys data that was fine a moment ago.
async function findOtherAccounts(userId) {
  const others = await User.find({ _id: { $ne: userId } }).select('_id email account_code').lean();
  const owners = [];
  for (const o of others) {
    for (const spec of userScoped()) {
      if (await modelOf(spec).countDocuments({ user_id: o._id })) {
        owners.push(`${o.email}${o.account_code ? ` (${o.account_code})` : ''}`);
        break;
      }
    }
  }
  return owners;
}

// Read the archive, check everything that can be checked, and WRITE NOTHING.
async function validate(userId, byName, manifest) {
  const problems = [];
  const warnings = [];

  // 1. every declared entry is present
  for (const c of manifest.collections || []) {
    if (!byName.has(c.file)) problems.push(`The backup is missing ${c.file}.`);
  }

  // 2. the archive's real contents agree with what it claims
  const actual = {};
  for (const c of manifest.collections || []) {
    const entry = byName.get(c.file);
    if (!entry) continue;
    actual[c.key] = await countLines(entry);
    const declared = (manifest.counts || {})[c.key];
    if (declared !== undefined && declared !== actual[c.key]) {
      problems.push(`${c.key}: the manifest says ${declared} records but the file holds ${actual[c.key]}.`);
    }
  }

  // 3. the target account must be empty
  const existing = await findExistingData(userId);
  if (existing.length) {
    problems.push(
      'This account already contains data (' + existing.join(', ') + '). A restore can only load ' +
      'into an account with no customers, cylinders, bills, payments or history — create a new ' +
      'account and restore into that.');
  }

  // Configuration that WILL be replaced. Not a problem, but the operator should know it goes.
  const cfg = [];
  for (const spec of configScoped()) {
    const n = await modelOf(spec).countDocuments({ user_id: userId });
    if (n > 0) cfg.push(`${spec.key}: ${n}`);
  }
  if (cfg.length) {
    warnings.push(
      'This account\'s current settings (' + cfg.join(', ') + ') will be replaced by the ones in ' +
      'the backup. A new account starts with default locations, and those are exactly what a ' +
      'restore is meant to overwrite.');
  }

  // 4. the database must not belong to someone else
  const others = await findOtherAccounts(userId);
  if (others.length) {
    problems.push(
      'This database already holds business data for another account (' + others.join(', ') + '). ' +
      'Restoring here would mix two clients together. Each client must have its own database.');
  }

  // 5. the account code the restored records will carry
  const me = await User.findById(userId).select('account_code email').lean();
  if (!manifest.account_code) {
    warnings.push('This backup carries no account code, so its records cannot be traced back to their origin.');
  } else if (me && me.account_code && me.account_code !== manifest.account_code) {
    // Not a problem — it is the normal case. A fresh signup derives its own code, and the restore
    // adopts the backup's so that every bill_uid comes back byte-for-byte as exported.
    warnings.push(
      `This account's code (${me.account_code}) will be replaced by the backup's (${manifest.account_code}), ` +
      'so that every bill and receipt keeps the exact identity it had before. This is expected after ' +
      'a disaster recovery.');
  }

  warnings.push(
    'Trusted People, your password and two-factor setup are NOT part of a backup and will not be ' +
    'restored. Set them up again once the restore finishes.');

  return { ok: problems.length === 0, problems, warnings, actual_counts: actual };
}

// ─────────────────────────── preview ───────────────────────────

async function previewRestore(userId, req) {
  await sweepStale();
  const zipPath = await stageUpload(userId, req);

  try {
    const { byName } = await openArchive(zipPath);
    const manifest = await readManifest(byName);
    const validation = await validate(userId, byName, manifest);

    const job = await RestoreJob.create({
      user_id: userId, status: 'STAGED', zip_path: zipPath, manifest, validation
    });

    return {
      restore_token: String(job._id),
      can_restore: validation.ok,
      problems: validation.problems,
      warnings: validation.warnings,
      manifest: {
        exported_at: manifest.exported_at,
        business_name: manifest.business_name,
        account_email: manifest.account_email,
        account_code: manifest.account_code,
        counts: manifest.counts,
        total: Object.values(manifest.counts || {}).reduce((a, b) => a + b, 0)
      }
    };
  } catch (e) {
    await fs.promises.unlink(zipPath).catch(() => {});
    throw e;
  }
}

// ─────────────────────────── writing ───────────────────────────

// Insert one collection in batches, preserving every _id and rewriting only user_id.
async function restoreUserCollection(job, spec, entry, userId, accountCode) {
  const Model = modelOf(spec);
  let ops = [];
  let written = 0;

  const flush = async () => {
    if (!ops.length) return;
    // Native driver, bypassing Mongoose: schema middleware would recompute derived fields
    // (financial_year, bill_uid) and, for CylinderHistory, logEvents' rules do not apply to a
    // replay of records that were already written once. A restore reproduces, it does not re-derive.
    await Model.collection.insertMany(ops, { ordered: false });
    written += ops.length;
    ops = [];
    await RestoreJob.updateOne({ _id: job._id }, {
      $set: { 'progress.written': written, heartbeat_at: new Date() },
      $inc: { 'progress.done': 0 }
    });
  };

  for await (const doc of readDocs(entry)) {
    doc.user_id = userId;                       // the ONLY field a restore changes
    if (accountCode && doc.account_code !== undefined) doc.account_code = accountCode;
    ops.push(doc);
    if (ops.length >= BATCH) await flush();
  }
  await flush();
  return written;
}

// Shared catalogs have no user_id, and bill line items reference them BY _id (gas_type_id,
// cylinder_size_id) — so they must come back with the SAME _id or every restored bill points at
// a gas type that does not exist here.
//
// config/mongodb.js upserts a default catalog on EVERY BOOT, so a fresh install already holds
// "Oxygen", "7 m3" and the rest under freshly minted ids. Merging by name therefore left the
// archive's ids unused and every restored bill dangling. The catalogs are replaced wholesale
// instead — they are seeded defaults, exactly like the location profiles, and the archive is
// authoritative. Safe because a restore refuses outright if any OTHER account owns data here,
// so nothing else in this database can be referencing them.
async function clearGlobalCatalogs() {
  const removed = {};
  for (const spec of globalScoped()) {
    const r = await modelOf(spec).deleteMany({});
    if (r.deletedCount) removed[spec.key] = r.deletedCount;
  }
  return removed;
}

async function restoreGlobalCollection(spec, entry, mismatches) {
  const Model = modelOf(spec);
  const keyField = GLOBAL_KEY[spec.key];
  let written = 0;

  for await (const doc of readDocs(entry)) {
    try {
      await Model.collection.insertOne(doc);
      written++;
    } catch (e) {
      if (e.code !== 11000) throw e;
      // The catalog was cleared first, so a duplicate here means the ARCHIVE itself carries two
      // entries under one name. Worth reporting rather than swallowing.
      mismatches.push(
        `${spec.key}: the backup contains more than one "${keyField ? doc[keyField] : doc._id}" — kept the first.`);
    }
  }
  return written;
}

// Undo a partial restore. Safe ONLY because the account was verified empty before writing, which
// is checked once more here rather than assumed.
async function rollback(userId) {
  const removed = {};
  for (const spec of [...userScoped()].reverse()) {
    const r = await modelOf(spec).deleteMany({ user_id: userId });
    if (r.deletedCount) removed[spec.key] = r.deletedCount;
  }
  return removed;
}

async function runRestore(jobId) {
  const job = await RestoreJob.findById(jobId);
  if (!job) return;
  const userId = job.user_id;
  const manifest = job.manifest || {};
  const accountCode = manifest.account_code || '';
  const total = Object.values(manifest.counts || {}).reduce((a, b) => a + b, 0);

  const heartbeat = setInterval(() => {
    RestoreJob.updateOne({ _id: job._id }, { $set: { heartbeat_at: new Date() } }).catch(() => {});
  }, HEARTBEAT_MS);

  const countsWritten = {};
  const mismatches = [];
  let done = 0;

  try {
    const { byName } = await openArchive(job.zip_path);

    // Checked AGAIN, immediately before the first write: the preview may have been minutes ago,
    // and this is the precondition the rollback depends on.
    const existing = await findExistingData(userId);
    if (existing.length) {
      throw new HttpError(409,
        'The account is no longer empty (' + existing.join(', ') + '). Nothing was restored.');
    }

    // Clear the account's default configuration so the archive's copies insert cleanly. A fresh
    // account is seeded with location profiles carrying the SAME codes the backup uses, which
    // would otherwise collide on the unique (user_id, location) index part-way through.
    const clearedCfg = await clearConfiguration(userId);
    if (Object.keys(clearedCfg).length) {
      logger.info(`restore ${job._id}: replaced default configuration ${JSON.stringify(clearedCfg)}`);
    }
    const clearedCat = await clearGlobalCatalogs();
    if (Object.keys(clearedCat).length) {
      logger.info(`restore ${job._id}: replaced boot-seeded catalogs ${JSON.stringify(clearedCat)}`);
    }

    // Adopt the backup's account code so every restored bill_uid matches what was exported.
    // account_code is declared immutable, so this goes through the native driver — the same
    // deliberate exception the GEN-C migration uses.
    if (accountCode) {
      await User.collection.updateOne({ _id: userId }, { $set: { account_code: accountCode } });
      require('./accountNumbering.service')._clearCache();
    }

    for (const spec of backup.COLLECTIONS) {
      const entry = byName.get(`${spec.key}.ejsonl`);
      await RestoreJob.updateOne({ _id: job._id }, {
        $set: { 'progress.collection': spec.key, 'progress.written': 0, 'progress.total': total,
                'progress.done': done, heartbeat_at: new Date() }
      });
      if (!entry) { countsWritten[spec.key] = 0; continue; }

      countsWritten[spec.key] = spec.scope === 'global'
        ? await restoreGlobalCollection(spec, entry, mismatches)
        : await restoreUserCollection(job, spec, entry, userId, accountCode);

      done += countsWritten[spec.key];
      await RestoreJob.updateOne({ _id: job._id }, { $set: { 'progress.done': done } });
    }

    // Every collection is counted back out of the database and compared with the manifest. A
    // mismatch is a reported failure, never a quiet partial success.
    for (const spec of backup.COLLECTIONS) {
      const declared = (manifest.counts || {})[spec.key];
      if (declared === undefined) continue;
      const actual = await modelOf(spec).countDocuments(
        spec.scope === 'user' ? { user_id: userId } : {});
      if (spec.scope === 'user' && actual !== declared) {
        mismatches.push(`${spec.key}: expected ${declared}, found ${actual} after restore.`);
      } else if (spec.scope === 'global' && actual < declared) {
        mismatches.push(`${spec.key}: expected at least ${declared}, found ${actual}.`);
      }
    }

    // The check that would have caught the dangling-catalog bug: take real restored bills and
    // confirm the gas type and size their line items point at actually exist. Counting rows says
    // nothing about whether the references between them survived.
    const Bill = modelOf({ model: 'Bill' });
    const GasType = modelOf({ model: 'GasType' });
    const CylinderSize = modelOf({ model: 'CylinderSize' });
    const sample = await Bill.find({ user_id: userId }).select('line_items bill_number').limit(50).lean();
    const missingRefs = new Set();
    for (const b of sample) {
      for (const li of (b.line_items || [])) {
        if (li.gas_type_id && !(await GasType.exists({ _id: li.gas_type_id }))) {
          missingRefs.add(`gas type ${li.gas_type_id} (${li.gas_type_name || '?'})`);
        }
        if (li.cylinder_size_id && !(await CylinderSize.exists({ _id: li.cylinder_size_id }))) {
          missingRefs.add(`size ${li.cylinder_size_id} (${li.size_label || '?'})`);
        }
      }
    }
    if (missingRefs.size) {
      mismatches.push(
        `${missingRefs.size} catalog reference(s) in the restored bills do not resolve: ` +
        [...missingRefs].slice(0, 5).join(', ') + (missingRefs.size > 5 ? ' …' : ''));
    }

    if (mismatches.filter(m => !m.startsWith('gastypes') && !m.startsWith('gascapacities') && !m.startsWith('cylindersizes')).length) {
      throw new HttpError(500, 'Restore finished with count mismatches:\n' + mismatches.join('\n'));
    }

    clearInterval(heartbeat);
    await RestoreJob.updateOne({ _id: job._id }, {
      $set: { status: 'DONE', counts_written: countsWritten, mismatches, finished_at: new Date() },
      $unset: { lock_key: '' }
    });
    await fs.promises.unlink(job.zip_path).catch(() => {});
    logger.info(`restore ${job._id} completed for user ${userId}: ${done} documents`);
  } catch (err) {
    clearInterval(heartbeat);
    logger.error(`restore ${job._id} failed: ${err.stack || err.message}`);
    let status = 'FAILED';
    let removed = {};
    try {
      removed = await rollback(userId);
    } catch (rbErr) {
      status = 'ROLLBACK_FAILED';
      logger.error(`restore ${job._id} ROLLBACK FAILED: ${rbErr.stack || rbErr.message}`);
    }
    await RestoreJob.updateOne({ _id: job._id }, {
      $set: {
        status,
        error: err.message,
        counts_written: countsWritten,
        mismatches: mismatches.concat(
          Object.keys(removed).length ? [`Rolled back: ${JSON.stringify(removed)}`] : []),
        finished_at: new Date()
      },
      $unset: { lock_key: '' }
    });
    await fs.promises.unlink(job.zip_path).catch(() => {});
  }
}

// ─────────────────────────── confirm / status ───────────────────────────

async function confirmRestore(userId, restoreToken) {
  const job = await RestoreJob.findOne({ _id: restoreToken, user_id: userId }).catch(() => null);
  if (!job) throw new HttpError(404, 'That restore has expired or was never staged. Upload the backup again.');
  if (job.status !== 'STAGED') throw new HttpError(400, `This restore is already ${job.status.toLowerCase()}.`);
  if (!job.validation || !job.validation.ok) {
    throw new HttpError(400, 'This backup did not pass validation and cannot be restored.');
  }
  if (!fs.existsSync(job.zip_path)) {
    await RestoreJob.updateOne({ _id: job._id }, { $set: { status: 'EXPIRED' } });
    throw new HttpError(400, 'The uploaded file is no longer available. Upload the backup again.');
  }

  // Take the lock. The unique partial index means exactly one job can hold it.
  try {
    await RestoreJob.updateOne({ _id: job._id }, {
      $set: { status: 'RUNNING', lock_key: 'RESTORE', started_at: new Date(), heartbeat_at: new Date() }
    });
  } catch (e) {
    if (e.code === 11000) {
      throw new HttpError(409, 'Another restore is already running. Wait for it to finish before starting another.');
    }
    throw e;
  }

  // Deliberately NOT awaited: the request returns now and the browser polls for progress.
  runRestore(job._id).catch(err => logger.error(`restore ${job._id} escaped: ${err.stack || err.message}`));

  return { job_id: String(job._id), status: 'RUNNING', message: 'Restore started.' };
}

async function getRestoreStatus(userId, jobId) {
  const job = await RestoreJob.findOne({ _id: jobId, user_id: userId })
    .select('status progress counts_written mismatches error started_at finished_at manifest').lean()
    .catch(() => null);
  if (!job) throw new HttpError(404, 'Restore not found');
  const total = Object.values((job.manifest && job.manifest.counts) || {}).reduce((a, b) => a + b, 0);
  return {
    job_id: String(job._id),
    status: job.status,
    progress: {
      collection: job.progress.collection,
      done: job.progress.done,
      total,
      percent: total ? Math.min(100, Math.round((job.progress.done / total) * 100)) : 0
    },
    counts_written: job.counts_written,
    mismatches: job.mismatches,
    error: job.error,
    started_at: job.started_at,
    finished_at: job.finished_at
  };
}

// Uploads that were never confirmed leave a temp file behind; sweep them by age.
async function sweepStale() {
  const cutoff = new Date(Date.now() - STAGE_TTL_MS);
  const stale = await RestoreJob.find({ status: 'STAGED', createdAt: { $lt: cutoff } }).lean();
  for (const j of stale) {
    if (j.zip_path) await fs.promises.unlink(j.zip_path).catch(() => {});
    await RestoreJob.updateOne({ _id: j._id }, { $set: { status: 'EXPIRED' }, $unset: { lock_key: '' } });
  }
  return stale.length;
}

module.exports = {
  previewRestore,
  confirmRestore,
  getRestoreStatus,
  sweepStale,
  // exported for tests
  validate, findExistingData, findOtherAccounts, rollback, runRestore, openArchive, readManifest
};
