// Delete leftover sign-up accounts that own NO business data.
//
// Two accounts were created on 25 Jul 2026 while the system was being set up, before the real
// account (31 Jul). Neither has ever been used. They still hold open JWT sessions, so removing
// them closes a way in that nobody is watching.
//
// SAFETY GATE: an account is deleted only if it owns ZERO cylinders, customers, bills, payments,
// history rows, filling-log entries and rental charges. If any count is non-zero the account is
// skipped and reported — this script can never delete an account with real data in it, whatever
// email is passed to it.
//
//   DRY=1 node scripts/deleteEmptyAccounts.js      report only, deletes nothing
//   node scripts/deleteEmptyAccounts.js            delete the accounts that pass the gate
//   EMAILS=a@b.com,c@d.com node scripts/...        override the target list
//
// Deletes the same collections as the in-app "Delete Account" flow (profile.service.deleteAccount),
// plus cylinderhistories so no orphan rows are left behind.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');

const DRY = process.env.DRY === '1';
const EMAILS = (process.env.EMAILS || 'bhavikpatel773241@gmail.com,patel@gmail.com')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Any non-zero count here blocks the delete.
const BUSINESS_DATA = [
  'cylinders', 'customers', 'bills', 'payments',
  'cylinderhistories', 'fillinglogentries', 'rentalcharges'
];
// Owned records with no business meaning — removed along with the account.
const OWNED = [
  'businessprofiles', 'locationprofiles', 'trustedpeople',
  'otptokens', 'auditlogs', 'locationpcstocks'
];

(async () => {
  await connectDB();
  const db = mongoose.connection.db;
  if (DRY) console.log('*** DRY RUN — nothing will be deleted ***\n');

  let deleted = 0, skipped = 0;
  for (const email of EMAILS) {
    const user = await db.collection('users').findOne({ email });
    if (!user) { console.log(`- ${email}: no such user — skipped.`); continue; }

    console.log(`\n=== ${user.name} <${user.email}> ===`);
    console.log(`  _id        : ${user._id}`);
    console.log(`  created    : ${user.createdAt && user.createdAt.toISOString()}`);
    console.log(`  last_login : ${user.last_login ? user.last_login.toISOString() : 'NEVER'}`);
    console.log(`  sessions   : ${(user.sessions || []).length}`);

    // ── safety gate ──
    const blocking = [];
    for (const c of BUSINESS_DATA) {
      const n = await db.collection(c).countDocuments({ user_id: user._id });
      if (n > 0) blocking.push(`${c}=${n}`);
    }
    if (blocking.length) {
      console.log(`  REFUSED — this account owns real data: ${blocking.join(', ')}`);
      skipped++;
      continue;
    }
    console.log(`  gate       : PASS — owns no cylinders, customers, bills, payments or history`);

    const toRemove = [];
    for (const c of OWNED) {
      const n = await db.collection(c).countDocuments({ user_id: user._id });
      if (n > 0) toRemove.push([c, n]);
    }
    console.log(`  will remove: ${toRemove.length ? toRemove.map(([c, n]) => `${c}=${n}`).join(', ') : 'nothing but the user record'}, users=1`);

    if (DRY) { deleted++; continue; }
    for (const [c] of toRemove) await db.collection(c).deleteMany({ user_id: user._id });
    await db.collection('users').deleteOne({ _id: user._id });
    console.log('  DELETED.');
    deleted++;
  }

  console.log(`\n${DRY ? 'Would delete' : 'Deleted'}: ${deleted}   Skipped/refused: ${skipped}`);
  const left = await db.collection('users').find({}, { projection: { email: 1, name: 1 } }).toArray();
  console.log(`\nAccounts remaining (${left.length}):`);
  left.forEach(u => console.log(`  - ${u.name} <${u.email}>`));
  if (DRY) console.log('\n(DRY run — nothing was deleted.)');

  await mongoose.disconnect();
})();
