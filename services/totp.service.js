const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const TrustedPerson = require('../models/TrustedPerson');
const HttpError = require('../utils/HttpError');

// Per-person TOTP (Phase 17). Every Trusted Person enrolls their own Google Authenticator
// with their OWN secret — there is no shared account-level code. Validation for the step-up
// TOTP path checks a submitted code against EVERY active enrolled person's secret and
// accepts if any single one matches.
authenticator.options = { window: 1 }; // ±30s clock drift tolerance

// Step 1 of enrollment: (re)generate this person's secret and return the QR to scan.
// totp_enabled stays false until the person confirms with a first valid code.
async function startEnrollment(userId, personId) {
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  if (!person.is_active) throw new HttpError(400, 'Verify this person\'s email first — only active people can enroll an authenticator.');

  const secret = authenticator.generateSecret();
  person.totp_secret = secret;
  person.totp_enabled = false;
  await person.save();

  const otpauth_url = authenticator.keyuri(person.email, 'CylinderPro', secret);
  const qr = await qrcode.toDataURL(otpauth_url);
  return { otpauth_url, qr, secret };
}

// Step 2: first code from the authenticator app proves the scan worked.
async function confirmEnrollment(userId, personId, code) {
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  if (!person.totp_secret) throw new HttpError(400, 'Start enrollment first to get a QR code.');
  if (!authenticator.verify({ token: String(code || '').trim(), secret: person.totp_secret })) {
    throw new HttpError(400, 'That code doesn\'t match — check the authenticator app and try again.');
  }
  person.totp_enabled = true;
  await person.save();
  return { message: `Authenticator enabled for ${person.name}` };
}

// Step-up TOTP path: no person pre-selected — accept if the code matches ANY active,
// enrolled person's individual secret. Returns the matching person or null.
// Phase 20: a matching code from a person whose email is NOT verified is rejected with a
// clear "verify email first" error instead of a generic mismatch.
async function validateAny(userId, code) {
  const token = String(code || '').trim();
  if (!/^\d{6}$/.test(token)) return null;
  const people = await TrustedPerson.find({ user_id: userId, is_active: true, totp_enabled: true });
  for (const p of people) {
    if (p.totp_secret && authenticator.verify({ token, secret: p.totp_secret })) {
      if (!p.email_verified) {
        throw new HttpError(403, `${p.name}'s email is not verified — they must verify their email before approving actions.`);
      }
      return p;
    }
  }
  return null;
}

// ─── Phase 25: rotation triggered by an account email change ───
// Called from profile.updateAccount. Rotates the bootstrap person (the account owner's own
// Trusted People entry, whose name/email track Account Information) onto a fresh secret.
//
// Safety property: totp_secret and totp_enabled are NOT touched. The old authenticator keeps
// working for step-up until the user proves they scanned the new QR, so there is no window in
// which the account has no working 2FA — and abandoning the flow changes nothing.
async function beginRotationForAccountEmail(userId, oldEmail, newEmail) {
  const person = await TrustedPerson.findOne({
    user_id: userId,
    $or: [{ is_bootstrap: true }, { email: String(oldEmail || '').toLowerCase() }]
  });
  if (!person) return null; // nothing enrolled against this address — nothing to rotate

  person.email = String(newEmail).toLowerCase();
  person.totp_pending_secret = authenticator.generateSecret();
  person.totp_pending_since = new Date();
  await person.save();

  const otpauth_url = authenticator.keyuri(person.email, 'CylinderPro', person.totp_pending_secret);
  const qr = await qrcode.toDataURL(otpauth_url);
  return {
    person_id: String(person._id),
    name: person.name,
    email: person.email,
    otpauth_url,
    qr,
    secret: person.totp_pending_secret,
    had_previous: !!(person.totp_secret && person.totp_enabled)
  };
}

// On-demand rotation (Phase 27): re-issue a fresh QR for an already-enrolled person at any time
// — e.g. the owner chose "Not now" during an email-change rotation and later wants to redo it,
// or someone re-installs their authenticator app. Same safety property as above: the existing
// secret keeps working until the new QR is confirmed, so 2FA is never disabled. If the person
// has no secret yet, this behaves like a normal fresh enrollment via the pending slot.
async function beginRotation(userId, personId) {
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  if (!person.is_active) throw new HttpError(400, 'Verify this person\'s email first.');

  person.totp_pending_secret = authenticator.generateSecret();
  person.totp_pending_since = new Date();
  await person.save();

  const otpauth_url = authenticator.keyuri(person.email, 'CylinderPro', person.totp_pending_secret);
  const qr = await qrcode.toDataURL(otpauth_url);
  return {
    person_id: String(person._id),
    name: person.name,
    email: person.email,
    otpauth_url,
    qr,
    secret: person.totp_pending_secret,
    had_previous: !!(person.totp_secret && person.totp_enabled)
  };
}

// Confirm a rotation: a valid code from the NEW QR promotes the pending secret. Only at this
// point does the old secret stop working.
async function confirmRotation(userId, personId, code) {
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  if (!person.totp_pending_secret) throw new HttpError(400, 'No authenticator change is pending.');
  if (!authenticator.verify({ token: String(code || '').trim(), secret: person.totp_pending_secret })) {
    throw new HttpError(400, 'That code doesn\'t match the new QR — scan it again and retry.');
  }
  person.totp_secret = person.totp_pending_secret;
  person.totp_enabled = true;
  person.totp_pending_secret = '';
  person.totp_pending_since = null;
  await person.save();
  return { message: `Authenticator updated for ${person.name}. The previous code no longer works.` };
}

// Abandon a pending rotation without touching the working secret.
async function cancelRotation(userId, personId) {
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  person.totp_pending_secret = '';
  person.totp_pending_since = null;
  await person.save();
  return { message: 'Authenticator change cancelled — your existing code still works.' };
}

module.exports = {
  startEnrollment, confirmEnrollment, validateAny,
  beginRotationForAccountEmail, beginRotation, confirmRotation, cancelRotation
};
