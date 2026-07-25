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

async function signup({ name, email, password, remember, device, ip }) {
  if (!name || !email || !password) {
    throw new HttpError(400, 'Name, email and password are required');
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

  const user = new User({ name, email, password });
  await user.save();

  // Phase 20: the owner automatically becomes the first (bootstrap) Trusted Person —
  // unverified until they complete the email OTP; the reminder banner points at it.
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

  user.last_login = new Date();
  const token = await openSession(user, { remember, device, ip });
  return { token, name: user.name, email: user.email, remember: !!remember };
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
  signup, signin, refresh, clearData,
  listSessions, revokeSession,
  sendEmailVerification, confirmEmailVerification, securityStatus
};
