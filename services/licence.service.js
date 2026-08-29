const Licence = require('../models/Licence');
const HttpError = require('../utils/HttpError');

// ─── Licence numbers: the vendor side of signup ───
//
// models/Licence.js describes the shape; this is the behaviour. Four operations matter:
//
//   issue      the vendor mints a licence for one client's email. The plaintext key is returned
//              ONCE and never again — only its hash is stored.
//   validate   checked before an OTP is sent, so a bad licence fails fast and costs nothing.
//   claim      binds the licence to the account, atomically, after the account exists.
//   release    frees it when that account is deleted, so the client can sign up again.
//
// LEGACY FALLBACK: `DEVELOPER_TOKEN` still works. The droplet is running the old scheme and has
// no licences in its database — if this shipped as licence-only, signup would break there the
// moment it deployed. The fallback keeps that door open until a licence has been issued on
// production, and logs every use so it is visible when the last one goes away.

const DEVELOPER_TOKEN = process.env.DEVELOPER_TOKEN;

// Issue a licence. Returns the plaintext key — the ONLY time it exists outside the client's hands.
async function issueLicence({ email, note = '', expires_at = null } = {}) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
    throw new HttpError(400, 'A valid email address is required to issue a licence');
  }

  const key = Licence.generateKey();
  const licence = await Licence.create({
    key_hash: Licence.hashKey(key),
    key_prefix: key.slice(0, 7),               // "CP-4KQ2" — identifiable, not usable
    email: addr,
    note: String(note || ''),
    expires_at: expires_at ? new Date(expires_at) : null
  });

  return { key, licence_id: licence._id, email: addr, key_prefix: licence.key_prefix,
           expires_at: licence.expires_at };
}

// Is this licence usable, by this address, right now?
//
// Returns { legacy: true } when the submitted value is the old developer token — the caller then
// has nothing to claim or release. Throws for anything unusable.
async function validateForSignup(key, email) {
  const submitted = String(key || '').trim();
  const addr = String(email || '').trim().toLowerCase();
  if (!submitted) throw new HttpError(403, 'A licence number is required to create an account');

  // Legacy path, deliberately checked FIRST so an account that predates licences is unaffected.
  if (DEVELOPER_TOKEN && submitted === DEVELOPER_TOKEN) {
    console.warn(`[licence] signup for ${addr} used the legacy DEVELOPER_TOKEN — issue a licence number instead`);
    return { legacy: true, licence: null };
  }

  const licence = await Licence.findOne({ key_hash: Licence.hashKey(submitted) });
  // Deliberately the same message as a malformed one: an unknown key must not be distinguishable
  // from a wrong one, or this becomes an oracle for guessing.
  if (!licence) throw new HttpError(403, 'Invalid licence number');

  if (licence.email !== addr) {
    // The bound address is NOT named — the holder knows their own, and anyone else should not
    // learn it from an error message.
    throw new HttpError(403, 'This licence number was issued for a different email address');
  }

  const state = licence.isAvailable();
  if (!state.ok) {
    const msg = {
      revoked: 'This licence number has been revoked',
      expired: 'This licence number has expired',
      in_use: 'This licence number is already in use by an existing account. ' +
              'Delete that account first, or ask for a new licence number.'
    }[state.reason] || 'This licence number cannot be used';
    throw new HttpError(403, msg);
  }

  return { legacy: false, licence };
}

// Bind a validated licence to the account that was just created.
//
// The guard `used_by: null` inside the query is what makes this safe: two signups racing on the
// same licence both pass validation, and exactly one wins the update. The loser is told the
// licence is taken rather than silently sharing it.
async function claim(licenceId, userId, email) {
  const now = new Date();
  const bound = await Licence.findOneAndUpdate(
    { _id: licenceId, used_by: null, revoked_at: null },
    {
      $set: { used_by: userId, used_at: now },
      $push: { history: { user_id: userId, email: String(email || '').toLowerCase(), bound_at: now, released_at: null } }
    },
    { new: true }
  );
  if (!bound) {
    throw new HttpError(409, 'That licence number was just used by another signup. Please ask for a new one.');
  }
  return bound;
}

// Free whatever licence is bound to this account, so it can create an account again.
//
// Called from every path that deletes an account. A licence left pointing at a deleted user would
// be permanently unusable — the unique index would still consider it taken — which is the exact
// failure the release step exists to prevent.
async function releaseForUser(userId) {
  const licence = await Licence.findOne({ used_by: userId });
  if (!licence) return null;

  const now = new Date();
  // Stamp the open history entry rather than appending a new one, so the record reads as one
  // binding with a start and an end.
  const open = (licence.history || []).filter(h => !h.released_at);
  await Licence.updateOne(
    { _id: licence._id },
    {
      $set: {
        used_by: null,
        used_at: null,
        ...Object.fromEntries(open.map((h, i) => [`history.${licence.history.indexOf(h)}.released_at`, now]))
      }
    }
  );
  return { licence_id: licence._id, key_prefix: licence.key_prefix, email: licence.email };
}

// The vendor's view. Never returns a key — only its prefix, which cannot be used.
async function listLicences() {
  const rows = await Licence.find().sort({ createdAt: -1 }).lean();
  return rows.map(l => ({
    licence_id: l._id,
    key_prefix: l.key_prefix,
    email: l.email,
    note: l.note || '',
    issued_at: l.issued_at,
    expires_at: l.expires_at,
    revoked_at: l.revoked_at,
    in_use: !!l.used_by,
    used_by: l.used_by || null,
    used_at: l.used_at || null,
    accounts_created: (l.history || []).length
  }));
}

// Kill a licence permanently. An in-use licence stays bound to its account — revoking is about
// preventing FUTURE use, not evicting a client who is already running on it.
async function revokeLicence(licenceId) {
  const licence = await Licence.findById(licenceId);
  if (!licence) throw new HttpError(404, 'Licence not found');
  if (licence.revoked_at) return { message: 'Already revoked', licence_id: licence._id };
  licence.revoked_at = new Date();
  await licence.save();
  return { message: `Licence ${licence.key_prefix}… revoked`, licence_id: licence._id };
}

module.exports = {
  issueLicence,
  validateForSignup,
  claim,
  releaseForUser,
  listLicences,
  revokeLicence
};
