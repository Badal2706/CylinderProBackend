// Move the letterhead's trading line from one string onto an ordered array.
//
//   DRY=1 node -r dotenv/config scripts/migrateProductsLines.js        report only, writes nothing
//   CONFIRM=YES node -r dotenv/config scripts/migrateProductsLines.js  apply
//
// WHY. `products_line` was a single string, so a business could print one trading line and no
// more. It is now `products_lines`, an ordered array edited in Settings the same way the printed
// contact lines already are — add and remove lines freely, each printing on its own line.
//
// This copies each account's existing string in as entry one, so nothing that prints today stops
// printing. NO DATA IS LOST: the old `products_line` field is left exactly as it is, and the
// service still falls back to it for any account this has not been run against — so the letterhead
// is correct whether or not this ever runs. That fallback is also what makes the migration safe to
// run late, or twice.
//
// Touches ONLY the businessprofiles collection, and only the products_lines field on it. It never
// reads or writes a cylinder, customer, bill, payment, certificate or history record.
const mongoose = require('mongoose');

const DRY = !!process.env.DRY;
if (!DRY && process.env.CONFIRM !== 'YES') {
  console.error('Nothing written. Re-run with CONFIRM=YES (or DRY=1 to see the plan).');
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cylinder_management');
  const BusinessProfile = require('../models/BusinessProfile');
  const User = require('../models/User');

  if (DRY) console.log('*** DRY RUN — nothing will be written ***\n');

  const profiles = await BusinessProfile.find({}).lean();
  console.log('Business profiles: ' + profiles.length + '\n');

  let planned = 0, already = 0, nothing = 0;
  for (const p of profiles) {
    const user = await User.findById(p.user_id).select('email').lean();
    const who = (user && user.email) || String(p.user_id);
    const existing = Array.isArray(p.products_lines) ? p.products_lines.filter(v => String(v || '').trim()) : [];
    const old = String(p.products_line || '').trim();

    if (existing.length) {
      already++;
      console.log('  =  ' + who + ': already has ' + existing.length + ' line(s) — left alone');
      continue;
    }
    if (!old) {
      nothing++;
      console.log('  ·  ' + who + ': no trading line set — nothing to move');
      continue;
    }
    planned++;
    console.log('  +  ' + who + ': products_lines -> ["' + old + '"]');
    if (!DRY) {
      await BusinessProfile.updateOne({ _id: p._id }, { $set: { products_lines: [old] } });
    }
  }

  console.log('\n' + (DRY ? 'WOULD MOVE: ' : 'MOVED: ') + planned
    + '   already migrated: ' + already + '   nothing to move: ' + nothing);

  if (!DRY && planned) {
    // Read back rather than trust the write — the whole point of the migration is that the
    // letterhead keeps printing what it printed yesterday.
    let ok = 0;
    for (const p of profiles) {
      const back = await BusinessProfile.findById(p._id).select('products_line products_lines').lean();
      const old = String(p.products_line || '').trim();
      if (!old) continue;
      if (Array.isArray(back.products_lines) && back.products_lines[0] === old) ok++;
    }
    console.log('Read back identical for ' + ok + ' of ' + planned + '.');
    process.exitCode = ok === planned ? 0 : 1;
  }

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED: ' + (e && e.message ? e.message : e)); process.exit(1); });
