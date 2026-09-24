const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10; // minimum per security policy

const userSchema = new mongoose.Schema({
  name:  { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  // Phase GEN-C: 8-character [A-Z0-9] code derived ONCE at signup from this account's _id
  // (services/numbering.service.js). Stored, never re-derived on read, and immutable because bill
  // and receipt identities are built on it. Never shown in the UI, on a printed document, or in a
  // bill/payment/certificate API response (middleware/stripInternalIds.js).
  // Accounts created before 24 Sep 2026 carry a code from the older salted derivation; that is
  // correct and permanent — nothing ever recomputes a stored code. Indexed below, uniquely.
  account_code: { type: String, default: '', immutable: true },
  password: { type: String, required: true },
  phone: { type: String, default: '' },
  // Site the user is currently "operating as" — drives UI defaults only (never rewrites data).
  // Phase GEN-B1: no enum — locations are per-user and live in LocationProfile. Validity is
  // checked in the service layer via location.service.isValidLocation(); a schema enum here
  // would reject any location a user adds later.
  // No default: which site a user "operates as" is answered from their own location registry
  // (location.service.defaultLocationCode) the first time it is read, not by a literal here that
  // named one client's plant for every account.
  active_location: {
    type: String,
    default: ''
  },
  // R162: where this account stands between "emptied for a restore" and "restore finished".
  //   none                   — normal use (every account, always, unless one of the two below)
  //   empty_pending_restore  — Empty This Account ran; waiting for a backup to be restored or for
  //                            the owner to cancel. New business records are refused meanwhile.
  //   restore_in_progress    — a restore has started writing (or died while writing). Every change
  //                            to the account is refused until it finishes or is cleared.
  // Written ONLY by Empty This Account, a restore starting/finishing, and the cancel/recovery
  // actions in Settings → Data & Privacy. Never by signup (which just takes the default). An
  // account created before 25 Sep 2026 has no field at all, which reads as 'none'.
  restore_state: {
    type: String,
    enum: ['none', 'empty_pending_restore', 'restore_in_progress'],
    default: 'none'
  },
  last_login: { type: Date },
  // Incremented by "Log Out All Sessions" — any JWT issued with an older value is rejected.
  token_version: { type: Number, default: 0 },
  // Login-email verification (Phase 17): set true after the emailed 6-digit OTP is entered.
  // Never blocks login or use — only drives the non-blocking reminder banner.
  email_verified: { type: Boolean, default: false },
  // Active sessions/devices (Phase 17). Every JWT carries a sid; the middleware rejects
  // tokens whose sid is no longer in this list (= revoked). "Remember this device" issues
  // a 90-day session, otherwise 24h (matching the old flat behavior).
  sessions: {
    type: [{
      sid:        { type: String, required: true },
      device:     { type: String, default: '' },   // browser user-agent
      ip:         { type: String, default: '' },
      remember:   { type: Boolean, default: false },
      created_at: { type: Date, default: Date.now },
      last_active:{ type: Date, default: Date.now },
      expires_at: { type: Date, required: true }
    }],
    default: []
  }
}, { timestamps: true });

// Two accounts must never share a code: bills, receipts and certificates are unique per
// (account_code, financial_year, number), so a shared code would let one client's numbers collide
// with another's. A collision is astronomically unlikely, but this makes one fail loudly at signup
// (inside its transaction) instead of silently. Partial, so the '' default never counts as a value.
userSchema.index(
  { account_code: 1 },
  { name: 'account_code_unique', unique: true, partialFilterExpression: { account_code: { $gt: '' } } }
);

userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
});

userSchema.methods.comparePassword = function(plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('User', userSchema);
