const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const RentalCharge = require('../models/RentalCharge');
const HttpError = require('../utils/HttpError');
const otp = require('./otp.service');

const JWT_SECRET = process.env.JWT_SECRET;
// Session lengths (Phase 17): standard = the old flat 24h; "Remember this device" = 90 days.
// SESSION_REMEMBER_MS is env-overridable so the expiry path can be tested without waiting 3 months.
const SESSION_STANDARD_MS = 24 * 60 * 60 * 1000;
const SESSION_REMEMBER_MS = Number(process.env.SESSION_REMEMBER_MS || 90 * 24 * 60 * 60 * 1000);
// Unverified-email reminder appears after this many days (non-blocking).
const EMAIL_REMINDER_DAYS = Number(process.env.EMAIL_REMINDER_DAYS || 3);

const sign = (user, sid, expiresInMs) => jwt.sign(
  { id: user._id, name: user.name, email: user.email, tv: user.token_version || 0, sid },
  JWT_SECRET,
  { expiresIn: Math.max(1, Math.round(expiresInMs / 1000)) }
);

// Create + persist a session entry on the user, pruning expired ones. Returns the signed JWT.
async function openSession(user, { remember = false, device = '', ip = '' } = {}) {
  const sid = crypto.randomUUID();
  const ttl = remember ? SESSION_REMEMBER_MS : SESSION_STANDARD_MS;
  const MAX_SESSIONS = 10;
  const now = new Date();
  user.sessions = (user.sessions || []).filter(s => s.expires_at > now);
  if (user.sessions.length >= MAX_SESSIONS) {
    user.sessions.sort((a, b) => a.last_active - b.last_active);
    user.sessions = user.sessions.slice(-MAX_SESSIONS + 1);
  }
  user.sessions.push({
    sid,
    device: String(device || '').slice(0, 300),
    ip: String(ip || '').slice(0, 60),
    remember: !!remember,
    created_at: now,
    last_active: now,
    expires_at: new Date(now.getTime() + ttl)
  });
  await user.save();
  return sign(user, sid, ttl);
}

// Developer token required for signup — only users with the correct token can register.
// All signup OTPs go to this gatekeeper email for approval.
const DEVELOPER_TOKEN = process.env.DEVELOPER_TOKEN;
const SIGNUP_GATEKEEPER_EMAIL = process.env.SIGNUP_GATEKEEPER_EMAIL;

if (process.env.NODE_ENV === 'production' && (!DEVELOPER_TOKEN || !SIGNUP_GATEKEEPER_EMAIL)) {
  throw new Error('DEVELOPER_TOKEN and SIGNUP_GATEKEEPER_EMAIL must be set in production');
}

async function signupRequest({ name, email, password, developer_token }) {
  if (!name || !email || !password) {
    throw new HttpError(400, 'Name, email and password are required');
  }
  if (!developer_token || developer_token !== DEVELOPER_TOKEN) {
    throw new HttpError(403, 'Invalid developer token');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Please enter a valid email address');
  }
  if (password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    throw new HttpError(400, 'Email is already registered');
  }

  // Store pending signup data in a short-lived token and send OTP to gatekeeper.
  const pendingToken = jwt.sign(
    { name, email: email.toLowerCase(), password, purpose: 'signup' },
    JWT_SECRET,
    { expiresIn: 600 }
  );
  // Use a synthetic userId based on the email for OTP storage (no user created yet).
  const syntheticId = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24);
  await otp.sendOtp({
    userId: syntheticId,
    purpose: 'STEP_UP',
    email: SIGNUP_GATEKEEPER_EMAIL,
    context: `New account signup request from ${name} (${email})`
  });

  return { requires_otp: true, pending_token: pendingToken, gatekeeper_email: SIGNUP_GATEKEEPER_EMAIL };
}

async function signupConfirm({ pending_token, code, remember, device, ip }) {
  if (!pending_token || !code) throw new HttpError(400, 'Token and OTP code are required');
  let payload;
  try {
    payload = jwt.verify(pending_token, JWT_SECRET);
  } catch { throw new HttpError(401, 'Signup session expired — please try again.'); }
  if (payload.purpose !== 'signup') throw new HttpError(400, 'Invalid token');

  const syntheticId = crypto.createHash('sha256').update(payload.email).digest('hex').slice(0, 24);
  await otp.verifyOtp({ userId: syntheticId, purpose: 'STEP_UP', email: SIGNUP_GATEKEEPER_EMAIL, code });

  // Now create the user
  const existingCheck = await User.findOne({ email: payload.email });
  if (existingCheck) throw new HttpError(400, 'Email is already registered');

  const user = new User({ name: payload.name, email: payload.email, password: payload.password });
  await user.save();

  try {
    await require('./trustedPeople.service').createBootstrap(user._id, { name: user.name, email: user.email });
  } catch (e) { console.error('Bootstrap trusted person creation failed:', e.message); }

  const token = await openSession(user, { remember, device, ip });
  return { token, name: user.name, email: user.email };
}

async function signin({ email, password, remember, device, ip }) {
  if (!email || !password) {
    throw new HttpError(400, 'Email and password are required');
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user || !(await user.comparePassword(password))) {
    throw new HttpError(401, 'Invalid email or password');
  }

  // 2FA: send OTP to user's email before granting a session.
  const pending = jwt.sign(
    { id: user._id.toString(), purpose: '2fa', remember: !!remember },
    JWT_SECRET,
    { expiresIn: 600 }
  );
  await otp.sendOtp({ userId: user._id, purpose: 'USER_EMAIL_VERIFY', email: user.email });
  return { requires_2fa: true, pending_token: pending, email: user.email };
}

async function verify2fa({ pending_token, code, device, ip }) {
  if (!pending_token || !code) throw new HttpError(400, 'Token and code are required');
  let payload;
  try {
    payload = jwt.verify(pending_token, JWT_SECRET);
  } catch { throw new HttpError(401, 'Login session expired — please sign in again.'); }
  if (payload.purpose !== '2fa') throw new HttpError(400, 'Invalid token');

  const user = await User.findById(payload.id);
  if (!user) throw new HttpError(401, 'Account not found');
  await otp.verifyOtp({ userId: user._id, purpose: 'USER_EMAIL_VERIFY', email: user.email, code });

  user.last_login = new Date();
  if (!user.email_verified) { user.email_verified = true; }
  const token = await openSession(user, { remember: payload.remember, device, ip });
  return { token, name: user.name, email: user.email, remember: payload.remember };
}

// Re-issues a token for the SAME session (sid preserved) — expiry stays capped at the
// session's own expires_at so refresh can never outlive a revocation window.
async function refresh(userId, sid) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(401, 'Account no longer exists.');
  const now = Date.now();
  if (sid) {
    const sess = (user.sessions || []).find(s => s.sid === sid);
    if (!sess || sess.expires_at <= new Date()) throw new HttpError(401, 'Your session has expired. Please log in again.');
    return { token: sign(user, sid, sess.expires_at.getTime() - now), name: user.name, email: user.email };
  }
  // Legacy token without a sid: open a fresh standard session.
  const token = await openSession(user, { remember: false });
  return { token, name: user.name, email: user.email };
}

// ─── Sessions & devices (Phase 17) ───
async function listSessions(userId, currentSid) {
  const user = await User.findById(userId).select('sessions');
  if (!user) throw new HttpError(404, 'Account not found');
  const now = new Date();
  return (user.sessions || [])
    .filter(s => s.expires_at > now)
    .sort((a, b) => b.last_active - a.last_active)
    .map(s => ({
      sid: s.sid,
      device: s.device,
      ip: s.ip,
      remember: s.remember,
      created_at: s.created_at,
      last_active: s.last_active,
      expires_at: s.expires_at,
      is_current: s.sid === currentSid
    }));
}

async function revokeSession(userId, sid) {
  const r = await User.updateOne({ _id: userId }, { $pull: { sessions: { sid } } });
  if (!r.modifiedCount) throw new HttpError(404, 'Session not found (already revoked?)');
  return { message: 'Session revoked — that device must log in again.' };
}

// ─── Login-email verification (Phase 17) ───
// Phase 21: the login email and the bootstrap Trusted Person entry are the SAME address —
// the bootstrap entry's email_verified is the canonical flag; User.email_verified mirrors it.
// Verifying through either path (here or /trusted-people/:id/verify-email) updates both.
async function bootstrapEntry(userId) {
  return require('../models/TrustedPerson').findOne({ user_id: userId, is_bootstrap: true });
}

async function sendEmailVerification(userId) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'Account not found');
  // Self-heal a drifted mirror: if the bootstrap entry already verified this address, the
  // login email IS verified — no code needed.
  const boot = await bootstrapEntry(userId);
  if (!user.email_verified && boot && boot.email === user.email && boot.email_verified) {
    user.email_verified = true;
    await user.save();
  }
  if (user.email_verified) return { message: 'Email is already verified.', already_verified: true };
  return otp.sendOtp({ userId, purpose: 'USER_EMAIL_VERIFY', email: user.email });
}

async function confirmEmailVerification(userId, code) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'Account not found');
  await otp.verifyOtp({ userId, purpose: 'USER_EMAIL_VERIFY', email: user.email, code });
  user.email_verified = true;
  await user.save();
  // Same address on the bootstrap entry → it is verified (and active) too.
  await require('../models/TrustedPerson').updateOne(
    { user_id: userId, is_bootstrap: true, email: user.email },
    { email_verified: true, is_active: true }
  );
  return { message: 'Email verified.' };
}

// Drives the non-blocking reminder banner: unverified login email (or unverified trusted
// people) older than EMAIL_REMINDER_DAYS.
async function securityStatus(userId) {
  const user = await User.findById(userId).select('email email_verified createdAt');
  if (!user) throw new HttpError(404, 'Account not found');
  const TrustedPerson = require('../models/TrustedPerson');
  const cutoff = new Date(Date.now() - EMAIL_REMINDER_DAYS * 24 * 60 * 60 * 1000);
  // The bootstrap (account owner) entry is flagged IMMEDIATELY when unverified (Phase 20);
  // other people only after the grace threshold.
  const stalePeople = await TrustedPerson.find({
    user_id: userId, email_verified: false,
    $or: [{ is_bootstrap: true }, { added_at: { $lt: cutoff } }]
  }).select('name email is_bootstrap');
  // Phase 21: the bootstrap entry is the canonical flag for the login email — read it (and
  // self-heal a stale mirror) so the banner can never disagree with the Trusted People table.
  const boot = await bootstrapEntry(userId);
  let emailVerified = !!user.email_verified;
  if (boot && boot.email === user.email && boot.email_verified !== emailVerified) {
    emailVerified = !!boot.email_verified;
    await User.updateOne({ _id: userId }, { email_verified: emailVerified });
  }
  return {
    email: user.email,
    email_verified: emailVerified,
    remind_email_verify: !emailVerified && user.createdAt < cutoff,
    unverified_people: stalePeople.map(p => ({ name: p.name, email: p.email, person_id: p._id, is_bootstrap: !!p.is_bootstrap })),
    reminder_days: EMAIL_REMINDER_DAYS
  };
}

// ─── Phase 27: forgot password ───
// Recovery is deliberately available WITHOUT being logged in. Two proofs are accepted at reset
// time, either one on its own:
//   1. a 6-digit code emailed to the account's own email, or
//   2. a current code from any authenticator already enrolled on the account (owner or a
//      trusted person). This is the escape hatch for when the inbox itself is unreachable.
// Both are things only the legitimate account holder (or someone they trusted) can produce.
const STRONG_PW = (pw) =>
  typeof pw === 'string' && pw.length >= 8 && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);

// Step 1: always responds the same way whether or not the email is registered, so this can't
// be used to discover which emails have accounts. A code is only actually sent if it exists.
async function requestPasswordReset({ email }) {
  const clean = String(email || '').toLowerCase().trim();
  if (!clean) throw new HttpError(400, 'Email is required');

  const user = await User.findOne({ email: clean });
  let totpAvailable = false;
  if (user) {
    await otp.sendOtp({
      userId: user._id, purpose: 'USER_EMAIL_VERIFY', email: clean,
      context: 'reset your CylinderPro password'
    });
    totpAvailable = await require('../models/TrustedPerson')
      .exists({ user_id: user._id, is_active: true, totp_enabled: true });
  }
  // The token carries only the submitted email; the account is resolved at reset time. A token
  // is returned even for an unknown email so the response shape never reveals existence.
  const reset_token = jwt.sign({ email: clean, purpose: 'pw_reset' }, JWT_SECRET, { expiresIn: 900 });
  return {
    message: 'If that email has an account, a 6-digit code has been sent to it.',
    reset_token,
    // Lets the UI offer the authenticator alternative. This reflects the resolved account, not
    // the email itself, so it does not reveal whether the typed email exists.
    totp_available: !!totpAvailable
  };
}

// Step 2: verify one of the two proofs, then set the new password and invalidate every existing
// session (bumping token_version) so a compromised old password can't keep a live session.
async function resetPassword({ reset_token, code, totp_code, new_password }) {
  let payload;
  try { payload = jwt.verify(reset_token, JWT_SECRET); }
  catch { throw new HttpError(400, 'This reset link expired — start again.'); }
  if (payload.purpose !== 'pw_reset') throw new HttpError(400, 'Invalid reset token');

  const user = await User.findOne({ email: payload.email });
  // Generic error — never confirm whether the email had an account.
  if (!user) throw new HttpError(400, 'Invalid code or reset request. Please start again.');

  if (!STRONG_PW(new_password)) {
    throw new HttpError(400, 'New password must be at least 8 characters with a number and a symbol.');
  }

  if (code) {
    // Throws on wrong / expired / exhausted code.
    await otp.verifyOtp({ userId: user._id, purpose: 'USER_EMAIL_VERIFY', email: user.email, code });
  } else if (totp_code) {
    const match = await require('./totp.service').validateAny(user._id, totp_code);
    if (!match) throw new HttpError(400, 'That authenticator code is not valid.');
  } else {
    throw new HttpError(400, 'Enter the emailed code, or a code from your authenticator app.');
  }

  user.password = new_password;                 // pre-save hook hashes it
  user.token_version = (user.token_version || 0) + 1; // invalidate all existing JWTs
  user.sessions = [];                            // drop every remembered device
  await user.save();

  return { message: 'Password updated. Please sign in with your new password.' };
}

// Phase 21: like account deletion, clearing all data needs BOTH the password AND an
// owner-only step-up approval — no other trusted person can authorize it.
async function clearData(userId, password, stepUpToken) {
  if (!password) throw new HttpError(400, 'Password is required to confirm');

  const user = await User.findById(userId);
  // 400 (not 401) — a wrong password must never trigger the client's expired-session auto-logout.
  if (!user || !(await user.comparePassword(password))) {
    throw new HttpError(400, 'Incorrect password');
  }
  await require('./stepup.service').requireOwnerStepUp(userId, stepUpToken, 'Clearing all data');

  await Promise.all([
    Customer.deleteMany({ user_id: userId }),
    Bill.deleteMany({ user_id: userId }),
    Payment.deleteMany({ user_id: userId }),
    RentalCharge.deleteMany({ user_id: userId }), // charges reference the deleted customers
    require('../models/FillingLogEntry').deleteMany({ user_id: userId }),
    require('../models/LocationPcStock').deleteMany({ user_id: userId })
  ]);

  return { message: 'All data cleared successfully' };
}

module.exports = {
  signupRequest, signupConfirm, signin, verify2fa, refresh, clearData,
  listSessions, revokeSession,
  sendEmailVerification, confirmEmailVerification, securityStatus,
  requestPasswordReset, resetPassword
};
