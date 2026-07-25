const crypto = require('crypto');
const OtpToken = require('../models/OtpToken');
const HttpError = require('../utils/HttpError');
const { sendMail, isConfigured } = require('../utils/mailer');

// Email OTPs (Phase 17) — one reusable pipeline for: user email verification, Trusted Person
// email verification, and the OTP step-up path. Codes are 6 digits, valid 10 minutes, single
// use, max 5 wrong attempts, stored hashed.
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const hash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const SUBJECTS = {
  USER_EMAIL_VERIFY: 'CylinderPro — verify your email',
  TP_EMAIL_VERIFY: 'CylinderPro — verify your email (Trusted Person)',
  STEP_UP: 'CylinderPro — approval code'
};

// Sends a fresh code for purpose+target (invalidating any earlier unconsumed one) via real
// SMTP (Phase 19). The code is NEVER returned to the client. If sending fails (or SMTP is
// not configured), the code is logged on the SERVER console only, as a silent fallback the
// operator can read — the user just sees that delivery didn't happen.
// `context` (Phase 21): optional human-readable description of what is being authorized —
// e.g. "delete Bill B-0042 for Shree Traders" — included in the email body so the approver
// sees WHAT they are approving, not just a bare code. Client-supplied text: control
// characters are stripped and length capped before it goes into the email.
const cleanContext = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 300);

async function sendOtp({ userId, purpose, email, trustedPersonId = null, context = '' }) {
  if (!SUBJECTS[purpose]) throw new HttpError(400, 'Unknown OTP purpose');
  if (!email) throw new HttpError(400, 'An email address is required');

  await OtpToken.deleteMany({ user_id: userId, purpose, email: email.toLowerCase(), trusted_person_id: trustedPersonId, consumed: false });

  const code = newCode();
  await OtpToken.create({
    user_id: userId, purpose, email: email.toLowerCase(),
    trusted_person_id: trustedPersonId,
    code_hash: hash(code),
    expires_at: new Date(Date.now() + OTP_TTL_MS)
  });

  const ctx = cleanContext(context);
  let sent = false;
  try {
    ({ sent } = await sendMail({
      to: email,
      subject: SUBJECTS[purpose],
      text: `${ctx ? `Authorization requested: ${ctx}\n\n` : ''}Your CylinderPro verification code is: ${code}\n\nIt expires in 10 minutes. If you didn't request this, ignore this email.`
    }));
  } catch (e) {
    // Server-side-only fallback: never surfaces the code to the client.
    console.error(`OTP email to ${email} failed (${e.message}) — code for ${purpose}: ${code}`);
  }

  return {
    message: sent ? `Code sent to ${email}` : `Could not send the email to ${email} — check the address or contact the administrator.`,
    email_sent: sent
  };
}

// Validates and consumes the newest matching code. Throws HttpError(400) on any failure.
async function verifyOtp({ userId, purpose, email, trustedPersonId = null, code }) {
  if (!code || !/^\d{6}$/.test(String(code).trim())) throw new HttpError(400, 'Enter the 6-digit code');
  const query = { user_id: userId, purpose, consumed: false, expires_at: { $gt: new Date() } };
  if (email) query.email = email.toLowerCase();
  if (trustedPersonId) query.trusted_person_id = trustedPersonId;

  const token = await OtpToken.findOne(query).sort('-createdAt');
  if (!token) throw new HttpError(400, 'No active code found — request a new one.');
  if (token.attempts >= MAX_ATTEMPTS) throw new HttpError(400, 'Too many wrong attempts — request a new code.');

  if (token.code_hash !== hash(String(code).trim())) {
    token.attempts += 1;
    await token.save();
    throw new HttpError(400, `Incorrect code (${MAX_ATTEMPTS - token.attempts} attempt(s) left).`);
  }

  token.consumed = true;
  await token.save();
  return true;
}

module.exports = { sendOtp, verifyOtp };
