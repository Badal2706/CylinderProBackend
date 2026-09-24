// Per-account catalogs (24 Sep 2026): give every existing gas type, cylinder size and gas capacity
// an owner, and make their names unique PER ACCOUNT instead of across the whole database.
//
//   DRY=1 node scripts/migrateScopeCatalogs.js     report only — writes nothing (run this first, R72)
//         node scripts/migrateScopeCatalogs.js     apply
//
// Run with the backend STOPPED: it swaps unique indexes, and a catalog write landing between the
// backfill and the index swap would be written without an owner.
//
// What it does, in order, and why that order:
//   1. Backfill user_id onto every catalog row that has none — all of them belong to the ONE account
//      in this database. Refuses if there is more than one account: ownership would be a guess.
//   2. Create the per-account unique indexes BEFORE dropping the global ones, so there is never a
//      moment when a name is not protected by a unique index.
//   3. Drop the global unique indexes (gas_type_name_1 / size_label_1). Mongoose never drops an
//      index on its own, and while these exist a second account could not have its own "Oxygen".
//   4. users.account_code: replace the plain index with a UNIQUE one, so two accounts can never
//      share a code (they would share a bill-number series).
//
// Idempotent: a second run finds nothing to backfill and every index already in place.
// Values are never changed — only the new user_id field is added (verified by content hash after).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const DRY = process.env.DRY === '1';
const CATALOGS = [
  { coll: 'gastypes', field: 'gas_type_name', oldIndex: 'gas_type_name_1' },
  { coll: 'cylindersizes', field: 'size_label', oldIndex: 'size_label_1' },
  { coll: 'gascapacities', field: 'gas_type_name', oldIndex: 'gas_type_name_1' },
];
const log = (...a) => console.log(...a);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const db = mongoose.connection.db;
  log(DRY ? '=== DRY RUN — nothing will be written ===' : '=== APPLYING ===');
  log(`database: ${mongoose.connection.name}`);

  // ── 0. who owns the existing rows ──
  const users = await db.collection('users').find({}, { projection: { email: 1 } }).toArray();
  log(`\naccounts in this database: ${users.length}`);
  users.forEach(u => log(`  ${u._id}  ${u.email}`));
  const unowned = {};
  for (const c of CATALOGS) {
    unowned[c.coll] = await db.collection(c.coll).countDocuments({ $or: [{ user_id: { $exists: false } }, { user_id: null }] });
  }
  const anyUnowned = Object.values(unowned).some(n => n > 0);
  if (anyUnowned && users.length !== 1) {
    console.error(`\nREFUSED: ${users.length} accounts exist, so there is no single owner for the unowned catalog rows.`);
    process.exit(1);
  }
  const owner = users[0] && users[0]._id;

  // ── 1. backfill ──
  log('\n1. backfill user_id');
  for (const c of CATALOGS) {
    const total = await db.collection(c.coll).countDocuments();
    log(`  ${c.coll.padEnd(14)} ${String(total).padStart(3)} rows, ${String(unowned[c.coll]).padStart(3)} without an owner -> ${unowned[c.coll] ? (DRY ? 'would set' : 'set') + ' user_id = ' + owner : 'nothing to do'}`);
    if (!DRY && unowned[c.coll]) {
      const r = await db.collection(c.coll).updateMany(
        { $or: [{ user_id: { $exists: false } }, { user_id: null }] },
        { $set: { user_id: owner } });
      log(`      updated ${r.modifiedCount}`);
    }
  }

  // ── 2 & 3. unique indexes: per-account first, then drop the global ones ──
  log('\n2-3. unique indexes');
  for (const c of CATALOGS) {
    const idx = await db.collection(c.coll).indexes();
    const newName = `user_id_1_${c.field}_1`;
    const hasNew = idx.some(i => i.name === newName);
    const hasOld = idx.some(i => i.name === c.oldIndex);
    log(`  ${c.coll.padEnd(14)} create ${newName}: ${hasNew ? 'already there' : (DRY ? 'would create' : 'creating')}` +
        ` | drop ${c.oldIndex}: ${hasOld ? (DRY ? 'would drop' : 'dropping') : 'already gone'}`);
    if (!DRY) {
      if (!hasNew) await db.collection(c.coll).createIndex({ user_id: 1, [c.field]: 1 }, { name: newName, unique: true });
      if (hasOld) await db.collection(c.coll).dropIndex(c.oldIndex);
    }
  }

  // ── 4. users.account_code unique ──
  log('\n4. users.account_code');
  const uidx = await db.collection('users').indexes();
  const hasUnique = uidx.some(i => i.name === 'account_code_unique');
  const hasPlain = uidx.some(i => i.name === 'account_code_1');
  const dup = await db.collection('users').aggregate([
    { $match: { account_code: { $gt: '' } } },
    { $group: { _id: '$account_code', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
  if (dup.length) {
    console.error(`REFUSED: account codes shared by more than one account: ${dup.map(d => d._id).join(', ')}`);
    process.exit(1);
  }
  log(`  create account_code_unique: ${hasUnique ? 'already there' : (DRY ? 'would create' : 'creating')}` +
      ` | drop account_code_1: ${hasPlain ? (DRY ? 'would drop' : 'dropping') : 'already gone'}`);
  if (!DRY) {
    if (!hasUnique) {
      await db.collection('users').createIndex({ account_code: 1 },
        { name: 'account_code_unique', unique: true, partialFilterExpression: { account_code: { $gt: '' } } });
    }
    if (hasPlain) await db.collection('users').dropIndex('account_code_1');
  }

  // ── verification ──
  log('\nverification');
  let ok = true;
  for (const c of CATALOGS) {
    const left = await db.collection(c.coll).countDocuments({ $or: [{ user_id: { $exists: false } }, { user_id: null }] });
    const owners = await db.collection(c.coll).distinct('user_id');
    log(`  ${c.coll.padEnd(14)} rows without an owner: ${left} | distinct owners: ${owners.length}${owners.length ? ' (' + owners.join(', ') + ')' : ''}`);
    if (!DRY && left) ok = false;
  }
  if (DRY) log('\nDRY RUN complete — nothing was written.');
  else log(ok ? '\nDone.' : '\nINCOMPLETE — rows remain without an owner.');
  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
