// Give every existing account a designated MAINTENANCE LOCATION (the workshop).
//
//   DRY=1 node scripts/migrateMaintenanceLocation.js       report only, writes nothing
//   CONFIRM=YES node scripts/migrateMaintenanceLocation.js  apply
//
// WHY. LocationProfile.is_maintenance_location is new. Until it is set, an account has the field
// on no record at all, and location.service falls back to the FILLING site — which is exactly what
// the rule used to be, so nothing breaks in the meantime. This makes that fallback explicit, so
// the flag can afterwards be moved independently of the filling site.
//
// WHAT IT PICKS, in order: the account's filling site; failing that, its first site. An account
// that already has a maintenance site is left completely alone.
//
// Safe to re-run. Writes at most one flag per account, and never clears one.
const mongoose = require('mongoose');

const DRY = !!process.env.DRY;
if (!DRY && process.env.CONFIRM !== 'YES') {
  console.error('Nothing written. Re-run with CONFIRM=YES (or DRY=1 to see the plan).');
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cylinder_management');
  const User = require('../models/User');
  const LocationProfile = require('../models/LocationProfile');

  // The partial unique index only exists once indexes are synced — same reason the GEN-B1
  // migration calls this. Without it the "one workshop per account" rule is code-only.
  await LocationProfile.syncIndexes();
  console.log('indexes synced\n');

  const users = await User.find({}, { name: 1, email: 1 }).lean();
  let set = 0, already = 0, noSites = 0;

  for (const u of users) {
    const profiles = await LocationProfile.find({ user_id: u._id }).lean();
    if (!profiles.length) {
      noSites++;
      console.log(`  --  ${u.email}: no locations yet — left alone (seeded on first use)`);
      continue;
    }
    const existing = profiles.find(p => p.is_maintenance_location);
    if (existing) {
      already++;
      console.log(`  ok  ${u.email}: already ${existing.label}`);
      continue;
    }
    const filling = profiles.find(p => p.is_filling_location);
    const pick = filling || profiles[0];
    const why = filling ? 'the filling site' : 'its only/first site';
    console.log(`  ${DRY ? '..' : '->'}  ${u.email}: ${pick.label}  (${why})`);
    if (!DRY) {
      await LocationProfile.updateOne({ _id: pick._id }, { $set: { is_maintenance_location: true } });
      set++;
    }
  }

  console.log(`\n${DRY ? 'WOULD SET' : 'SET'}: ${DRY ? users.length - already - noSites : set}` +
              `   already had one: ${already}   no locations: ${noSites}`);
  await mongoose.disconnect();
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
