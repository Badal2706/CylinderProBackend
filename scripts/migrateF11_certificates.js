// F-11 — seed the two BusinessProfile fields the Purity Test Certificate adds.
//
//   certificate_prefix   the series prefix, e.g. "GI" -> "GI/TC/2026-27/1"
//   footer_contact_line  the contact line printed under the business name in the signature block
//
// Scope: ONE user, named with EMAIL=... (required). Deliberately not "every
// user" — stamping one client's certificate prefix onto another account is exactly the leak that
// GEN-A's blank defaults exist to prevent.
//
// Touches ONLY the businessprofiles collection — ONE document, TWO fields. It never reads or
// writes a cylinder, customer, bill, payment, certificate or history record.
//
// Both values can equally well just be typed into Settings -> Business Information by hand; this
// script exists so the same values can be applied reproducibly, and so a fresh environment can be
// brought to the same state without anyone remembering what to type.
//
//   DRY=1 node scripts/migrateF11_certificates.js                    report only, writes nothing
//   PREFIX=GI node scripts/migrateF11_certificates.js                fills BLANK fields only
//   PREFIX=GI OVERWRITE=1 node scripts/migrateF11_certificates.js    also replaces differing values
//
// PREFIX is REQUIRED and has no built-in default. A certificate number is a business identity
// that goes on a document handed to a customer; guessing one here and having it silently appear
// on real certificates would be worse than leaving it blank. Blank is a fully supported setting —
// the prefix segment is simply dropped, giving "TC/2026-27/1".
//
// FOOTER defaults to the account's existing business_phone, which is the value this line carries
// on the sample layout. Override with FOOTER="..." for anything else.
//
// Idempotent: re-running once applied is a no-op.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const User = require('../models/User');
const BusinessProfile = require('../models/BusinessProfile');

const DRY = process.env.DRY === '1';
const OVERWRITE = process.env.OVERWRITE === '1';
// The account to act on MUST be named explicitly. There is deliberately no default: a
// hardcoded address is a privacy leak in a published file, is wrong on every machine but one,
// and on a script that writes it is a way to hit the wrong account by simply forgetting.
const EMAIL = (process.env.EMAIL || '').trim().toLowerCase();
if (!EMAIL) {
  console.error('Name the account: EMAIL=you@example.com node ' + process.argv[1].split(/[\/]/).pop());
  process.exit(1);
}
const PREFIX = process.env.PREFIX;
const FOOTER = process.env.FOOTER;

const show = (v) => (v === '' || v === undefined || v === null) ? '(blank)' : JSON.stringify(v);

(async () => {
  await connectDB();

  const user = await User.findOne({ email: EMAIL }).select('_id email');
  if (!user) {
    console.error(`No user with email ${EMAIL} — nothing done.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Target user: ${user.email} (${user._id})`);
  if (DRY) console.log('\n*** DRY RUN — nothing will be written ***');

  const profile = await BusinessProfile.findOne({ user_id: user._id }).lean();
  if (!profile) {
    console.error('\nThis account has no business profile yet. Save Settings -> Business Information');
    console.error('once first, then re-run — this script sets two fields on an existing profile, it');
    console.error('does not create one.');
    await mongoose.disconnect();
    process.exit(1);
  }

  if (PREFIX === undefined) {
    console.error('\nPREFIX is required and has no default — see the note at the top of this file.');
    console.error('  PREFIX=GI node scripts/migrateF11_certificates.js');
    console.error('Pass PREFIX="" deliberately to set a blank prefix ("TC/2026-27/1").');
    await mongoose.disconnect();
    process.exit(1);
  }

  const wanted = {
    certificate_prefix: String(PREFIX).trim(),
    footer_contact_line: FOOTER !== undefined ? String(FOOTER) : (profile.business_phone || '')
  };

  const update = {};
  console.log('');
  for (const [field, next] of Object.entries(wanted)) {
    const current = profile[field] || '';
    if (current === next) {
      console.log(`  =  ${field.padEnd(21)} already ${show(current)}`);
    } else if (!current) {
      console.log(`  +  ${field.padEnd(21)} ${show(current)}  ->  ${show(next)}`);
      update[field] = next;
    } else if (OVERWRITE) {
      console.log(`  ~  ${field.padEnd(21)} ${show(current)}  ->  ${show(next)}   (OVERWRITE)`);
      update[field] = next;
    } else {
      console.log(`  !  ${field.padEnd(21)} keeping ${show(current)} (would set ${show(next)} — re-run with OVERWRITE=1)`);
    }
  }

  if (!Object.keys(update).length) {
    console.log('\nNothing to change.');
  } else if (DRY) {
    console.log(`\nDRY RUN — would update ${Object.keys(update).length} field(s).`);
  } else {
    await BusinessProfile.updateOne({ user_id: user._id }, { $set: update });
    console.log(`\nUpdated ${Object.keys(update).length} field(s).`);
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
