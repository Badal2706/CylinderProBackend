const jwt = require('jsonwebtoken');
const TrustedPerson = require('../models/TrustedPerson');
const HttpError = require('../utils/HttpError');
const otp = require('./otp.service');
const totp = require('./totp.service');

const JWT_SECRET = process.env.JWT_SECRET;
const STEP_UP_TTL = '10m';

// Step-up verification (Phase 17) — the reusable approval check Phase 18's gated actions
// will consume. Two paths, both ending in a short-lived signed step-up token:
//   OTP : caller picks ONE active Trusted Person; a 6-digit code goes to that person's
//         email and is validated against that specific request.
//   TOTP: caller enters a 6-digit authenticator code with no person selected; it is checked
//         against every active person's individual secret (never a shared code).
// Phase 21: `scope` marks what a token may authorize — 'any' (the default; any Trusted
// Person, used by every Phase 18 gate) or 'owner' (only the bootstrap account-owner entry;
// required for account deletion / clear-all-data). Pre-Phase-21 tokens carry no scope and
// are treated as 'any'.
const issueToken = (userId, via, person, scope = 'any') => jwt.sign(
  { id: String(userId), step_up: true, via, scope, person_id: String(person._id), person_name: person.name },
  JWT_SECRET,
  { expiresIn: STEP_UP_TTL }
);

const assertOwnerCapable = (person) => {
  if (!person.is_bootstrap) {
    throw new HttpError(403, `Only the account owner can approve this action — ${person.name} is a trusted person, but this approval is restricted to the owner.`);
  }
};

async function sendStepUpOtp(userId, personId, { context = '', ownerOnly = false } = {}) {
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  if (ownerOnly) assertOwnerCapable(person);
  if (!person.email_verified) throw new HttpError(400, `${person.name}'s email is not verified — they must verify their email before approving actions.`);
  if (!person.is_active) throw new HttpError(400, `${person.name} is not active yet — verify their email first.`);
  const result = await otp.sendOtp({ userId, purpose: 'STEP_UP', email: person.email, trustedPersonId: person._id, context });
  return { ...result, person_id: person._id, person_name: person.name };
}

async function verifyStepUpOtp(userId, personId, code, { ownerOnly = false } = {}) {
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId, is_active: true });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  if (ownerOnly) assertOwnerCapable(person);
  // Phase 20: re-checked at verify time too — the email could have changed (and become
  // unverified) between send and verify.
  if (!person.email_verified) {
    throw new HttpError(403, `${person.name}'s email is not verified — they must verify their email before approving actions.`);
  }
  await otp.verifyOtp({ userId, purpose: 'STEP_UP', email: person.email, trustedPersonId: person._id, code });
  const scope = ownerOnly ? 'owner' : 'any';
  return { verified: true, via: 'OTP', approved_by: person.name, step_up_token: issueToken(userId, 'OTP', person, scope) };
}

async function verifyStepUpTotp(userId, code, { ownerOnly = false } = {}) {
  const person = await totp.validateAny(userId, code);
  if (!person) throw new HttpError(400, 'Code not recognized — it doesn\'t match any active trusted person\'s authenticator.');
  // A code that matches a NON-owner is rejected specifically for not being the owner —
  // clearer than a generic mismatch when the person is otherwise fully enrolled.
  if (ownerOnly) assertOwnerCapable(person);
  const scope = ownerOnly ? 'owner' : 'any';
  return { verified: true, via: 'TOTP', approved_by: person.name, step_up_token: issueToken(userId, 'TOTP', person, scope) };
}

// Phase 18 gate helpers. 403 (not 401) so the frontend's expired-session auto-logout on 401
// is never triggered by a missing/expired approval.
// tryStepUp: null when no token given; throws 403 when a token IS given but invalid.
function tryStepUp(userId, token) {
  if (!token) return null;
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { throw new HttpError(403, 'Approval expired or invalid — verify with a trusted person again.'); }
  if (!payload.step_up || (userId && String(payload.id) !== String(userId))) {
    throw new HttpError(403, 'Approval expired or invalid — verify with a trusted person again.');
  }
  return { id: payload.id, via: payload.via, scope: payload.scope || 'any', person_id: payload.person_id, person_name: payload.person_name };
}

function requireStepUp(userId, token, actionLabel = 'This action') {
  const p = tryStepUp(userId, token);
  if (!p) throw new HttpError(403, `${actionLabel} requires approval — verify with a trusted person first.`);
  return p;
}

// Phase 21: owner-only consumption — the token must have been issued in owner-only mode AND
// (defense in depth) its person must still be the account's bootstrap entry right now.
async function requireOwnerStepUp(userId, token, actionLabel = 'This action') {
  const p = tryStepUp(userId, token);
  if (!p) throw new HttpError(403, `${actionLabel} requires the account owner's approval — verify as the owner first.`);
  if (p.scope !== 'owner') {
    throw new HttpError(403, `${actionLabel} requires an OWNER-ONLY approval — a regular trusted-person approval is not enough here. Verify again as the account owner.`);
  }
  const person = await TrustedPerson.findOne({ _id: p.person_id, user_id: userId });
  if (!person || !person.is_bootstrap) {
    throw new HttpError(403, `${actionLabel} can only be approved by the account owner.`);
  }
  return p;
}

// For Phase 18: gated endpoints call this with the token the client obtained above.
function assertStepUpToken(userId, token) {
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { throw new HttpError(401, 'Approval expired or invalid — verify again.'); }
  if (!payload.step_up || String(payload.id) !== String(userId)) {
    throw new HttpError(401, 'Approval expired or invalid — verify again.');
  }
  return payload; // { via, person_id, person_name }
}

module.exports = { sendStepUpOtp, verifyStepUpOtp, verifyStepUpTotp, assertStepUpToken, tryStepUp, requireStepUp, requireOwnerStepUp };
