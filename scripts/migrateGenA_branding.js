// Phase GEN-A — seed the letterhead that used to be hardcoded in the print template.
//
// Until now the challan/holding-statement letterhead lived as literal strings inside
// printHeaderBox() in the frontend. GEN-A moves it into BusinessProfile so a future client can set
// their own. This script writes Guru Industries' CURRENT values in, so the printed output matches
// what the hardcoded template produced.
//
// Scope: ONE user (default gurugases@yahoo.com, override with EMAIL=...). Deliberately NOT
// "every user" — stamping this identity onto the other accounts is exactly the leak GEN-A exists
// to prevent.
//
// Touches ONLY the businessprofiles collection — ONE document. It never reads or writes a
// cylinder, customer, bill, history or payment record, and it does not touch locationprofiles:
// the printed contact lines live on BusinessProfile, separate from each site's own contact number.
//
// Everything here can also just be typed into Settings → Business Information by hand; this script
// only exists so the same values can be applied reproducibly.
//
//   DRY=1 node scripts/migrateGenA_branding.js          report only, writes nothing
//   node scripts/migrateGenA_branding.js                fills BLANK fields only
//   OVERWRITE=1 node scripts/migrateGenA_branding.js    also replaces non-blank fields that differ
//
// Idempotent: re-running once applied is a no-op.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const User = require('../models/User');
const BusinessProfile = require('../models/BusinessProfile');

const DRY = process.env.DRY === '1';
const OVERWRITE = process.env.OVERWRITE === '1';
const EMAIL = (process.env.EMAIL || 'gurugases@yahoo.com').toLowerCase();

// The exact strings the hardcoded template printed. The ampersand is stored raw — the print
// template HTML-escapes on render, so storing an escaped entity here would print it literally.
const BUSINESS = {
  business_name: 'GURU Industries',
  business_address: 'Plot No.: 114/47, Chandisar G.I.D.C., Palanpur-385 001. (B.K.) Gujarat.',
  gst_number: '24AAJFG7415N1Z3',
  certification_line: 'ISO 9001:2015 Certified Company',
  business_email: 'gurugases@yahoo.com',
  products_line: 'Mfg.: Industrial & Medical Oxygen, CO2, Nitrogen, Argon etc gases.'
};

// The letterhead contact box: one entry per printed block, each rendered exactly as typed — which
// is what lets Chandisar carry two numbers and keeps the old short labels ("Chandisar:", not
// "Chandisar Plant:") without the template inventing any formatting of its own.
const CONTACT_LINES = [
  'Chandisar: M 7600076251, 7600076254',
  'Palanpur: M 7600076255',
  'Chaapi: M 9624650959'
];

const LOGO_PATH = path.join(__dirname, '..', '..', 'CylinderProFrontend', 'public', 'guru-logo.png');

const show = (v) => (v === '' || v === undefined || v === null) ? '(blank)' : JSON.stringify(v);
const shown = (field, v) => field === 'logo'
  ? (v ? 'data URL (' + v.length + ' chars)' : '(blank)')
  : show(v);

(async () => {
  await connectDB();

  const user = await User.findOne({ email: EMAIL }).select('_id email');
  if (!user) {
    console.error('No user with email ' + EMAIL + ' — nothing done.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log('Target user: ' + user.email + ' (' + user._id + ')');
  if (DRY) console.log('\n*** DRY RUN — nothing will be written ***');

  // ── logo → data URL ──
  let logoDataUrl = '';
  try {
    logoDataUrl = 'data:image/png;base64,' + fs.readFileSync(LOGO_PATH).toString('base64');
    console.log('\nLogo source: ' + LOGO_PATH + ' -> data URL (' + logoDataUrl.length + ' chars)');
  } catch (e) {
    console.error('\nLogo NOT read (' + e.message + ') — the logo field will be left as-is.');
  }

  const target = Object.assign({}, BUSINESS);
  if (logoDataUrl) target.logo = logoDataUrl;

  const bp = (await BusinessProfile.findOne({ user_id: user._id })) || {};
  if (!bp._id) console.log('\nBusinessProfile: none exists — it will be created.');

  const set = {};
  const conflicts = [];

  // ── scalar fields ──
  console.log('\n── BusinessProfile ──');
  for (const field of Object.keys(target)) {
    const want = target[field];
    const have = (bp[field] === undefined || bp[field] === null) ? '' : String(bp[field]);
    if (have === want) { console.log('  = ' + field + ': unchanged'); continue; }
    if (have === '') {
      set[field] = want;
      console.log('  + ' + field + ': (blank) -> ' + shown(field, want));
    } else {
      conflicts.push(field);
      console.log('  ! ' + field + (OVERWRITE ? ': OVERWRITE' : ': CONFLICT — left alone (OVERWRITE=1 to replace)'));
      console.log('      stored: ' + shown(field, have));
      console.log('      target: ' + shown(field, want));
      if (OVERWRITE) set[field] = want;
    }
  }

  // ── contact_lines (array) ──
  console.log('\n── contact_lines ──');
  const have = Array.isArray(bp.contact_lines) ? bp.contact_lines.map(String) : [];
  const same = have.length === CONTACT_LINES.length && have.every((v, i) => v === CONTACT_LINES[i]);
  if (same) {
    console.log('  = contact_lines: unchanged');
  } else if (!have.length) {
    set.contact_lines = CONTACT_LINES;
    console.log('  + contact_lines: (empty) ->');
    CONTACT_LINES.forEach(l => console.log('      ' + show(l)));
  } else {
    conflicts.push('contact_lines');
    console.log('  ! contact_lines' + (OVERWRITE ? ': OVERWRITE' : ': CONFLICT — left alone (OVERWRITE=1 to replace)'));
    console.log('      stored:');
    have.forEach(l => console.log('        ' + show(l)));
    console.log('      target:');
    CONTACT_LINES.forEach(l => console.log('        ' + show(l)));
    if (OVERWRITE) set.contact_lines = CONTACT_LINES;
  }

  // ── apply ──
  const n = Object.keys(set).length;
  console.log('\nPlanned writes: ' + n + ' BusinessProfile field(s). No other collection is touched.');
  if (conflicts.length && !OVERWRITE) {
    console.log('\n' + conflicts.length + ' CONFLICT(S) left untouched. The printed letterhead will NOT match');
    console.log('the old hardcoded template until these are resolved — re-run with OVERWRITE=1,');
    console.log('or just type them into Settings > Business Information:');
    conflicts.forEach(c => console.log('   - ' + c));
  }

  if (DRY) {
    console.log('\n(DRY run — no changes written.)');
  } else if (!n) {
    console.log('\nNothing to do — already applied.');
  } else {
    await BusinessProfile.updateOne(
      { user_id: user._id },
      { $set: set, $setOnInsert: { user_id: user._id } },
      { upsert: true }
    );
    console.log('\nWritten.');
  }

  // ── read back and show the letterhead exactly as it will print ──
  const after = await BusinessProfile.findOne({ user_id: user._id });
  console.log('\n── Letterhead as it will print now ──');
  console.log('  logo              : ' + (after && after.logo ? 'SET (' + after.logo.length + ' chars) at ' + ((after.logo_scale) || 100) + '%' : '(none — logo column omitted)'));
  ['business_name', 'gst_number', 'certification_line', 'business_address'].forEach(f =>
    console.log('  ' + f.padEnd(18) + ': ' + show(after && after[f])));
  ((after && after.contact_lines) || []).forEach((l, i) =>
    console.log('  ' + ('contact ' + (i + 1)).padEnd(18) + ': ' + show(l)));
  ['business_email', 'products_line'].forEach(f =>
    console.log('  ' + f.padEnd(18) + ': ' + show(after && after[f])));

  await mongoose.disconnect();
})();
