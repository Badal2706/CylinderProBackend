// One-off: wipe all TRANSACTIONAL test data before fresh Excel onboarding.
//
//   node scripts/wipeTestData.js
//
// 1. Takes a mongodump backup of the FULL database first (aborts if the backup fails).
//    MongoDB runs in the `gas-cylinder-mongo` Docker container, so mongodump is executed
//    inside the container and the archive is copied out to ./backups/.
// 2. Deletes every document in Customers, Cylinders, Bills, Payments — and NOTHING else.
//    User, GasType, CylinderSize, BusinessProfile are left untouched.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Customer = require('../models/Customer');
const Cylinder = require('../models/Cylinder');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const RentalCharge = require('../models/RentalCharge');

const MONGO_CONTAINER = process.env.MONGO_CONTAINER || 'gas-cylinder-mongo';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';

async function main() {
  // ─── 1. Backup (full DB) — must succeed before anything is deleted ───
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const localArchive = path.join(backupDir, `pre-wipe-${stamp}.archive.gz`);
  const containerArchive = `/tmp/pre-wipe-${stamp}.archive.gz`;

  console.log(`Backing up full database via docker exec ${MONGO_CONTAINER} mongodump ...`);
  execSync(`docker exec ${MONGO_CONTAINER} mongodump --archive=${containerArchive} --gzip`, { stdio: 'inherit' });
  execSync(`docker cp ${MONGO_CONTAINER}:${containerArchive} "${localArchive}"`, { stdio: 'inherit' });
  execSync(`docker exec ${MONGO_CONTAINER} rm ${containerArchive}`, { stdio: 'inherit' });

  const stat = fs.statSync(localArchive); // throws if the file doesn't exist
  if (!stat.size) throw new Error('Backup archive is empty — aborting wipe.');
  console.log(`Backup OK: ${localArchive} (${stat.size} bytes)`);

  // ─── 2. Wipe transactional collections ONLY ───
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to ${MONGODB_URI}`);

  const results = {
    customers: await Customer.deleteMany({}),
    cylinders: await Cylinder.deleteMany({}),
    bills: await Bill.deleteMany({}),
    payments: await Payment.deleteMany({}),
    rentalcharges: await RentalCharge.deleteMany({})
  };
  for (const [name, r] of Object.entries(results)) {
    console.log(`Deleted ${r.deletedCount} ${name}`);
  }

  await mongoose.disconnect();
  console.log('Done. User, GasType, CylinderSize, BusinessProfile were not touched.');
}

main().catch(err => {
  console.error('WIPE ABORTED:', err.message);
  process.exit(1);
});
