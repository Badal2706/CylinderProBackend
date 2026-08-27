const crypto = require('crypto');
const mongoose = require('mongoose');

// ─── Licence numbers (replaces the single shared "developer token") ───
//
// What was wrong before: ONE static string lived in .env and was compared with `!==`. It never
// expired, was not tied to any address, was recorded nowhere, and could create unlimited accounts.
// There was no way to revoke one client's access without changing it for everybody.
//
// A licence now:
//   * is issued to ONE email address, and only that address can use it
//   * binds to exactly one account, and while that account LIVES it cannot create another —
//     so a licence that leaks is worthless as long as its account exists
//   * is released when its account is deleted, and can then be used again
//   * keeps a history of every account it has ever created
//
// The key itself is stored HASHED. It is a bearer secret: anyone holding the string can sign up
// with it, so the database should not be able to hand it back. The plaintext is shown once, at
// issue time, and if a client loses it before signing up the answer is to issue another.
const licenceSchema = new mongoose.Schema({
  // sha256 of the key. The key is high-entropy random, so a fast hash is right here — bcrypt
  // guards against guessing weak human-chosen secrets, which this is not.
  key_hash: { type: String, required: true, unique: true },
  // The first few characters, kept in the clear purely so a licence is identifiable in a list
  // ("CP-4KQ2…"). Not enough to use.
  key_prefix: { type: String, default: '' },

  // The ONLY address this licence may create an account for, matched case-insensitively.
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  note: { type: String, default: '' },          // who it was issued to, free text for the vendor

  issued_at: { type: Date, default: Date.now },
  // null = never expires. An unused licence sitting around is a standing invitation, so a date
  // is worth setting when one is issued for a specific onboarding.
  expires_at: { type: Date, default: null },
  revoked_at: { type: Date, default: null },    // killed by the vendor; never usable again

  // The live binding. null means free.
  used_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  used_at: { type: Date, default: null },

  // Every account this licence has created, including ones since deleted.
  history: [{
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    email: String,
    bound_at: Date,
    released_at: Date
  }]
}, { timestamps: true });

// A licence can be bound to at most one account at a time, enforced by the database rather than
// by application logic. Partial, because `null` (free) repeats freely.
licenceSchema.index(
  { used_by: 1 },
  { unique: true, partialFilterExpression: { used_by: { $type: 'objectId' } } }
);

// Same hash the issuing script uses. Exported so there is exactly one definition of it.
licenceSchema.statics.hashKey = (key) =>
  crypto.createHash('sha256').update(String(key || '').trim()).digest('hex');

// Human-facing format: CP-XXXX-XXXX-XXXX. Unambiguous alphabet (no O/0, I/1) because these get
// read off a screen, written down and typed back in.
licenceSchema.statics.generateKey = function () {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from(crypto.randomBytes(4))
    .map(b => ALPHABET[b % ALPHABET.length]).join('');
  return `CP-${block()}-${block()}-${block()}`;
};

licenceSchema.methods.isAvailable = function (now = new Date()) {
  if (this.revoked_at) return { ok: false, reason: 'revoked' };
  if (this.expires_at && this.expires_at <= now) return { ok: false, reason: 'expired' };
  if (this.used_by) return { ok: false, reason: 'in_use' };
  return { ok: true };
};

module.exports = mongoose.model('Licence', licenceSchema);
