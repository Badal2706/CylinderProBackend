// ─── Phase GEN-C migration: per-account numbering identity ───
//
// Backfills, for every account in this database:
//   User.account_code           — derived once from _id + NUMBERING_SALT, then immutable
//   Bill.account_code           — denormalised from the owning user
//   Bill.financial_year         — derived from bill_date, IST (1 Apr → 31 Mar)
//   Bill.bill_uid               — "<account_code>-<FY4>-<bill_number>"
//   Payment.{account_code, financial_year, receipt_uid}   — the same, from `date`
//   Counter                     — the single global doc becomes one per (account, financial year)
//
// Then swaps the unique indexes:
//   Bill:    unique(bill_number)      →  unique(account_code, financial_year, bill_number)
//   Payment: unique(receipt_number)   →  unique(account_code, financial_year, receipt_number)
//
// PURELY ADDITIVE to existing values. No bill_number, receipt_number, date or amount is ever
// rewritten — the new fields sit alongside them. That is deliberate: those numbers are printed
// on documents customers already hold.
//
//   DRY=1 node scripts/migrateGenC_numbering.js     ← report only, writes nothing
//        node scripts/migrateGenC_numbering.js      ← apply
//
// Idempotent: safe to run repeatedly. Re-running only fills what is still missing.
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const Counter = require('../models/Counter');
const N = require('../services/numbering.service');

const DRY = process.env.DRY === '1';
const BATCH = 500;

const log = (...a) => console.log(...a);
const head = (t) => log('\n' + t + '\n' + '─'.repeat(t.length));

// A duplicate under the NEW key would make the unique index impossible to build, leaving the
// database half-migrated. So this projects what the key WOULD be for every document and checks
// that, rather than checking the current (still-empty) values — which would pass trivially and
// prove nothing. Runs identically on a dry run and an apply, so the dry run is a real pre-flight.
async function findCollisions(Model, { dateField, numberField, label }, accountCodeOf) {
  const seen = new Map();
  const clashes = [];
  const cursor = Model.find().select(`user_id ${dateField} ${numberField}`).lean().cursor();

  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    const code = accountCodeOf(String(doc.user_id));
    let fy;
    try { fy = N.financialYear(doc[dateField]); } catch { continue; }
    const key = `${code}|${fy}|${String(doc[numberField] || '').trim()}`;
    if (seen.has(key)) clashes.push({ key, a: seen.get(key), b: doc._id });
    else seen.set(key, doc._id);
  }

  if (clashes.length) {
    log(`  !! ${clashes.length} ${label} collision(s) under the NEW key — the unique index CANNOT`);
    log('     be built until these are resolved:');
    clashes.slice(0, 20).forEach(c => {
      const [, fy, num] = c.key.split('|');
      log(`     FY ${fy} / ${num}   ids: ${c.a}, ${c.b}`);
    });
  } else {
    log(`  ${label}: ${seen.size} distinct key(s), no collisions`);
  }
  return clashes.length;
}

async function backfillDocs(Model, { dateField, numberField, uidField, label }, accountCodeOf) {
  const q = { $or: [
    { account_code: { $in: [null, ''] } },
    { financial_year: { $in: [null, ''] } },
    { [uidField]: { $in: [null, ''] } }
  ] };
  const total = await Model.countDocuments(q);
  log(`  ${label}: ${total} needing backfill (of ${await Model.countDocuments()})`);
  if (!total) return { written: 0, skipped: 0 };

  let written = 0, skipped = 0, ops = [];
  const cursor = Model.find(q).select(`user_id ${dateField} ${numberField}`).lean().cursor();

  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    const code = accountCodeOf(String(doc.user_id));
    if (!code) { skipped++; continue; }                 // orphan: user no longer exists
    let fy;
    try { fy = N.financialYear(doc[dateField]); }
    catch { skipped++; continue; }                      // unparseable date: leave it alone, report it
    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: {
      account_code: code,
      financial_year: fy,
      [uidField]: N.buildUid(code, fy, doc[numberField])
    } } } });
    if (ops.length >= BATCH) {
      if (!DRY) await Model.bulkWrite(ops, { ordered: false });
      written += ops.length; ops = [];
    }
  }
  if (ops.length) {
    if (!DRY) await Model.bulkWrite(ops, { ordered: false });
    written += ops.length;
  }
  log(`    ${DRY ? 'would write' : 'wrote'} ${written}${skipped ? `, skipped ${skipped} (orphan or unparseable date)` : ''}`);
  return { written, skipped };
}

(async () => {
  if (!process.env.NUMBERING_SALT) {
    console.error('FATAL: NUMBERING_SALT is not set. Set it before migrating — the account codes it\n' +
                  'produces are permanent, and running with a different salt later would not match.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  log(`${DRY ? '=== DRY RUN — nothing will be written ===' : '=== APPLYING ==='}`);
  log(`database: ${mongoose.connection.name}`);

  // ── 1. account codes ──
  head('1. User.account_code');
  const users = await User.find().select('_id email account_code').lean();
  const codeByUser = {};
  let newCodes = 0;
  for (const u of users) {
    const existing = (u.account_code || '').trim();
    const derived = N.deriveAccountCode(u._id);
    codeByUser[String(u._id)] = existing || derived;
    if (existing) {
      // Never re-derive over an existing code: it is what every bill_uid is built from.
      log(`  ${u.email}  ${existing}  (already set${existing === derived ? '' : ' — DIFFERS from what this salt derives, keeping stored'})`);
    } else {
      log(`  ${u.email}  ${derived}  (new)`);
      newCodes++;
      // NATIVE driver on purpose. account_code is declared immutable on the schema, so Mongoose
      // SILENTLY STRIPS it from a normal updateOne — the migration would report success and write
      // nothing. Setting it once, here, is the single legitimate exception to that immutability.
      if (!DRY) await User.collection.updateOne({ _id: u._id }, { $set: { account_code: derived } });
    }
  }
  log(`  ${DRY ? 'would set' : 'set'} ${newCodes} new code(s); ${users.length - newCodes} already had one`);

  const codeOf = (uid) => codeByUser[uid] || '';

  // ── 2 & 3. bills and payments ──
  head('2. Bill numbering fields');
  const b = await backfillDocs(Bill, {
    dateField: 'bill_date', numberField: 'bill_number', uidField: 'bill_uid', label: 'bills'
  }, codeOf);

  head('3. Payment numbering fields');
  const p = await backfillDocs(Payment, {
    dateField: 'date', numberField: 'receipt_number', uidField: 'receipt_uid', label: 'payments'
  }, codeOf);

  // ── 4. the counter ──
  head('4. Counter → per account, per financial year');
  const counters = await Counter.find().lean();
  const legacy = counters.filter(c => !c.user_id);
  if (!legacy.length) {
    log('  no legacy global counter — nothing to convert');
  } else {
    // Attribute the sequence to whoever actually OWNS bills in it — not simply "the only
    // account", which was the first version of this and was wrong: production carries two extra
    // sign-up accounts that hold no data, and their mere existence made the migration skip the
    // counter entirely. A skipped counter is the worst outcome here: the app then starts a fresh
    // one at zero and peekNextBillNumber walks up from 1A001 looking for a free slot, reissuing
    // an old gap instead of continuing the series.
    const SERIES = /^\d+[A-Z]\d{3}$/;
    const seriesOwners = await Bill.distinct('user_id', { bill_number: SERIES });
    const anyBillOwners = await Bill.distinct('user_id');

    // Prefer whoever owns series-format bills; fall back to whoever owns any bill at all.
    const candidates = seriesOwners.length ? seriesOwners : anyBillOwners;

    if (candidates.length === 1) {
      const owner = users.find(u => String(u._id) === String(candidates[0]));
      const label = owner ? owner.email : String(candidates[0]);
      for (const c of legacy) {
        log(`  "${c.key}" seq=${c.seq} → ${label}, financial_year='' (continuous series)`);
        log(`     (attributed by bill ownership: ${users.length} account(s) exist, but only this`);
        log(`      one owns bills in the series)`);
        if (!DRY) {
          await Counter.updateOne({ _id: c._id }, { $set: { user_id: candidates[0], financial_year: '' } });
        }
      }
      log(`  NOTE: financial_year is '' because financial-year reset defaults to OFF. If this`);
      log(`  account later opts in, the first bill of the new year starts a fresh counter row.`);
    } else if (candidates.length === 0) {
      log(`  !! ${legacy.length} legacy counter(s) but NO account owns any bill — nothing to`);
      log('     attribute the sequence to. Safe to leave: with no bills, the series starts fresh.');
    } else {
      log(`  !! ${legacy.length} legacy counter(s) and ${candidates.length} accounts own bills in the`);
      log('     series. The sequence genuinely cannot be attributed automatically — this database');
      log('     holds more than one client, which violates R102. Resolve by hand BEFORE applying:');
      candidates.forEach(id => {
        const u = users.find(x => String(x._id) === String(id));
        log(`       ${u ? u.email : id}`);
      });
    }
  }

  // Whatever happened above, verify the outcome — a counter left unattributed is a silent
  // series break, so it is reported as a problem rather than passed over.
  const orphanCounters = await Counter.countDocuments({ user_id: { $exists: false } });
  if (orphanCounters && !DRY) {
    log(`  !! ${orphanCounters} counter(s) still have no owner. The bill series WILL restart from`);
    log('     1A001 and reissue old numbers. Do not go live until this is resolved.');
  }

  // ── 5. collisions, then indexes ──
  head('5. Pre-index collision check (projected against the NEW key)');
  const billDupes = await findCollisions(
    Bill, { dateField: 'bill_date', numberField: 'bill_number', label: 'bills' }, codeOf);
  const payDupes = await findCollisions(
    Payment, { dateField: 'date', numberField: 'receipt_number', label: 'payments' }, codeOf);
  if (!billDupes && !payDupes) log('  the unique indexes can be built');

  head('6. Index swap');
  if (DRY) {
    log('  would run Bill.syncIndexes() and Payment.syncIndexes(), which will:');
    log('    DROP   bill_number_1 (unique)        ADD  account_code_1_financial_year_1_bill_number_1 (unique)');
    log('    DROP   receipt_number_1 (unique)     ADD  account_code_1_financial_year_1_receipt_number_1 (unique)');
  } else if (billDupes || payDupes) {
    log('  SKIPPED — resolve the collisions above first, then re-run.');
  } else {
    const bDropped = await Bill.syncIndexes();
    const pDropped = await Payment.syncIndexes();
    await Counter.syncIndexes();
    log(`  Bill    dropped: ${JSON.stringify(bDropped)}`);
    log(`  Payment dropped: ${JSON.stringify(pDropped)}`);
    log('  Counter indexes synced');
  }

  // ── 7. verification ──
  head('7. Verification');
  const checks = [
    ['users without account_code', await User.countDocuments({ account_code: { $in: [null, ''] } })],
    ['bills without account_code', await Bill.countDocuments({ account_code: { $in: [null, ''] } })],
    ['bills without financial_year', await Bill.countDocuments({ financial_year: { $in: [null, ''] } })],
    ['bills without bill_uid', await Bill.countDocuments({ bill_uid: { $in: [null, ''] } })],
    ['payments without account_code', await Payment.countDocuments({ account_code: { $in: [null, ''] } })],
    ['payments without financial_year', await Payment.countDocuments({ financial_year: { $in: [null, ''] } })],
    ['payments without receipt_uid', await Payment.countDocuments({ receipt_uid: { $in: [null, ''] } })]
  ];
  checks.forEach(([label, n]) => log(`  ${n === 0 ? 'OK  ' : 'TODO'}  ${label}: ${n}`));

  const remaining = checks.reduce((a, [, n]) => a + n, 0);
  log('');
  if (DRY) log(`DRY RUN complete. ${b.written} bill(s) and ${p.written} payment(s) would be updated.`);
  else if (remaining === 0) log('MIGRATION COMPLETE — every document carries its numbering identity.');
  else log(`INCOMPLETE — ${remaining} field(s) still unset. Re-run, or investigate the skips above.`);

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
