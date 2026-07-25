// Phase 21 one-time correction: the login email (User.email_verified) and the bootstrap
// Trusted Person entry track the SAME address but were verified through separate paths, so
// the two flags could drift apart. This pass REPORTS every drifted account first, then
// reconciles: if either flag says the address was verified, both are set verified (it is the
// same address — one successful OTP proves ownership regardless of which path delivered it).
// Run from CylinderProBackend: node scripts/migratePhase21.js
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management');
  const db = mongoose.connection.db;
  const users = await db.collection('users').find({}, { projection: { email: 1, email_verified: 1 } }).toArray();

  const drifted = [];
  for (const u of users) {
    const boot = await db.collection('trustedpeople').findOne({ user_id: u._id, is_bootstrap: true });
    if (!boot || boot.email !== u.email) continue; // different address = nothing to reconcile
    if (!!boot.email_verified !== !!u.email_verified) {
      drifted.push({ user: u, boot });
    }
  }

  console.log(`Scanned ${users.length} account(s).`);
  if (!drifted.length) {
    console.log('No drifted verification flags found — nothing to correct.');
  } else {
    console.log(`\nDrift report (${drifted.length} account(s)) — BEFORE applying:`);
    for (const { user, boot } of drifted) {
      console.log(`  ${user.email}: User.email_verified=${!!user.email_verified}, bootstrap TrustedPerson.email_verified=${!!boot.email_verified}`);
    }
    console.log('\nApplying: either-verified wins (same address, one OTP proves ownership)…');
    for (const { user, boot } of drifted) {
      const verified = !!user.email_verified || !!boot.email_verified;
      await db.collection('users').updateOne({ _id: user._id }, { $set: { email_verified: verified } });
      const set = { email_verified: verified };
      if (verified) set.is_active = true;
      await db.collection('trustedpeople').updateOne({ _id: boot._id }, { $set: set });
      console.log(`  ${user.email}: both flags → ${verified}`);
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
})().catch(e => { console.error('MIGRATION ERROR:', e); process.exit(1); });
