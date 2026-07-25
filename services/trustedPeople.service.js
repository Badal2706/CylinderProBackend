const TrustedPerson = require('../models/TrustedPerson');
const HttpError = require('../utils/HttpError');
const otp = require('./otp.service');
const totp = require('./totp.service');
const audit = require('./audit.service');

const MAX_PEOPLE = 5;

// Phase 18: list management (add/edit/remove) is step-up-gated — but only once someone CAN
// approve. With zero active people (first-ever add, e.g. right after signup) the gate would
// be a dead-lock, so it stays open until the first person is active.
async function assertListChangeApproved(userId, stepUp, actionLabel) {
  const activeCount = await TrustedPerson.countDocuments({ user_id: userId, is_active: true });
  if (activeCount > 0 && !stepUp) {
    throw new HttpError(403, `${actionLabel} requires approval — verify with a trusted person first.`);
  }
  return activeCount;
}

// Public shape — the TOTP secret NEVER leaves the backend outside the enrollment QR step.
const toPublic = (p) => ({
  person_id: p._id,
  name: p.name,
  email: p.email,
  email_verified: p.email_verified,
  totp_enabled: p.totp_enabled,
  is_active: p.is_active,
  is_bootstrap: !!p.is_bootstrap,
  added_at: p.added_at
});

async function list(userId) {
  const people = await TrustedPerson.find({ user_id: userId }).sort('added_at');
  return people.map(toPublic);
}

// Add = create INACTIVE + send the email OTP. The person becomes active only after
// verify-email succeeds (bootstrap owner record is created active by the migration).
async function add(userId, { name, email }, stepUp = null) {
  await assertListChangeApproved(userId, stepUp, 'Adding a trusted person');
  if (!name || !String(name).trim()) throw new HttpError(400, 'Name is required');
  if (!email || !/^\S+@\S+\.\S+$/.test(String(email).trim())) throw new HttpError(400, 'A valid email is required');
  const clean = String(email).trim().toLowerCase();

  const count = await TrustedPerson.countDocuments({ user_id: userId });
  if (count >= MAX_PEOPLE) throw new HttpError(400, `Up to ${MAX_PEOPLE} trusted people are allowed — remove one first.`);
  const dup = await TrustedPerson.findOne({ user_id: userId, email: clean });
  if (dup) throw new HttpError(400, `${clean} is already on the trusted people list.`);

  const person = await TrustedPerson.create({
    user_id: userId, name: String(name).trim(), email: clean,
    email_verified: false, is_active: false
  });
  const sent = await otp.sendOtp({ userId, purpose: 'TP_EMAIL_VERIFY', email: clean, trustedPersonId: person._id });
  if (stepUp) {
    await audit.record({ userId, action: 'TRUSTED_PEOPLE_CHANGE', target: person.name, detail: `Added trusted person ${person.name} <${clean}>`, stepUp });
  }
  return { person: toPublic(person), ...sent };
}

async function resendOtp(userId, personId) {
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  if (person.email_verified) throw new HttpError(400, 'This email is already verified.');
  return otp.sendOtp({ userId, purpose: 'TP_EMAIL_VERIFY', email: person.email, trustedPersonId: person._id });
}

async function verifyEmail(userId, personId, code) {
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  if (person.email_verified) return { message: 'Already verified', person: toPublic(person) };
  await otp.verifyOtp({ userId, purpose: 'TP_EMAIL_VERIFY', email: person.email, trustedPersonId: person._id, code });
  person.email_verified = true;
  person.is_active = true;
  await person.save();
  // Phase 21: the bootstrap entry and User.email_verified track the SAME address — verifying
  // through either path must land on both, or the banner and the table disagree.
  if (person.is_bootstrap) {
    const User = require('../models/User');
    await User.updateOne({ _id: userId, email: person.email }, { email_verified: true });
  }
  return { message: `${person.name} is now verified and active.`, person: toPublic(person) };
}

async function update(userId, personId, { name }, stepUp = null) {
  await assertListChangeApproved(userId, stepUp, 'Editing a trusted person');
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  // The bootstrap (account owner) entry is immutable here (Phase 20) — its name/email
  // follow Account Information instead.
  if (person.is_bootstrap) {
    throw new HttpError(400, 'This is the account owner\'s entry — edit it via Account Information; it cannot be changed here.');
  }
  const oldName = person.name;
  if (name && String(name).trim()) person.name = String(name).trim();
  await person.save();
  if (stepUp) {
    await audit.record({ userId, action: 'TRUSTED_PEOPLE_CHANGE', target: person.name, detail: `Renamed ${oldName} → ${person.name}`, stepUp });
  }
  return { message: 'Updated', person: toPublic(person) };
}

async function remove(userId, personId, stepUp = null) {
  await assertListChangeApproved(userId, stepUp, 'Removing a trusted person');
  const person = await TrustedPerson.findOne({ _id: personId, user_id: userId });
  if (!person) throw new HttpError(404, 'Trusted person not found');
  if (person.is_bootstrap) {
    throw new HttpError(400, 'The account owner\'s entry cannot be removed from the trusted people list.');
  }
  await TrustedPerson.deleteOne({ _id: person._id });
  if (stepUp) {
    await audit.record({ userId, action: 'TRUSTED_PEOPLE_CHANGE', target: person.name, detail: `Removed trusted person ${person.name} <${person.email}>`, stepUp });
  }
  return { message: `${person.name} removed from trusted people.` };
}

// ─── Bootstrap entry lifecycle (Phase 20) ───
// Created automatically at signup (and by the Phase 17 migration); mirrors Account
// Information. Unverified until the owner completes the email OTP.
async function createBootstrap(userId, { name, email }) {
  const exists = await TrustedPerson.findOne({ user_id: userId, is_bootstrap: true });
  if (exists) return exists;
  return TrustedPerson.create({
    user_id: userId,
    name: String(name || 'Account owner').trim(),
    email: String(email).toLowerCase(),
    is_bootstrap: true,
    email_verified: false,
    is_active: false
  });
}

// Account Information saves propagate here. An email CHANGE resets the entry's verification
// (it's a new address) — approvals from it are blocked until the new address verifies.
async function syncBootstrap(userId, { name, email }) {
  const boot = await TrustedPerson.findOne({ user_id: userId, is_bootstrap: true });
  if (!boot) return null;
  if (name && String(name).trim() && boot.name !== String(name).trim()) boot.name = String(name).trim();
  const clean = email ? String(email).toLowerCase() : null;
  if (clean && boot.email !== clean) {
    const dup = await TrustedPerson.findOne({ user_id: userId, email: clean, _id: { $ne: boot._id } });
    if (dup) throw new HttpError(400, `${clean} already belongs to another trusted person — remove them first or use a different email.`);
    boot.email = clean;
    boot.email_verified = false;
  }
  await boot.save();
  return boot;
}

async function totpEnroll(userId, personId) {
  return totp.startEnrollment(userId, personId);
}

async function totpConfirm(userId, personId, code) {
  return totp.confirmEnrollment(userId, personId, code);
}

module.exports = { list, add, resendOtp, verifyEmail, update, remove, totpEnroll, totpConfirm, toPublic, createBootstrap, syncBootstrap };
