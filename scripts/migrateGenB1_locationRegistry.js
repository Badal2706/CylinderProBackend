// Phase GEN-B1 — turn LocationProfile into the authoritative location registry.
//
// Before this, "which locations exist" came from a 3-entry array in config/locations.js, their
// names from a LOCATION_LABELS map, and "which site fills" from the literal 'AT_PLANT_CHANDISAR'
// hardcoded in five separate places. This script moves all three facts onto the records
// themselves, so nothing at runtime has to consult the config array.
//
// Writes ONLY the locationprofiles collection, and only two fields on it (`label`,
// `is_filling_location`). It never reads or writes a cylinder, customer, bill, payment or history
// record, and never touches `location`, `manager_name`, `contact_number` or `challan_prefix`.
//
//   DRY=1 node scripts/migrateGenB1_locationRegistry.js    report only, writes nothing
//   node scripts/migrateGenB1_locationRegistry.js          apply
//
// Idempotent: only fills fields that are currently UNSET, so an explicit choice made later is
// never overwritten, and a second run is a no-op.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const User = require('../models/User');
const LocationProfile = require('../models/LocationProfile');
const { LOCATION_LABELS } = require('../config/locations');

const DRY = process.env.DRY === '1';
const FILLING_SITE = 'AT_PLANT_CHANDISAR';   // the historical anchor, seeded onto existing data

(async () => {
  await connectDB();
  if (DRY) console.log('*** DRY RUN — nothing will be written ***\n');

  // Read raw so a missing required `label` cannot fail Mongoose validation before we set it.
  const coll = mongoose.connection.db.collection('locationprofiles');
  const users = await User.find({}).select('_id email').lean();
  console.log(`Users: ${users.length}\n`);

  let labelWrites = 0, fillingWrites = 0;

  for (const u of users) {
    const profiles = await coll.find({ user_id: u._id }).toArray();
    console.log(`── ${u.email} — ${profiles.length} location(s) ──`);

    for (const p of profiles) {
      const ops = {};

      // 1. label ← the old static map, only when unset.
      if (p.label === undefined || p.label === null || String(p.label).trim() === '') {
        const label = LOCATION_LABELS[p.location] || p.location;
        ops.label = label;
        console.log(`   + ${p.location}: label -> ${JSON.stringify(label)}`);
      } else {
        console.log(`   = ${p.location}: label already ${JSON.stringify(p.label)}`);
      }

      // 2. is_filling_location ← true for the historical filling site, only when unset.
      //    An explicit false stays false; this must never flip a deliberate choice.
      if (p.is_filling_location === undefined || p.is_filling_location === null) {
        const val = p.location === FILLING_SITE;
        ops.is_filling_location = val;
        if (val) console.log(`   + ${p.location}: is_filling_location -> true  (the filling site)`);
        else console.log(`   + ${p.location}: is_filling_location -> false`);
      } else {
        console.log(`   = ${p.location}: is_filling_location already ${p.is_filling_location}`);
      }

      if (Object.keys(ops).length && !DRY) {
        await coll.updateOne({ _id: p._id }, { $set: ops });
      }
      if (ops.label !== undefined) labelWrites++;
      if (ops.is_filling_location !== undefined) fillingWrites++;
    }
    console.log('');
  }

  console.log(`${DRY ? 'Would write' : 'Wrote'}: ${labelWrites} label(s), ${fillingWrites} is_filling_location flag(s).`);

  // ── Build the partial unique index that enforces "at most one filling location per user" ──
  if (!DRY) {
    try {
      await LocationProfile.syncIndexes();
      console.log('Indexes synced (partial unique index on is_filling_location is in place).');
    } catch (e) {
      console.error('Index sync FAILED: ' + e.message);
      console.error('If this is a duplicate-key error, a user already has two filling locations — fix that first.');
    }
  }

  // ── Verify: exactly one filling location per user, and every profile has a label ──
  console.log('\n── Verification ──');
  if (DRY) console.log('  (DRY: nothing was written, so this reflects the state BEFORE migration.)');
  let bad = 0;
  for (const u of users) {
    const profiles = await coll.find({ user_id: u._id }).toArray();
    const filling = profiles.filter(p => p.is_filling_location === true);
    const unlabelled = profiles.filter(p => !p.label || !String(p.label).trim());
    const names = filling.map(p => p.location).join(', ') || '(none)';

    if (filling.length === 1) {
      console.log(`  OK   ${u.email}: filling location = ${names}`);
    } else if (filling.length === 0) {
      console.log(`  WARN ${u.email}: NO filling location — transfers will stay unclassified`);
      bad++;
    } else {
      console.log(`  FAIL ${u.email}: ${filling.length} filling locations (${names}) — must be at most 1`);
      bad++;
    }
    if (unlabelled.length) {
      console.log(`  FAIL ${u.email}: ${unlabelled.length} location(s) with no label: ${unlabelled.map(p => p.location).join(', ')}`);
      bad++;
    }
  }
  console.log(bad === 0 ? '\nAll users verified.' : `\n${bad} problem(s) found above.`);
  if (DRY) console.log('\n(DRY run — no changes written.)');

  await mongoose.disconnect();
})();
