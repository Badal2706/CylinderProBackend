// Phase 20 self-verification. Run from CylinderProBackend: node scripts/verifyPhase20.js
// OTP codes are recovered by brute-forcing the sha256 hash of the throwaway tenant's own
// record (test-only; codes are never exposed by the API).
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const { authenticator } = require('otplib');

const API = 'http://localhost:3001/api';
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ' — ' + detail : ''}`); };
let token = '';
const api = async (method, path, body, extraHeaders = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
};
const crack = (hashHex) => {
  for (let i = 0; i < 1000000; i++) {
    const c = String(i).padStart(6, '0');
    if (crypto.createHash('sha256').update(c).digest('hex') === hashHex) return c;
  }
  return null;
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management');
  const db = mongoose.connection.db;
  const latestCode = async (uid) => crack((await db.collection('otptokens').findOne({ user_id: uid, consumed: false }, { sort: { createdAt: -1 } })).code_hash);

  // ── Owner's existing bootstrap entry flagged ──
  const ownerBoot = await db.collection('trustedpeople').findOne({ email: 'patelbadal276@gmail.com' });
  check('Owner bootstrap entry carries is_bootstrap: true (migration)', !!ownerBoot && ownerBoot.is_bootstrap === true);

  // ── New-account flow: bootstrap auto-created + banner immediate ──
  const email = `verify20_${Date.now()}@test.local`;
  let r = await api('POST', '/auth/signup', { name: 'Owner Twenty', email, password: 'verify123!' });
  token = r.data.token;
  check('Signup test user', r.ok && !!token, email);
  const uid = new mongoose.Types.ObjectId(String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id));

  r = await api('GET', '/trusted-people');
  let boot = (r.data || []).find(p => p.is_bootstrap);
  check('New account: owner auto-created as bootstrap Trusted Person (unverified)',
    !!boot && boot.email === email && boot.name === 'Owner Twenty' && !boot.email_verified && !boot.is_active);
  r = await api('GET', '/auth/security-status');
  check('Reminder banner flags the bootstrap entry IMMEDIATELY (no 3-day wait)',
    (r.data.unverified_people || []).some(p => p.is_bootstrap && p.email === email), JSON.stringify(r.data.unverified_people));

  // ── Account Information now step-up-gated ──
  r = await api('PUT', '/profile', { name: 'Owner Twenty', phone: '' });
  check('Account Information save WITHOUT approval → 403', !r.ok && r.status === 403);

  // Verify the bootstrap email, enroll TOTP → approvals possible.
  await api('POST', `/trusted-people/${boot.person_id}/resend-otp`);
  r = await api('POST', `/trusted-people/${boot.person_id}/verify-email`, { code: await latestCode(uid) });
  check('Bootstrap email verified via OTP → active', r.ok && r.data.person.is_active);
  r = await api('POST', `/trusted-people/${boot.person_id}/totp/enroll`);
  const secret = r.data.secret;
  await api('POST', `/trusted-people/${boot.person_id}/totp/confirm`, { code: authenticator.generate(secret) });
  const su = async () => (await api('POST', '/step-up/totp/verify', { code: authenticator.generate(secret) })).data.step_up_token;

  // ── Account Information save WITH approval; bootstrap syncs name + email ──
  const newEmail = `owner20b_${Date.now()}@test.local`;
  r = await api('PUT', '/profile', { name: 'Renamed Owner', phone: '123', email: newEmail, current_password: 'verify123!' }, { 'x-step-up-token': await su() });
  check('Account Information save WITH approval → succeeds', r.ok, JSON.stringify(r.data && r.data.error));
  r = await api('GET', '/trusted-people');
  boot = (r.data || []).find(p => p.is_bootstrap);
  check('Bootstrap entry mirrors the new name AND new email',
    boot && boot.name === 'Renamed Owner' && boot.email === newEmail, JSON.stringify({ name: boot && boot.name, email: boot && boot.email }));
  check('Changed email resets the bootstrap entry to unverified', boot && boot.email_verified === false);
  r = await api('GET', '/auth/security-status');
  check('Banner immediately flags the (re-)unverified bootstrap entry',
    (r.data.unverified_people || []).some(p => p.is_bootstrap && p.email === newEmail));

  // ── Approvals from an UNVERIFIED person are blocked with a clear message ──
  r = await api('POST', '/step-up/totp/verify', { code: authenticator.generate(secret) });
  check('TOTP approval from unverified person → blocked with "verify email" message',
    !r.ok && r.status === 403 && /not verified/i.test((r.data && r.data.error) || ''), JSON.stringify(r.data && r.data.error));
  r = await api('POST', '/step-up/otp/send', { person_id: boot.person_id });
  check('Step-up OTP send to unverified person → blocked with clear message',
    !r.ok && /not verified/i.test((r.data && r.data.error) || ''), JSON.stringify(r.data && r.data.error));
  // Verify the NEW email, then the SAME approval succeeds.
  await api('POST', `/trusted-people/${boot.person_id}/resend-otp`);
  await api('POST', `/trusted-people/${boot.person_id}/verify-email`, { code: await latestCode(uid) });
  r = await api('POST', '/step-up/totp/verify', { code: authenticator.generate(secret) });
  check('Same TOTP approval succeeds AFTER verifying the email', r.ok && r.data.verified);

  // ── Bootstrap immutability (server-side, even with valid approval) ──
  r = await api('PUT', `/trusted-people/${boot.person_id}`, { name: 'Hacked' }, { 'x-step-up-token': await su() });
  check('Editing the bootstrap entry blocked server-side despite approval', !r.ok && r.status === 400, JSON.stringify(r.data && r.data.error));
  r = await api('DELETE', `/trusted-people/${boot.person_id}`, null, { 'x-step-up-token': await su() });
  check('Deleting the bootstrap entry blocked server-side despite approval', !r.ok && r.status === 400, JSON.stringify(r.data && r.data.error));

  // ── Invariant: NON-bootstrap people stay fully editable/deletable ──
  r = await api('POST', '/trusted-people', { name: 'Person X', email: 'x20@test.local' }, { 'x-step-up-token': await su() });
  const pX = r.data.person;
  r = await api('PUT', `/trusted-people/${pX.person_id}`, { name: 'Person X2' }, { 'x-step-up-token': await su() });
  check('Non-bootstrap person still editable (with approval)', r.ok && r.data.person.name === 'Person X2');
  r = await api('DELETE', `/trusted-people/${pX.person_id}`, null, { 'x-step-up-token': await su() });
  check('Non-bootstrap person still deletable (with approval)', r.ok);

  // ── Single shared Location Profiles save ──
  const profiles = [
    { location: 'AT_PLANT_CHANDISAR', manager_name: 'M1', contact_number: '111', challan_prefix: 'C-' },
    { location: 'AT_PALANPUR_OFFICE', manager_name: 'M2', contact_number: '222', challan_prefix: 'P-' },
    { location: 'AT_CHHAPI_OFFICE', manager_name: 'M3', contact_number: '333', challan_prefix: 'H-' }
  ];
  r = await api('PUT', '/profile/locations', { profiles });
  check('Batch location save WITHOUT approval → 403', !r.ok && r.status === 403);
  r = await api('PUT', '/profile/locations', { profiles }, { 'x-step-up-token': await su() });
  check('Batch location save WITH approval commits all 3 together', r.ok && (r.data.saved || []).length === 3, JSON.stringify(r.data && r.data.saved));
  r = await api('GET', '/profile/locations');
  const saved = r.data.profiles || [];
  check('All 3 location profiles persisted from the single save',
    ['M1', 'M2', 'M3'].every(m => saved.some(p => p.manager_name === m)));

  // ── Phase 18/19 regressions ──
  r = await api('PUT', '/profile/business', { business_name: 'B20' });
  check('Regression: Business Info save still gated (403 without approval)', !r.ok && r.status === 403);
  r = await api('POST', '/profile/change-password', { current_password: 'verify123!', new_password: 'newpass20#', confirm_password: 'newpass20#' });
  check('Regression: password change still gated (403 without approval)', !r.ok && r.status === 403);
  r = await api('GET', '/profile/audit-log');
  check('Audit log recorded Account Information + Location Profiles saves',
    (r.data || []).some(x => x.target === 'Account Information') && (r.data || []).some(x => x.target === 'Location Profiles (all sites)'));

  // ── Cleanup ──
  r = await api('DELETE', '/profile/delete-account', { password: 'verify123!' });
  check('Cleanup: test account deleted', r.ok);
  const leftovers = await db.collection('trustedpeople').countDocuments({ user_id: uid })
    + await db.collection('locationprofiles').countDocuments({ user_id: uid })
    + await db.collection('auditlogs').countDocuments({ user_id: uid });
  check('Cleanup: no leftovers', leftovers === 0, `leftovers=${leftovers}`);

  await mongoose.disconnect();
  const failed = results.filter(x => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — FAILURES: ' + failed.map(f => f.name).join('; ') : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });
