const { Readable } = require('stream');
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

// scope 'user'   — rows belong to one account, matched on user_id
// scope 'global' — shared catalogs with no user_id at all (see routes/masters.js: "global
//                  catalogs, not per-tenant data"). Restored by merge, never blind insert.
//
// ORDER IS LOAD-BEARING: it is the order a restore inserts in.
const COLLECTIONS = [
  { key: 'locationprofiles', model: 'LocationProfile', scope: 'user' },
  { key: 'businessprofiles', model: 'BusinessProfile', scope: 'user' },
  { key: 'gastypes', model: 'GasType', scope: 'global' },
  { key: 'gascapacities', model: 'GasCapacity', scope: 'global' },
  { key: 'cylindersizes', model: 'CylinderSize', scope: 'global' },
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
    account_email: user.email,
    account_name: user.name,
    account_created_at: user.createdAt,
    business_name: (profile && profile.business_name) || '',
    collections: COLLECTIONS.map(c => ({ key: c.key, model: c.model, scope: c.scope, file: `${c.key}.ejsonl` })),
    excluded: EXCLUDED,
    counts: await countAll(userId)
  };
}

// Stream the whole account to `res` as a ZIP. Nothing is buffered: the manifest is small, and
// every collection is piped straight from its cursor into the archive.
async function exportBackup(userId, res) {
  const manifest = await buildManifest(userId);

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const safeName = (manifest.business_name || 'CylinderPro').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40) || 'CylinderPro';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="Backup_${safeName}_${stamp}.zip"`);

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
  countAll,
  exportBackup
};
