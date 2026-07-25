// Phase 2 migration:
//   1. Seed 3 LocationProfile records (Chandisar / Palanpur / Chhapi) for EVERY user
//      with empty manager/contact/prefix fields (existing records untouched).
//   2. Set active_location = AT_PLANT_CHANDISAR on every user that doesn't have one.
//
//   node scripts/migratePhase2.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../models/User');
const LocationProfile = require('../models/LocationProfile');
const { LOCATIONS } = require('../config/locations');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to ${MONGODB_URI}`);

  const users = await User.find({}, { _id: 1 });
  let created = 0;
  for (const u of users) {
    for (const location of LOCATIONS) {
      const r = await LocationProfile.updateOne(
        { user_id: u._id, location },
        { $setOnInsert: { user_id: u._id, location, manager_name: '', contact_number: '', challan_prefix: '' } },
        { upsert: true }
      );
      if (r.upsertedCount) created++;
    }
  }
  console.log(`LocationProfiles: created ${created} (users: ${users.length} × ${LOCATIONS.length} sites)`);

  const r = await User.updateMany(
    { active_location: { $exists: false } },
    { $set: { active_location: 'AT_PLANT_CHANDISAR' } }
  );
  console.log(`Users given default active_location: ${r.modifiedCount}`);

  await mongoose.disconnect();
  console.log('Migration done.');
}

main().catch(err => { console.error('MIGRATION FAILED:', err.message); process.exit(1); });
