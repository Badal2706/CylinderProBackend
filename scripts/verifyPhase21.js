// Phase 21 self-verification. Run from CylinderProBackend: node scripts/verifyPhase21.js
// Uses throwaway @test.local tenants only, deleted at the end (via the NEW owner-only path).
// OTP codes are recovered by brute-forcing the sha256 hash of the throwaway tenant's own
// record (test-only; codes are never exposed by the API).
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');
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

  // ═══ Account A ═══
  const emailA = `owner21_${Date.now()}@test.local`;
  let r = await api('POST', '/auth/signup', { name: 'Owner 21', email: emailA, password: 'verify21!' });
  token = r.data.token;
  check('Signup test account A', r.ok && !!token, emailA);
  const uidA = new mongoose.Types.ObjectId(String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id));
  const tokenA = token;

  // ── A. Email-verification sync ──
  r = await api('GET', '/auth/security-status');
  let tp = await api('GET', '/trusted-people');
  let boot = (tp.data || []).find(p => p.is_bootstrap);
  check('Fresh account: banner AND table agree (both unverified)',
    r.data.email_verified === false && (r.data.unverified_people || []).some(p => p.is_bootstrap) && boot && !boot.email_verified);

  // Verify via the TRUSTED-PERSON path → the login-email flag must follow.
  await api('POST', `/trusted-people/${boot.person_id}/resend-otp`);
  r = await api('POST', `/trusted-people/${boot.person_id}/verify-email`, { code: await latestCode(uidA) });
  check('Bootstrap verified via Trusted-People path', r.ok && r.data.person.email_verified);
  r = await api('GET', '/auth/security-status');
  check('TP-path verification also flips the LOGIN-email flag (banner agrees with table)',
    r.data.email_verified === true && (r.data.unverified_people || []).length === 0, JSON.stringify(r.data));

  // Manufacture the old drift (login flag knocked back) → security-status self-heals from
  // the canonical bootstrap flag.
  await db.collection('users').updateOne({ _id: uidA }, { $set: { email_verified: false } });
  r = await api('GET', '/auth/security-status');
  const healed = await db.collection('users').findOne({ _id: uidA }, { projection: { email_verified: 1 } });
  check('Manufactured drift self-heals on read (bootstrap flag is canonical)',
    r.data.email_verified === true && healed.email_verified === true);

  // ═══ Account B: verify via the USER path → bootstrap entry must follow ═══
  const emailB = `owner21b_${Date.now()}@test.local`;
  r = await api('POST', '/auth/signup', { name: 'Owner 21B', email: emailB, password: 'verify21!' });
  const tokenB = r.data.token;
  token = tokenB;
  const uidB = new mongoose.Types.ObjectId(String(JSON.parse(Buffer.from(tokenB.split('.')[1], 'base64url').toString()).id));
  await api('POST', '/auth/verify-email/send');
  r = await api('POST', '/auth/verify-email/confirm', { code: await latestCode(uidB) });
  check('Account B: login email verified via USER path', r.ok);
  r = await api('GET', '/trusted-people');
  const bootB = (r.data || []).find(p => p.is_bootstrap);
  check('USER-path verification also verifies + activates the bootstrap entry (table agrees with banner)',
    bootB && bootB.email_verified === true && bootB.is_active === true, JSON.stringify(bootB));

  // ═══ B. Owner-only account deletion ═══
  token = tokenA;
  // Enroll the owner's authenticator; add a fully-verified + enrolled helper.
  r = await api('POST', `/trusted-people/${boot.person_id}/totp/enroll`);
  const ownerSecret = r.data.secret;
  await api('POST', `/trusted-people/${boot.person_id}/totp/confirm`, { code: authenticator.generate(ownerSecret) });
  const suAny = async (secret) => (await api('POST', '/step-up/totp/verify', { code: authenticator.generate(secret) })).data.step_up_token;

  r = await api('POST', '/trusted-people', { name: 'Helper 21', email: `helper21_${Date.now()}@test.local` }, { 'x-step-up-token': await suAny(ownerSecret) });
  const helper = r.data.person;
  await api('POST', `/trusted-people/${helper.person_id}/resend-otp`);
  await api('POST', `/trusted-people/${helper.person_id}/verify-email`, { code: await latestCode(uidA) });
  r = await api('POST', `/trusted-people/${helper.person_id}/totp/enroll`);
  const helperSecret = r.data.secret;
  r = await api('POST', `/trusted-people/${helper.person_id}/totp/confirm`, { code: authenticator.generate(helperSecret) });
  check('Helper trusted person fully verified + authenticator-enrolled', r.ok);

  // Password alone no longer suffices.
  r = await api('DELETE', '/profile/delete-account', { password: 'verify21!' });
  check('Delete account with password ONLY → 403', !r.ok && r.status === 403, JSON.stringify(r.data && r.data.error));
  r = await api('POST', '/auth/clear-data', { password: 'verify21!' });
  check('Clear all data with password ONLY → 403', !r.ok && r.status === 403);

  // Non-owner approvals rejected SPECIFICALLY for not being the owner.
  r = await api('POST', '/step-up/totp/verify', { code: authenticator.generate(helperSecret), owner_only: true });
  check('Owner-only TOTP with HELPER\'s valid code → rejected as not-the-owner',
    !r.ok && r.status === 403 && /only the account owner/i.test((r.data && r.data.error) || ''), JSON.stringify(r.data && r.data.error));
  r = await api('POST', '/step-up/otp/send', { person_id: helper.person_id, owner_only: true, context: 'delete this account' });
  check('Owner-only OTP send to HELPER → rejected as not-the-owner',
    !r.ok && r.status === 403 && /only the account owner/i.test((r.data && r.data.error) || ''));

  // A regular 'any'-scope token (even the OWNER's) cannot be spent on deletion.
  r = await api('DELETE', '/profile/delete-account', { password: 'verify21!' }, { 'x-step-up-token': await suAny(helperSecret) });
  check('Delete with helper\'s regular (any-scope) approval → 403', !r.ok && r.status === 403, JSON.stringify(r.data && r.data.error));
  r = await api('DELETE', '/profile/delete-account', { password: 'verify21!' }, { 'x-step-up-token': await suAny(ownerSecret) });
  check('Delete with owner\'s regular (any-scope) approval → 403 (owner-only SCOPE required)', !r.ok && r.status === 403);

  // Owner-only token works — and the invariant holds: helper still approves everything else.
  const suOwner = async () => (await api('POST', '/step-up/totp/verify', { code: authenticator.generate(ownerSecret), owner_only: true })).data.step_up_token;
  r = await api('PUT', '/profile/business', { business_name: 'B21' }, { 'x-step-up-token': await suAny(helperSecret) });
  check('Invariant: helper\'s any-scope approval still works for Phase 18 gates (business save)', r.ok);
  r = await api('POST', '/auth/clear-data', { password: 'verify21!' }, { 'x-step-up-token': await suOwner() });
  check('Clear all data with password + OWNER-ONLY approval → succeeds', r.ok, JSON.stringify(r.data));
  // Wrong password + valid owner token still fails (both layers required).
  r = await api('DELETE', '/profile/delete-account', { password: 'wrong-pass' }, { 'x-step-up-token': await suOwner() });
  check('Delete with owner approval but WRONG password → 400 (password layer kept)', !r.ok && r.status === 400);

  // ═══ C. Contextual messaging ═══
  // Email body: run sendOtp in a child process with SMTP unset → the dev-mail console line
  // carries the full body; assert the context sentence is in it.
  // NOTE: the probe file lives in the OS temp dir — writing it under the backend folder
  // would trigger a nodemon restart mid-run.
  const svcDir = __dirname.replace(/\\/g, '/');
  const ctxProbe = `
    require('${svcDir}/../node_modules/dotenv').config({ path: '${svcDir}/../.env' });
    const mongoose = require('${svcDir}/../node_modules/mongoose');
    (async () => {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management');
      const otp = require('${svcDir}/../services/otp.service');
      await otp.sendOtp({ userId: new mongoose.Types.ObjectId('${uidA}'), purpose: 'STEP_UP', email: 'ctx@test.local', context: 'delete Bill B-TEST-21 for Acme Traders' });
      await mongoose.disconnect();
    })();`;
  const probePath = require('path').join(require('os').tmpdir(), `cp_ctxProbe_${Date.now()}.js`);
  fs.writeFileSync(probePath, ctxProbe);
  const probeOut = execFileSync(process.execPath, [probePath], {
    env: { ...process.env, SMTP_HOST: '' }, encoding: 'utf8'
  });
  fs.unlinkSync(probePath);
  check('OTP email body includes "Authorization requested: <context>"',
    probeOut.includes('Authorization requested: delete Bill B-TEST-21 for Acme Traders') && probeOut.includes('verification code is:'));

  // API accepts context on the send endpoint (it went to the helper's inbox body).
  r = await api('POST', '/step-up/otp/send', { person_id: helper.person_id, context: 'edit Bill B-1 for Acme Traders' });
  check('POST /step-up/otp/send accepts a context string', r.ok, JSON.stringify(r.data && r.data.message));

  // Frontend: modal shows the context (both paths) and sends context/owner_only.
  const fe = fs.readFileSync(`${__dirname}/../../CylinderProFrontend/src/components.jsx`, 'utf8');
  check('Modal displays "Authorization requested:" before code entry',
    fe.includes('Authorization requested:') && fe.includes('context={stepUpAsk.context}'));
  check('Modal sends context + owner_only to the backend',
    fe.includes('person_id: personId, context, owner_only: ownerOnly') && fe.includes('owner_only: ownerOnly } : { code, owner_only: ownerOnly }'));

  // ═══ Cleanup — through the NEW owner-only path (positive test of step 9) ═══
  r = await api('DELETE', '/profile/delete-account', { password: 'verify21!' }, { 'x-step-up-token': await suOwner() });
  check('Account A deleted with password + owner-only approval', r.ok);

  // Account B: verify its owner's TOTP then delete owner-only (bootstrap was activated by the USER path).
  token = tokenB;
  r = await api('GET', '/trusted-people');
  const bootB2 = (r.data || []).find(p => p.is_bootstrap);
  r = await api('POST', `/trusted-people/${bootB2.person_id}/totp/enroll`);
  const secretB = r.data.secret;
  await api('POST', `/trusted-people/${bootB2.person_id}/totp/confirm`, { code: authenticator.generate(secretB) });
  r = await api('POST', '/step-up/totp/verify', { code: authenticator.generate(secretB), owner_only: true });
  r = await api('DELETE', '/profile/delete-account', { password: 'verify21!' }, { 'x-step-up-token': r.data.step_up_token });
  check('Account B deleted with password + owner-only approval', r.ok);

  const leftovers = await db.collection('users').countDocuments({ email: { $in: [emailA, emailB] } })
    + await db.collection('trustedpeople').countDocuments({ user_id: { $in: [uidA, uidB] } })
    + await db.collection('otptokens').countDocuments({ user_id: { $in: [uidA, uidB] } })
    + await db.collection('auditlogs').countDocuments({ user_id: { $in: [uidA, uidB] } });
  check('Cleanup: no leftovers from test tenants', leftovers === 0, `leftovers=${leftovers}`);

  await mongoose.disconnect();
  const failed = results.filter(x => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — FAILURES: ' + failed.map(f => f.name).join('; ') : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });
