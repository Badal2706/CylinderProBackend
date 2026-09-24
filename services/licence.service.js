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
// A licence is the ONLY way to create an account. The legacy DEVELOPER_TOKEN fallback — one
// static string, no expiry, bound to no address, able to create unlimited accounts — was removed
// on 24 Sep 2026, in the same deploy that issued production its first licence.

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

// Is this licence usable, by this address, right now? Returns { licence }; throws for anything
// unusable.
async function validateForSignup(key, email) {
  const submitted = String(key || '').trim();
  const addr = String(email || '').trim().toLowerCase();
  if (!submitted) throw new HttpError(403, 'A licence number is required to create an account');

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

  return { licence };
}

// Bind a validated licence to the account that was just created.
//
// The guard `used_by: null` inside the query is what makes this safe: two signups racing on the
// same licence both pass validation, and exactly one wins the update. The loser is told the
// licence is taken rather than silently sharing it.
//
// `session` lets signup run this inside the same transaction that creates the account, so a crash
// between the two can never leave a live account with no licence bound.
async function claim(licenceId, userId, email, { session = null } = {}) {
  const now = new Date();
  const bound = await Licence.findOneAndUpdate(
    { _id: licenceId, used_by: null, revoked_at: null },
    {
      $set: { used_by: userId, used_at: now },
      $push: { history: { user_id: userId, email: String(email || '').toLowerCase(), bound_at: now, released_at: null } }
    },
    { new: true, session }
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

// Bind a NEW licence to an account that already exists.
//
// For an account created before licences existed (the legacy DEVELOPER_TOKEN signup), so it is
// covered by the licence system like every account created since: the licence is spent while the
// account exists, and freed if the account is ever deleted. Signup is the only other path that
// binds a licence, and it cannot help here — it binds while CREATING an account.
//
// Nothing is written onto the User: a binding lives entirely on the Licence (used_by, used_at,
// history), exactly as signup leaves it.
//
// The caller passes both the email and the id and they must name the same account — a typo in
// either refuses rather than binding a licence to the wrong client. Returns the plaintext key
// ONCE, like issueLicence.
async function bindToExistingAccount({ email, userId, note = '' } = {}) {
  const User = require('../models/User');
  const addr = String(email || '').trim().toLowerCase();
  if (!addr || !userId) throw new HttpError(400, 'Both the account email and its id are required');

  const user = await User.findById(userId).select('email').lean();
  if (!user) throw new HttpError(404, 'No account has that id');
  if (user.email !== addr) {
    throw new HttpError(400, `That id belongs to ${user.email}, not ${addr} — refusing to bind`);
  }
  const existing = await Licence.findOne({ used_by: user._id }).select('key_prefix').lean();
  if (existing) {
    throw new HttpError(409, `This account already holds licence ${existing.key_prefix}… — nothing to bind`);
  }

  const issued = await issueLicence({ email: addr, note });
  try {
    await claim(issued.licence_id, user._id, addr);
  } catch (e) {
    // The licence was minted for this bind alone and nobody else has seen its key; remove it
    // rather than leave an unused licence for this address lying around.
    await Licence.deleteOne({ _id: issued.licence_id });
    throw e;
  }
  return { ...issued, bound_to: String(user._id) };
}

// Keep the licence's address in step with the account's login email.
//
// A licence may only create an account for the address it names (validateForSignup). If the client
// later changes their login email, the record still named the OLD address — so were the account
// ever deleted, they could not sign up again at the address they now use. Called once an email
// change is confirmed. history[] is left alone: each entry is a snapshot of the binding as it was.
async function syncEmailForUser(userId, newEmail) {
  const addr = String(newEmail || '').trim().toLowerCase();
  if (!addr) return null;
  const r = await Licence.updateOne({ used_by: userId }, { $set: { email: addr } });
  return r.matchedCount ? { updated: true, email: addr } : null;
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
  bindToExistingAccount,
  syncEmailForUser,
  releaseForUser,
  listLicences,
  revokeLicence
};
