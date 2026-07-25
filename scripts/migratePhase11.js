// Phase 11 migration:
//   1. Default is_filling_vendor = false on every existing customer missing the flag.
//   2. Rebuild per-location PC stock for every user from their bill line items (creates the
//      LocationPcStock records; with no PC movements recorded yet this yields an empty —
//      i.e. all-zero — stock, which the API reports as 0 for any location/gas/size).
//
//   node scripts/migratePhase11.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../models/User');
const Customer = require('../models/Customer');
const { recomputeLocationPcStock } = require('../services/pcStock.service');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to ${MONGODB_URI}`);

  const r = await Customer.updateMany(
    { is_filling_vendor: { $exists: false } },
    { $set: { is_filling_vendor: false } }
  );
  console.log(`Customers defaulted to is_filling_vendor=false: ${r.modifiedCount}`);

  const users = await User.find({}, { _id: 1 });
  for (const u of users) await recomputeLocationPcStock(u._id);
  console.log(`PC stock rebuilt for ${users.length} user(s)`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
