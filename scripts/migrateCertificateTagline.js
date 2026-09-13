// Give the Quality Certificate its own tagline field, seeded from what it prints today.
//
//   DRY=1 node -r dotenv/config scripts/migrateCertificateTagline.js        report only, writes nothing
//   CONFIRM=YES node -r dotenv/config scripts/migrateCertificateTagline.js  apply
//
// WHY. The certificate's letterhead used to print `products_lines` on its right — the same lines the
// challan prints under its header box. Rewording one silently reworded the other. The certificate
// now reads `certificate_tagline_lines` only, with no fallback (a fallback would re-couple them).
//
// Without this script, an account whose certificate prints a tagline today would print none after
// the deploy. This copies each account's current products_lines into the new field ONCE, so the
// certificate looks exactly as it did; from then on the two are edited independently.
//
// Touches ONLY the businessprofiles collection, and only the certificate_tagline_lines field on it.
// products_lines is read, never written. An account that already has any certificate tagline line
// is left alone, so the script is safe to run twice.
//
// An EMPTY array is treated as not-yet-copied, not as a deliberate blank: the new Settings form
// posts the whole business card, so saving Business Info before this runs would store [] and would
// otherwise make the script skip the one account it exists for. Run it once, straight after the
// backend deploy; after that, a certificate tagline cleared in Settings is never refilled because
// nobody runs this again.
const mongoose = require('mongoose');

const DRY = !!process.env.DRY;
if (!DRY && process.env.CONFIRM !== 'YES') {
  console.error('Nothing written. Re-run with CONFIRM=YES (or DRY=1 to see the plan).');
  process.exit(1);
}

// What the certificate printed before this change: products_lines, else the superseded single
// string (the same resolve-at-read rule profile.service applied), blank entries dropped.
function printedToday(p) {
  const arr = Array.isArray(p.products_lines) && p.products_lines.length
    ? p.products_lines
    : (p.products_line ? [p.products_line] : []);
  return arr.map(v => String(v == null ? '' : v)).filter(v => v.trim());
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cylinder_management');
  const BusinessProfile = require('../models/BusinessProfile');
  const User = require('../models/User');

  if (DRY) console.log('*** DRY RUN — nothing will be written ***\n');

  // The raw collection, not the model, so what is printed in the report is what is stored.
  const profiles = await BusinessProfile.collection.find({}).toArray();
  console.log('Business profiles: ' + profiles.length + '\n');

  let planned = 0, already = 0, nothing = 0;
  const plan = [];
  for (const p of profiles) {
    const user = await User.findById(p.user_id).select('email').lean();
    const who = (user && user.email) || String(p.user_id);

    const own = Array.isArray(p.certificate_tagline_lines)
      ? p.certificate_tagline_lines.filter(v => String(v || '').trim()) : [];
    if (own.length) {
      already++;
      console.log('  =  ' + who + ': already has its own certificate tagline — left alone');
      continue;
    }
    const lines = printedToday(p);
    if (!lines.length) {
      nothing++;
      console.log('  ·  ' + who + ': certificate prints no tagline today — nothing to copy');
      continue;
    }
    planned++;
    plan.push({ _id: p._id, lines });
    console.log('  +  ' + who + ': certificate_tagline_lines -> ' + JSON.stringify(lines));
    if (!DRY) {
      await BusinessProfile.collection.updateOne({ _id: p._id }, { $set: { certificate_tagline_lines: lines } });
    }
  }

  console.log('\n' + (DRY ? 'WOULD COPY: ' : 'COPIED: ') + planned
    + '   already separate: ' + already + '   nothing to copy: ' + nothing);

  if (!DRY && planned) {
    let ok = 0;
    for (const { _id, lines } of plan) {
      const back = await BusinessProfile.collection.findOne({ _id }, { projection: { certificate_tagline_lines: 1 } });
      if (JSON.stringify(back.certificate_tagline_lines) === JSON.stringify(lines)) ok++;
    }
    console.log('Read back identical for ' + ok + ' of ' + planned + '.');
    process.exitCode = ok === planned ? 0 : 1;
  }

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED: ' + (e && e.message ? e.message : e)); process.exit(1); });
