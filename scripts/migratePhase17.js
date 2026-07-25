// Phase 17 migration:
//   1. Update the account owner's login email → patelbadal276@gmail.com
//   2. Create the bootstrap TrustedPerson record (the owner themselves, active + verified)
// Touches NOTHING else — bills/customers/cylinders are keyed by user _id, which is unchanged.
//
// Run from CylinderProBackend:  node scripts/migratePhase17.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const TrustedPerson = require('../models/TrustedPerson');

const OLD_EMAIL = 'demo@cylinderpro.com';
const NEW_EMAIL = 'patelbadal276@gmail.com';

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management');

  const clash = await User.findOne({ email: NEW_EMAIL });
  let owner;
  if (clash) {
    console.log(`User with ${NEW_EMAIL} already exists (${clash._id}) — treating as already migrated.`);
    owner = clash;
  } else {
    owner = await User.findOne({ email: OLD_EMAIL });
    if (!owner) {
      console.error(`No user found with ${OLD_EMAIL} — nothing migrated.`);
      process.exit(1);
    }
    // updateOne (not save) so the password hook never runs.
    await User.updateOne({ _id: owner._id }, { email: NEW_EMAIL });
    console.log(`Owner ${owner._id} email: ${OLD_EMAIL} → ${NEW_EMAIL}`);
    owner.email = NEW_EMAIL;
  }

  const existing = await TrustedPerson.findOne({ user_id: owner._id, email: NEW_EMAIL });
  if (existing) {
    console.log(`Bootstrap TrustedPerson already exists (${existing._id}).`);
  } else {
    const tp = await TrustedPerson.create({
      user_id: owner._id,
      name: owner.name,
      email: NEW_EMAIL,
      email_verified: true, // the owner's own login email, verified as part of this setup
      is_active: true
    });
    console.log(`Bootstrap TrustedPerson created: ${tp._id} (${tp.name} <${tp.email}>)`);
  }

  const counts = {};
  for (const c of ['customers', 'bills', 'cylinders', 'payments']) {
    counts[c] = await mongoose.connection.db.collection(c).countDocuments({ user_id: owner._id });
  }
  console.log('Owner data untouched:', JSON.stringify(counts));
  await mongoose.disconnect();
  console.log('Phase 17 migration done.');
})().catch(e => { console.error('MIGRATION ERROR:', e); process.exit(1); });
