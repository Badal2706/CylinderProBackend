// Phase 17 self-verification. Runs from CylinderProBackend (needs otplib + mongoose):
//   node scripts/verifyPhase17.js
// Uses the live dev API on :3001 plus direct Mongo access for the things that need time
// travel (reminder threshold, session expiry) — only ever touching the throwaway test user.
require('dotenv').config();
const mongoose = require('mongoose');
const { authenticator } = require('otplib');

const API = 'http://localhost:3001/api';
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ' — ' + detail : ''}`); };
const api = async (method, path, body, token) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
};
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management');
  const db = mongoose.connection.db;

  // ── Step 2/3: migration — owner email + untouched data + bootstrap TrustedPerson ──
  const owner = await db.collection('users').findOne({ email: 'patelbadal276@gmail.com' });
  const oldOwner = await db.collection('users').findOne({ email: 'demo@cylinderpro.com' });
  check('Owner login email is patelbadal276@gmail.com (old email gone)', !!owner && !oldOwner);
  const counts = {};
  for (const c of ['customers', 'bills', 'cylinders', 'payments']) {
    counts[c] = await db.collection(c).countDocuments({ user_id: owner._id });
  }
  check('Owner data unaffected (423 customers / 2783 cylinders)', counts.customers === 423 && counts.cylinders === 2783, JSON.stringify(counts));
  const boot = await db.collection('trustedpeople').findOne({ user_id: owner._id, email: 'patelbadal276@gmail.com' });
  check('Bootstrap TrustedPerson exists (active + verified)', !!boot && boot.is_active && boot.email_verified, boot && boot.name);

  // ── Test tenant ──
  const email = `verify17_${Date.now()}@test.local`;
  let r = await api('POST', '/auth/signup', { name: 'Verify17 Bot', email, password: 'verify123' });
  const tokenA = r.data && r.data.token;
  check('Signup test user (standard session)', r.ok && !!tokenA, email);
  const ttlA = claims(tokenA).exp - claims(tokenA).iat;
  check('Standard session token expires in 24h', Math.abs(ttlA - 86400) < 120, `${ttlA}s`);
  const uid = new mongoose.Types.ObjectId(String(claims(tokenA).id));

  // ── Step 9: unverified email never blocks; banner appears after threshold ──
  r = await api('GET', '/customers', null, tokenA);
  check('Unverified email: normal API use unaffected', r.ok);
  r = await api('GET', '/auth/security-status', null, tokenA);
  check('Fresh account: no reminder yet (threshold not elapsed)', r.ok && r.data.remind_email_verify === false, JSON.stringify(r.data));
  await db.collection('users').updateOne({ _id: uid }, { $set: { createdAt: new Date(Date.now() - 4 * 86400000) } });
  r = await api('GET', '/auth/security-status', null, tokenA);
  check('After 4 days unverified: reminder banner flag turns on', r.ok && r.data.remind_email_verify === true, JSON.stringify(r.data));

  // ── Email verification (user) via OTP ──
  r = await api('POST', '/auth/verify-email/send', null, tokenA);
  const userCode = r.data && r.data.dev_code;
  check('Verification OTP issued (dev fallback returns code — SMTP not configured)', r.ok && /^\d{6}$/.test(userCode || ''), JSON.stringify(r.data));
  r = await api('POST', '/auth/verify-email/confirm', { code: '000111' }, tokenA);
  check('Wrong email OTP rejected', !r.ok && r.status === 400, JSON.stringify(r.data && r.data.error));
  r = await api('POST', '/auth/verify-email/confirm', { code: userCode }, tokenA);
  check('Correct email OTP verifies the account email', r.ok);
  r = await api('GET', '/auth/security-status', null, tokenA);
  check('Reminder gone after verification', r.ok && r.data.email_verified && !r.data.remind_email_verify);

  // ── Step 4: add trusted people — OTP required before active ──
  r = await api('POST', '/trusted-people', { name: 'Person A', email: 'a17@test.local' }, tokenA);
  const pA = r.data && r.data.person; const codeA = r.data && r.data.dev_code;
  check('Add Person A → created INACTIVE + OTP emailed', r.ok && pA && pA.is_active === false && /^\d{6}$/.test(codeA || ''));
  // Step-up must refuse them while unverified:
  r = await api('POST', '/step-up/otp/send', { person_id: pA.person_id }, tokenA);
  check('Unverified person cannot be used for step-up OTP', !r.ok && r.status === 400, JSON.stringify(r.data && r.data.error));
  r = await api('POST', `/trusted-people/${pA.person_id}/verify-email`, { code: codeA }, tokenA);
  check('Person A email OTP verifies → active', r.ok && r.data.person && r.data.person.is_active === true);
  r = await api('POST', '/trusted-people', { name: 'Person B', email: 'b17@test.local' }, tokenA);
  const pB = r.data && r.data.person; const codeB = r.data && r.data.dev_code;
  await api('POST', `/trusted-people/${pB.person_id}/verify-email`, { code: codeB }, tokenA);
  const list = (await api('GET', '/trusted-people', null, tokenA)).data;
  check('Both people listed active + verified', list.length === 2 && list.every(p => p.is_active && p.email_verified));

  // ── Step 5: TOTP enrollment — distinct secrets per person ──
  r = await api('POST', `/trusted-people/${pA.person_id}/totp/enroll`, null, tokenA);
  const secretA = r.data && r.data.secret;
  check('Person A enrollment returns QR + otpauth URL', r.ok && !!r.data.qr && String(r.data.otpauth_url || '').startsWith('otpauth://'), '');
  r = await api('POST', `/trusted-people/${pB.person_id}/totp/enroll`, null, tokenA);
  const secretB = r.data && r.data.secret;
  check('Person B gets a DIFFERENT secret than Person A', !!secretA && !!secretB && secretA !== secretB);
  r = await api('POST', `/trusted-people/${pA.person_id}/totp/confirm`, { code: authenticator.generate(secretA) }, tokenA);
  check('Person A confirms authenticator', r.ok);
  r = await api('POST', `/trusted-people/${pB.person_id}/totp/confirm`, { code: authenticator.generate(secretB) }, tokenA);
  check('Person B confirms authenticator', r.ok);

  // ── Step 6: step-up service — each person's TOTP validates independently ──
  r = await api('POST', '/step-up/totp/verify', { code: authenticator.generate(secretA) }, tokenA);
  check('Step-up TOTP: Person A\'s code validates', r.ok && r.data.verified && r.data.approved_by === 'Person A' && !!r.data.step_up_token, JSON.stringify(r.data && r.data.approved_by));
  r = await api('POST', '/step-up/totp/verify', { code: authenticator.generate(secretB) }, tokenA);
  check('Step-up TOTP: Person B\'s code validates independently', r.ok && r.data.verified && r.data.approved_by === 'Person B');
  const bogus = authenticator.generate(authenticator.generateSecret());
  r = await api('POST', '/step-up/totp/verify', { code: bogus }, tokenA);
  check('Step-up TOTP: wrong/random code fails', !r.ok && r.status === 400);
  // OTP path: person-specific email code
  r = await api('POST', '/step-up/otp/send', { person_id: pA.person_id }, tokenA);
  const suCode = r.data && r.data.dev_code;
  check('Step-up OTP: code issued for the chosen person', r.ok && /^\d{6}$/.test(suCode || ''));
  r = await api('POST', '/step-up/otp/verify', { person_id: pA.person_id, code: suCode }, tokenA);
  check('Step-up OTP: emailed code validates that request', r.ok && r.data.verified && r.data.via === 'OTP' && !!r.data.step_up_token);

  // ── Steps 7–8: remember-device sessions, list, revoke, expiry ──
  r = await api('POST', '/auth/signin', { email, password: 'verify123', remember: true }, null);
  const tokenB = r.data && r.data.token;
  const ttlB = claims(tokenB).exp - claims(tokenB).iat;
  check('"Remember this device" issues a ~90-day token', Math.abs(ttlB - 90 * 86400) < 3600, `${(ttlB / 86400).toFixed(1)} days`);
  r = await api('GET', '/auth/sessions', null, tokenB);
  const sessions = r.data || [];
  const cur = sessions.find(s => s.is_current);
  check('Sessions list shows both devices, current flagged + remembered', sessions.length === 2 && cur && cur.remember === true, `sessions=${sessions.length}`);
  // Revoke the OTHER (signup) session → tokenA dies instantly, tokenB unaffected.
  const other = sessions.find(s => !s.is_current);
  r = await api('DELETE', `/auth/sessions/${other.sid}`, null, tokenB);
  check('Revoke endpoint succeeds', r.ok);
  r = await api('GET', '/customers', null, tokenA);
  check('Revoked device\'s token is rejected immediately (401)', !r.ok && r.status === 401);
  r = await api('GET', '/customers', null, tokenB);
  check('Remaining device unaffected', r.ok);
  // Expiry: time-travel the remembered session past its window (stand-in for waiting 3 months).
  await db.collection('users').updateOne(
    { _id: uid, 'sessions.sid': claims(tokenB).sid },
    { $set: { 'sessions.$.expires_at': new Date(Date.now() - 1000) } }
  );
  r = await api('GET', '/customers', null, tokenB);
  check('Expired remembered session requires login again', !r.ok && r.status === 401);

  // ── Cleanup ──
  r = await api('POST', '/auth/signin', { email, password: 'verify123' }, null);
  const tokenC = r.data && r.data.token;
  r = await api('DELETE', '/profile/delete-account', { password: 'verify123' }, tokenC);
  check('Cleanup: test account deleted', r.ok);
  const leftovers = await db.collection('trustedpeople').countDocuments({ user_id: uid });
  const leftoverOtps = await db.collection('otptokens').countDocuments({ user_id: uid });
  check('Cleanup: trusted people + OTP tokens purged with the account', leftovers === 0 && leftoverOtps === 0);

  await mongoose.disconnect();
  const failed = results.filter(x => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — FAILURES: ' + failed.map(f => f.name).join('; ') : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });
