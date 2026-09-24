// Issue, list or revoke a CylinderPro licence number.
//
//   node scripts/issueLicence.js --list
//   node scripts/issueLicence.js --email client@example.com --note "Guru Industries" [--days 30]
//   node scripts/issueLicence.js --revoke <licence_id>
//   node scripts/issueLicence.js --bind-existing <email> <userId> [--note "..."]
//
// --bind-existing issues a licence AND binds it to an account that already exists — for an account
// created before licences did (the legacy signup key), so it is covered like every account since.
// The email and the id must name the same account, or it refuses. It writes only to the Licence
// (used_by, used_at, history): the User stores no licence reference, exactly as after a signup.
//
// THE KEY IS PRINTED ONCE. Only its sha256 is stored, so there is no command that can show it
// again — if it is lost before the client signs up, issue another and revoke the first.
//
// A licence is bound to ONE email address and can create ONE account at a time. While that
// account exists the licence is spent; deleting the account frees it. That is what makes a leaked
// licence worthless: whoever holds it cannot use it unless the client's own account is gone.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? undefined : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};

(async () => {
  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const svc = require('../services/licence.service');

  if (flag('list')) {
    const rows = await svc.listLicences();
    if (!rows.length) console.log('No licences issued yet.');
    else {
      console.log('KEY        EMAIL                          STATUS      ACCOUNTS  NOTE');
      for (const r of rows) {
        const status = r.revoked_at ? 'revoked'
          : r.expires_at && r.expires_at <= new Date() ? 'expired'
          : r.in_use ? 'in use' : 'free';
        console.log(
          `${(r.key_prefix + '…').padEnd(10)} ${String(r.email).padEnd(30)} ${status.padEnd(11)} ` +
          `${String(r.accounts_created).padEnd(9)} ${r.note || ''}`);
        console.log(`  id ${r.licence_id}`);
      }
    }
    await mongoose.disconnect();
    return;
  }

  if (flag('revoke')) {
    console.log((await svc.revokeLicence(flag('revoke'))).message);
    await mongoose.disconnect();
    return;
  }

  const bindAt = args.indexOf('--bind-existing');
  if (bindAt !== -1) {
    const bindEmail = args[bindAt + 1], bindUser = args[bindAt + 2];
    if (!bindEmail || !bindUser || bindEmail.startsWith('--') || bindUser.startsWith('--')) {
      console.error('Usage: node scripts/issueLicence.js --bind-existing <email> <userId> [--note "..."]');
      await mongoose.disconnect();
      process.exit(1);
    }
    try {
      const out = await svc.bindToExistingAccount({
        email: bindEmail, userId: bindUser,
        note: flag('note') === true ? '' : (flag('note') || '')
      });
      console.log('\n  ┌────────────────────────────────────────────────┐');
      console.log(`  │   LICENCE NUMBER:  ${out.key.padEnd(26)}│`);
      console.log('  └────────────────────────────────────────────────┘');
      console.log(`\n  issued to : ${out.email}`);
      console.log(`  bound to  : account ${out.bound_to} (already existed — no signup needed)`);
      console.log(`  id        : ${out.licence_id}`);
      console.log('\n  The account already exists, so this number is not needed to use it. Keep it: it is');
      console.log('  what re-creates the account at this address if it is ever deleted. It is NOT stored');
      console.log('  in readable form and cannot be shown again.\n');
    } catch (e) {
      console.error(`Refused: ${e.message}`);
      await mongoose.disconnect();
      process.exit(1);
    }
    await mongoose.disconnect();
    return;
  }

  const email = flag('email');
  if (!email || email === true) {
    console.error('Usage: node scripts/issueLicence.js --email client@example.com [--note "..."] [--days 30]');
    console.error('       node scripts/issueLicence.js --list');
    console.error('       node scripts/issueLicence.js --revoke <licence_id>');
    console.error('       node scripts/issueLicence.js --bind-existing <email> <userId> [--note "..."]');
    await mongoose.disconnect();
    process.exit(1);
  }

  const days = flag('days');
  const expires = days && days !== true
    ? new Date(Date.now() + Number(days) * 86400000)
    : null;

  const out = await svc.issueLicence({
    email,
    note: flag('note') === true ? '' : (flag('note') || ''),
    expires_at: expires
  });

  console.log('\n  ┌────────────────────────────────────────────────┐');
  console.log(`  │   LICENCE NUMBER:  ${out.key.padEnd(26)}│`);
  console.log('  └────────────────────────────────────────────────┘');
  console.log(`\n  issued to : ${out.email}`);
  console.log(`  expires   : ${out.expires_at ? new Date(out.expires_at).toISOString().slice(0, 10) : 'never'}`);
  console.log(`  id        : ${out.licence_id}`);
  console.log('\n  Give this to the client. It is NOT stored in readable form and cannot be shown');
  console.log('  again — if it is lost, revoke it and issue another.\n');

  await mongoose.disconnect();
})().catch(e => { console.error('\n' + (e.message || e)); process.exit(1); });
