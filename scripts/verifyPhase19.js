// Phase 19 self-verification. Run from CylinderProBackend: node scripts/verifyPhase19.js
// Real SMTP delivery + password-change step-up gating. Codes are no longer exposed by the
// API, so this script recovers the throwaway tenant's OTP by brute-forcing the sha256 hash
// in Mongo (6 digits = 1e6 tries) — a TEST-ONLY shortcut on the test tenant's own data.
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const { authenticator } = require('otplib');
const fs = require('fs');

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

  // ── Step 1: env + gitignore ──
  const gi = fs.readFileSync(`${__dirname}/../.gitignore`, 'utf8');
  const envText = fs.readFileSync(`${__dirname}/../.env`, 'utf8');
  check('.env exists with SMTP_USER/SMTP_PASS/HOST/PORT and is git-ignored',
    /^\.env$/m.test(gi) && /SMTP_USER=/.test(envText) && /SMTP_PASS=/.test(envText) && /SMTP_HOST=smtp\.gmail\.com/.test(envText) && /SMTP_PORT=587/.test(envText));

  const email = `verify19_${Date.now()}@test.local`;
  let r = await api('POST', '/auth/signup', { name: 'Verify19 Bot', email, password: 'verify123!' });
  token = r.data.token;
  check('Signup test user', r.ok && !!token, email);
  const uid = new mongoose.Types.ObjectId(String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id));

  // ── Step 3: REAL email — trusted person whose address is the Gmail inbox itself ──
  r = await api('POST', '/trusted-people', { name: 'Approver 19', email: 'guruindustries.cylinderpro@gmail.com' });
  check('OTP email accepted by Gmail SMTP (email_sent: true)', r.ok && r.data.email_sent === true, JSON.stringify({ message: r.data && r.data.message }));
  check('No dev-mode code in the API response', r.ok && !('dev_code' in (r.data || {})));
  const pA = r.data.person;

  // Recover the code from the hash (test-only) and verify the person.
  const otpDoc = await db.collection('otptokens').findOne({ user_id: uid, consumed: false }, { sort: { createdAt: -1 } });
  const code = otpDoc && crack(otpDoc.code_hash);
  check('OTP stored hashed (recovered only by brute force for this test)', !!code);
  r = await api('POST', `/trusted-people/${pA.person_id}/verify-email`, { code });
  check('Emailed code verifies the trusted person', r.ok && r.data.person && r.data.person.is_active);
  r = await api('POST', `/trusted-people/${pA.person_id}/totp/enroll`);
  const secret = r.data.secret;
  await api('POST', `/trusted-people/${pA.person_id}/totp/confirm`, { code: authenticator.generate(secret) });
  const su = async () => (await api('POST', '/step-up/totp/verify', { code: authenticator.generate(secret) })).data.step_up_token;

  // ── Steps 4–6: password change gating (layered) ──
  const pwBody = { current_password: 'verify123!', new_password: 'newpass19#', confirm_password: 'newpass19#' };
  r = await api('POST', '/profile/change-password', pwBody);
  check('Password change with ONLY the current password → 403 (step-up required)', !r.ok && r.status === 403, JSON.stringify(r.data && r.data.error));
  r = await api('POST', '/profile/change-password', { ...pwBody, current_password: 'wrong-pass' }, { 'x-step-up-token': await su() });
  check('Wrong current password fails EVEN WITH valid step-up (layered, not replaced)', !r.ok && r.status === 400, JSON.stringify(r.data && r.data.error));
  r = await api('POST', '/profile/change-password', pwBody, { 'x-step-up-token': await su() });
  check('Correct password + step-up approval → password changed', r.ok);
  r = await api('POST', '/auth/signin', { email, password: 'newpass19#' });
  check('Sign-in works with the NEW password', r.ok && !!r.data.token);
  token = r.data.token;

  // ── Invariants: Phase 18 gates unchanged ──
  r = await api('PUT', '/profile/business', { business_name: 'X' });
  check('Phase 18 gate regression: business save without approval still 403', !r.ok && r.status === 403);
  r = await api('PUT', '/profile/business', { business_name: 'X' }, { 'x-step-up-token': await su() });
  check('Phase 18 gate regression: business save with approval still works', r.ok);
  r = await api('GET', '/profile/audit-log');
  check('Audit log records the password change (who + method)',
    (r.data || []).some(x => x.action === 'PROFILE_SAVE' && x.target === 'Account password' && x.person_name === 'Approver 19'));

  // ── Cleanup ──
  r = await api('DELETE', '/profile/delete-account', { password: 'newpass19#' });
  check('Cleanup: test account deleted', r.ok);

  await mongoose.disconnect();
  const failed = results.filter(x => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — FAILURES: ' + failed.map(f => f.name).join('; ') : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });
