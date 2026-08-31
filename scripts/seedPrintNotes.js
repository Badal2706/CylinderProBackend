// Move the challan's notes block out of the code and into the account's own settings.
//
//   DRY=1 EMAIL=you@example.com node -r dotenv/config scripts/seedPrintNotes.js
//   CONFIRM=YES EMAIL=you@example.com node -r dotenv/config scripts/seedPrintNotes.js
//
// WHY THIS EXISTS. Until now the Gujarati notes at the foot of every Delivery Challan were
// hardcoded in components.jsx — one client's trading terms compiled into the application. They are
// now free text on the BusinessProfile, blank by default, so a second client does not inherit
// Guru's terms. This copies the exact text that was in the code into THIS account's settings, so
// the printed challan looks identical the day the change ships and the proprietor can edit it
// afterwards without a developer.
//
// It refuses to overwrite notes that already exist: run it once, then edit in Settings.
const mongoose = require('mongoose');

// Named explicitly — the whole point is that these terms belong to one account, not to the code.
const EMAIL = (process.env.EMAIL || '').trim().toLowerCase();
if (!EMAIL) {
  console.error('Name the account: EMAIL=you@example.com node -r dotenv/config scripts/seedPrintNotes.js');
  process.exit(1);
}
const DRY = !!process.env.DRY;
if (!DRY && process.env.CONFIRM !== 'YES') {
  console.error('Nothing written. Re-run with CONFIRM=YES (or DRY=1 to see the plan).');
  process.exit(1);
}

// Verbatim from the removed block in components.jsx — including the "*" bullets, which were part
// of the printed text and are the proprietor's to change.
const HEADING = 'નોંધ:';
const BODY = [
  '* સિલિન્ડર રીટર્ન આપતી વખતે સિલિન્ડર ખરાબ અથવા ડેમેજ હશે તો તેનો ચાર્જ અલગથી લેવામાં આવશે.',
  '* ૧૦ દિવસ પછી સિલિન્ડરનું ભાડું આપવાનું રહેશે. (સિલિન્ડર દીઠ રૂ. ૧૦ પ્રતિ દિવસ)',
  '* સિલિન્ડર જમા કરાવ્યાના ૨ થી ૫ દિવસ પછી ડિપોઝિટ રિટર્ન મળશે.',
  '* કોઈપણ ગેસની વેલિડિટી ૩ મહિનાની હોય છે.'
].join('\n');
const FOOTER = [
  'First check the Goods and then take delivery.',
  'Subject to Palanpur Jurisdiction'
].join('\n');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cylinder_management');
  const User = require('../models/User');
  const BusinessProfile = require('../models/BusinessProfile');

  const user = await User.findOne({ email: EMAIL });
  if (!user) throw new Error('No account found for ' + EMAIL);

  let profile = await BusinessProfile.findOne({ user_id: user._id });
  if (!profile) {
    console.log('No business profile yet for ' + EMAIL + ' — it will be created.');
    if (!DRY) profile = new BusinessProfile({ user_id: user._id });
  }

  const existing = (profile && profile.print_notes) || {};
  const hasSomething = (existing.heading || '').trim() || (existing.body || '').trim() || (existing.footer || '').trim();
  if (hasSomething) {
    console.log('REFUSED: this account already has printed notes. Edit them in Settings instead of');
    console.log('re-seeding, or this would overwrite wording someone has already changed.\n');
    console.log('  heading: ' + JSON.stringify(existing.heading || ''));
    console.log('  body   : ' + (existing.body || '').split('\n').length + ' line(s)');
    process.exit(1);
  }

  console.log('Account : ' + user.email);
  console.log('heading : ' + HEADING);
  console.log('body    :');
  BODY.split('\n').forEach(l => console.log('          ' + l));
  console.log('footer  :');
  FOOTER.split('\n').forEach(l => console.log('          ' + l));
  console.log('show on : Delivery Challan only (exactly where it printed before)');

  if (DRY) { console.log('\nDRY RUN — nothing written.'); await mongoose.disconnect(); return; }

  profile.print_notes = {
    heading: HEADING,
    body: BODY,
    footer: FOOTER,
    // Only the challan: that is the one document this text has ever appeared on. Turning it on
    // anywhere else is a decision for the proprietor, made in Settings.
    show_on: { challan: true, holding_statement: false, purity_certificate: false, reports: false }
  };
  await profile.save();

  const back = await BusinessProfile.findOne({ user_id: user._id }).lean();
  const ok = back.print_notes && back.print_notes.body === BODY && back.print_notes.show_on.challan === true;
  console.log('\n' + (ok ? 'SAVED and read back identical.' : 'SAVED but the read-back did not match — check it.'));
  await mongoose.disconnect();
  process.exitCode = ok ? 0 : 1;
})().catch(e => { console.error('FAILED: ' + (e && e.message ? e.message : e)); process.exit(1); });
