const { Readable } = require('stream');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const archiverLib = require('archiver');
const HttpError = require('../utils/HttpError');
const User = require('../models/User');
const BusinessProfile = require('../models/BusinessProfile');

// Required explicitly rather than looked up with mongoose.model(name): a name lookup throws
// MissingSchemaError unless something else happened to load the file first, which makes the
// backup depend on unrelated require order.
const MODELS = {
  LocationProfile: require('../models/LocationProfile'),
  BusinessProfile,
  GasType: require('../models/GasType'),
  GasCapacity: require('../models/GasCapacity'),
  CylinderSize: require('../models/CylinderSize'),
  Customer: require('../models/Customer'),
  Cylinder: require('../models/Cylinder'),
  Bill: require('../models/Bill'),
  Payment: require('../models/Payment'),
  PurityCertificate: require('../models/PurityCertificate'),
  RentalCharge: require('../models/RentalCharge'),
  FillingLogEntry: require('../models/FillingLogEntry'),
  CylinderHistory: require('../models/CylinderHistory'),
  Counter: require('../models/Counter'),
  LocationPcStock: require('../models/LocationPcStock'),
  AuditLog: require('../models/AuditLog')
};

// ─── Phase GEN-C: a real backup, distinct from "Download All my data" ───
//
// profile.service.exportData produces five flattened XLSX report sheets for a human to read: no
// _ids, no raw fields, nothing that could rebuild the database. This is the other thing — every
// document, byte for byte, in a form that restores.
//
// FORMAT: one file per collection, newline-delimited MongoDB Extended JSON (.ejsonl) — exactly
// what `mongoexport` writes. Extended JSON because plain JSON.stringify silently degrades
// ObjectId and Date on the round trip. NEWLINE-DELIMITED because a single JSON array cannot be
// streamed: the array is not valid until its closing bracket, so reading even the first document
// would mean holding the entire file in memory. At the five-year projection for cylinderhistories
// alone (~540k rows) that is the difference between a flat few MB and hundreds.
//
// The entries are written in DEPENDENCY ORDER, so a restore reading the archive sequentially
// receives them in an order it can insert directly.

const createArchive = (opts) => {
  if (typeof archiverLib === 'function') return archiverLib('zip', opts);
  if (archiverLib && typeof archiverLib.Archiver === 'function') return new archiverLib.Archiver('zip', opts);
  if (archiverLib && typeof archiverLib.default === 'function') return archiverLib.default('zip', opts);
  throw new Error('Unsupported "archiver" version: no known way to create a zip archive.');
};

// The backup format's own version. A restore refuses anything it does not recognise rather than
// guessing at an older or newer shape.
const BACKUP_FORMAT = 1;

// scope 'user' — rows belong to one account, matched on user_id. Every collection is per-account:
//                the gas/size catalogs were a global 'global' scope until 24 Sep 2026, when each
//                account got its own copy (masters.service). An archive written before then
//                carries catalog rows with no user_id; restore sets user_id on every row it writes,
//                so those archives still restore.
//
// ORDER IS LOAD-BEARING: it is the order a restore inserts in.
const COLLECTIONS = [
  { key: 'locationprofiles', model: 'LocationProfile', scope: 'user' },
  { key: 'businessprofiles', model: 'BusinessProfile', scope: 'user' },
  { key: 'gastypes', model: 'GasType', scope: 'user' },
  { key: 'gascapacities', model: 'GasCapacity', scope: 'user' },
  { key: 'cylindersizes', model: 'CylinderSize', scope: 'user' },
  { key: 'customers', model: 'Customer', scope: 'user' },
  { key: 'cylinders', model: 'Cylinder', scope: 'user' },
  { key: 'bills', model: 'Bill', scope: 'user' },
  { key: 'payments', model: 'Payment', scope: 'user' },
  { key: 'puritycertificates', model: 'PurityCertificate', scope: 'user' },
  { key: 'rentalcharges', model: 'RentalCharge', scope: 'user' },
  { key: 'fillinglogentries', model: 'FillingLogEntry', scope: 'user' },
  { key: 'cylinderhistories', model: 'CylinderHistory', scope: 'user' },
  { key: 'counters', model: 'Counter', scope: 'user' },
  { key: 'locationpcstocks', model: 'LocationPcStock', scope: 'user' },
  { key: 'auditlogs', model: 'AuditLog', scope: 'user' }
];

// User, OtpToken and TrustedPerson are deliberately absent, in both directions. A restore always
// happens under an account whose login and 2FA were created fresh at signup — carrying across
// password hashes, sessions or approval rights would be a security hole, not a convenience.
const EXCLUDED = ['User', 'OtpToken', 'TrustedPerson'];

const modelFor = (name) => {
  const m = MODELS[name];
  if (!m) throw new Error(`backup.service: no model registered for "${name}"`);
  return m;
};
const filterFor = (spec, userId) => (spec.scope === 'user' ? { user_id: userId } : {});

// One collection as a stream of EJSON lines. Backed by a cursor, so memory stays flat no matter
// how many documents there are.
function ejsonlStream(spec, userId) {
  const Model = modelFor(spec.model);
  return Readable.from((async function* () {
    const cursor = Model.find(filterFor(spec, userId)).lean().cursor();
    try {
      for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
        yield EJSON.stringify(doc) + '\n';
      }
    } finally {
      await cursor.close().catch(() => {});
    }
  })());
}

async function countAll(userId) {
  const counts = {};
  for (const spec of COLLECTIONS) {
    counts[spec.key] = await modelFor(spec.model).countDocuments(filterFor(spec, userId));
  }
  return counts;
}

// Everything a restore needs to decide whether this archive belongs where it is being pointed.
async function buildManifest(userId) {
  const [user, profile] = await Promise.all([
    User.findById(userId).select('account_code email name createdAt').lean(),
    BusinessProfile.findOne({ user_id: userId }).select('business_name').lean()
  ]);
  if (!user) throw new HttpError(404, 'Account not found');

  return {
    backup_format: BACKUP_FORMAT,
    exported_at: new Date(),
    // THE mis-restore guard. Restoring one client's archive into another client's database is
    // the disaster-recovery failure most likely to actually happen — wrong file, wrong target,
    // under pressure — and the one that silently destroys data. The codes will not match, and
    // the restore refuses before writing anything.
    account_code: user.account_code || '',
    // The source account's id. Traceability only — a restore always loads into the SIGNED-IN
    // account and never looks this up (R161): after a disaster the source account usually no
    // longer exists, and the account restoring is a fresh signup with an id of its own.
    account_id: String(user._id),
    account_email: user.email,
    account_name: user.name,
    account_created_at: user.createdAt,
    business_name: (profile && profile.business_name) || '',
    collections: COLLECTIONS.map(c => ({ key: c.key, model: c.model, scope: c.scope, file: `${c.key}.ejsonl` })),
    excluded: EXCLUDED,
    counts: await countAll(userId)
  };
}

// ─── Approximate download size, for the progress bar ───
// What the browser counts is COMPRESSED bytes, so these are average zip bytes per document, per
// collection — measured on a real account (Sep 2026: 20,800 documents -> 562 KB) and rounded UP,
// so the bar tends to finish a little early rather than sit at 99%. A rough figure on purpose:
// it only ever drives a percentage, and the client never shows it as a byte count.
const EST_ZIP_BYTES_PER_DOC = {
  locationprofiles: 130, gastypes: 40, gascapacities: 45, cylindersizes: 30, customers: 30,
  cylinders: 16, bills: 170, payments: 50, puritycertificates: 330, rentalcharges: 170,
  fillinglogentries: 10, cylinderhistories: 22, counters: 130, locationpcstocks: 30, auditlogs: 50
};
const EST_DEFAULT_BYTES_PER_DOC = 60;
const EST_ZIP_ENTRY_OVERHEAD = 120;          // local header + central directory record per file
// The business profile is one document whose size is almost entirely its logo — base64, which
// barely compresses and can be anything up to 500 KB — so it is sized from the stored document
// itself rather than from an average.
const EST_BASE64_ZIP_RATIO = 0.75;
const EST_PROFILE_FALLBACK_BYTES = 8000;

async function estimateBackupBytes(userId, counts) {
  let total = 2000 + EST_ZIP_ENTRY_OVERHEAD;   // manifest.json and its entry
  for (const spec of COLLECTIONS) {
    total += EST_ZIP_ENTRY_OVERHEAD;
    const n = Number(counts && counts[spec.key]) || 0;
    if (spec.key === 'businessprofiles') {
      let bytes = EST_PROFILE_FALLBACK_BYTES * n;
      try {
        const [row] = await BusinessProfile.aggregate([
          { $match: { user_id: new mongoose.Types.ObjectId(String(userId)) } },
          { $group: { _id: null, bytes: { $sum: { $bsonSize: '$$ROOT' } } } }
        ]);
        if (row && row.bytes > 0) bytes = Math.round(row.bytes * EST_BASE64_ZIP_RATIO);
      } catch { /* an older server without $bsonSize keeps the fallback */ }
      total += bytes;
      continue;
    }
    total += n * (EST_ZIP_BYTES_PER_DOC[spec.key] || EST_DEFAULT_BYTES_PER_DOC);
  }
  return Math.round(total);
}

// Stream the whole account to `res` as a ZIP. Nothing is buffered: the manifest is small, and
// every collection is piped straight from its cursor into the archive.
async function exportBackup(userId, res) {
  const manifest = await buildManifest(userId);

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const safeName = (manifest.business_name || 'CylinderPro').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40) || 'CylinderPro';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Backup_${safeName}_${stamp}.zip"`);
  // Headers leave with the first body byte, so the estimate is set before anything is piped. A
  // failed estimate sends no header at all — the client then shows its plain spinner rather than a
  // bar measured against a made-up number.
  try {
    const est = await estimateBackupBytes(userId, manifest.counts);
    if (est > 0) res.setHeader('X-Estimated-Backup-Bytes', String(est));
  } catch { /* progress display only — never a reason to fail the backup */ }

  const archive = createArchive({ zlib: { level: 9 } });
  archive.on('error', (err) => { res.destroy(err); });
  archive.pipe(res);

  // Manifest first so a reader can validate before consuming anything else.
  archive.append(Buffer.from(JSON.stringify(manifest, null, 2)), { name: 'manifest.json' });
  for (const spec of COLLECTIONS) {
    archive.append(ejsonlStream(spec, userId), { name: `${spec.key}.ejsonl` });
  }

  await archive.finalize();
  return manifest;
}

module.exports = {
  BACKUP_FORMAT,
  COLLECTIONS,
  EXCLUDED,
  buildManifest,
  estimateBackupBytes,
  countAll,
  exportBackup
};
