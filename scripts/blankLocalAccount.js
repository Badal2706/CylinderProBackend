// Delete an account and every record belonging to it, on the LOCAL database, so the app can be
// signed up for again from scratch.
//
//   DRY=1 node scripts/blankLocalAccount.js                  report only, writes nothing
//   CONFIRM=DELETE node scripts/blankLocalAccount.js          actually delete
//   EMAIL=someone@example.com CONFIRM=DELETE node ...         a different account
//
// TWO SAFETY RAILS, both hard refusals rather than warnings:
//
//   1. LOCAL ONLY. It refuses outright unless MONGODB_URI points at localhost/127.0.0.1. This
//      script's entire job is to destroy an account; pointed at Atlas it would destroy the
//      business. There is no override flag on purpose.
//   2. CONFIRM=DELETE. Nothing is written without it — running the file by accident reports and
//      exits.
//
// WHAT IT DELETES: every user-scoped collection, derived from backup.service.COLLECTIONS, plus
// the login/approval records a backup deliberately excludes (TrustedPerson, OtpToken, RestoreJob)
// and finally the User itself. This is the SAME derivation profile.service.deleteAccount uses, and
// for the same reason: the purge list used to be hand-written and had silently fallen behind,
// leaving thousands of orphaned history rows and a stale bill counter. Deriving it means a
// collection added later cannot be forgotten here either.
//
// WHAT IT KEEPS: the shared catalogs — gas types, cylinder sizes, gas capacities. They carry no
// user_id (see backup.service: "global catalogs, not per-tenant data"), they are shared by every
// account, and the server re-seeds its defaults at boot regardless. Wiping them would throw away
// the custom entries added over time (HCL, MIX, 0 AIR, the G-1 grades, H2, 7 nm, MPC) for no gain.
//
// TAKE A BACKUP FIRST. scripts/wipeTestData.js shows the mongodump/docker cp incantation; this
// script does not take one for you, because the caller may already have one.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const DRY = process.env.DRY === '1' || process.env.CONFIRM !== 'DELETE';
// The account to act on MUST be named explicitly. There is deliberately no default: a
// hardcoded address is a privacy leak in a published file, is wrong on every machine but one,
// and on a script that writes it is a way to hit the wrong account by simply forgetting.
const EMAIL = (process.env.EMAIL || '').trim().toLowerCase();
if (!EMAIL) {
  console.error('Name the account: EMAIL=you@example.com node ' + process.argv[1].split(/[\/]/).pop());
  process.exit(1);
}

function assertLocal(uri) {
  const m = /^mongodb(\+srv)?:\/\/(?:[^@]*@)?([^/?]+)/.exec(String(uri || ''));
  const host = m ? m[2] : '';
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  if (m && m[1]) throw new Error('REFUSING: MONGODB_URI is a mongodb+srv (Atlas) connection. This script is local-only.');
  if (!local) throw new Error(`REFUSING: MONGODB_URI host is "${host}", not localhost. This script is local-only.`);
  return host;
}

(async () => {
  const host = assertLocal(process.env.MONGODB_URI);

  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const User = require('../models/User');
  const backup = require('../services/backup.service');

  console.log(`database : ${host} / ${mongoose.connection.name}`);
  console.log(`account  : ${EMAIL}`);
  console.log(DRY ? '\n*** DRY RUN — nothing will be deleted (set CONFIRM=DELETE to run) ***\n' : '');

  const user = await User.findOne({ email: EMAIL }).select('_id email name createdAt').lean();
  if (!user) {
    console.error(`No account with email ${EMAIL} — nothing to do.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`found    : ${user.name} <${user.email}>  created ${new Date(user.createdAt).toISOString().slice(0, 10)}\n`);

  const targets = backup.COLLECTIONS
    .filter(c => c.scope === 'user')
    .map(c => c.model)
    .concat(['TrustedPerson', 'OtpToken', 'RestoreJob']);

  const kept = backup.COLLECTIONS.filter(c => c.scope === 'global').map(c => c.model);

  let total = 0;
  const removed = {};
  for (const name of targets) {
    const Model = require(`../models/${name}`);
    const n = await Model.countDocuments({ user_id: user._id });
    total += n;
    if (!n) continue;
    removed[name] = n;
    console.log(`  ${DRY ? 'would delete' : 'deleted    '}  ${String(n).padStart(6)}  ${name}`);
    if (!DRY) {
      const r = await Model.deleteMany({ user_id: user._id });
      if (r.deletedCount !== n) console.log(`      ! expected ${n}, removed ${r.deletedCount}`);
    }
  }
  // Free the licence this account holds, exactly as profile.service.deleteAccount does — a
  // licence still pointing at a deleted user can never be used again.
  const Licence = require('../models/Licence');
  const held = await Licence.findOne({ used_by: user._id }).select('key_prefix email').lean();
  if (held) {
    console.log(`  ${DRY ? 'would release' : 'released   '}          licence ${held.key_prefix}… (${held.email})`);
    if (!DRY) await require('../services/licence.service').releaseForUser(user._id);
  }

  console.log(`  ${DRY ? 'would delete' : 'deleted    '}  ${String(1).padStart(6)}  User`);
  if (!DRY) await User.deleteOne({ _id: user._id });

  console.log(`\n  ${DRY ? 'would remove' : 'removed'} ${total + 1} documents across ${Object.keys(removed).length + 1} collections`);

  // Shared catalogs, reported so it is visible that they were left alone rather than missed.
  console.log('\n  kept (shared catalogs, no user_id):');
  for (const name of kept) {
    console.log(`     ${String(await require(`../models/${name}`).countDocuments()).padStart(6)}  ${name}`);
  }

  if (!DRY) {
    // Prove it: nothing user-scoped may remain anywhere, and no user may be left behind.
    const leftovers = [];
    for (const name of targets) {
      const n = await require(`../models/${name}`).countDocuments({ user_id: user._id });
      if (n) leftovers.push(`${name}=${n}`);
    }
    const usersLeft = await User.countDocuments();
    console.log('\n  verification:');
    console.log(`     records still referencing this account : ${leftovers.length ? leftovers.join(', ') : 'none'}`);
    console.log(`     accounts remaining in the database     : ${usersLeft}`);
    if (leftovers.length) { console.error('\nFAILED — records survived the purge.'); process.exit(1); }
  }

  await mongoose.disconnect();
})().catch(e => { console.error('\n' + (e.message || e)); process.exit(1); });
