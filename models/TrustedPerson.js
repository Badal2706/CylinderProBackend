const mongoose = require('mongoose');

// Trusted People (Phase 17): the approval list used by step-up verification. Each person has
// their OWN TOTP secret (generated at their own enrollment — never shared or duplicated) and
// their own email, verified by a 6-digit OTP before the person becomes active. Max 5 per user
// (enforced in the service).
const trustedPersonSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name:  { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  // Set true once the 6-digit OTP sent to this address is entered correctly.
  email_verified: { type: Boolean, default: false },
  // Per-person TOTP (Google Authenticator). The secret exists from enrollment start;
  // totp_enabled flips true only after the person confirms with a valid first code.
  totp_secret:  { type: String, default: '' },
  totp_enabled: { type: Boolean, default: false },
  added_at:  { type: Date, default: Date.now },
  // Active = usable for step-up verification. New people activate on email verification;
  // the bootstrap owner record is created active.
  is_active: { type: Boolean, default: false },
  // The account owner's own entry (Phase 20): created automatically at signup/migration,
  // IMMUTABLE — it can never be edited or removed through the Trusted People API; its
  // name/email follow Account Information instead.
  is_bootstrap: { type: Boolean, default: false }
}, { timestamps: true });

trustedPersonSchema.index({ user_id: 1, email: 1 }, { unique: true });

module.exports = mongoose.model('TrustedPerson', trustedPersonSchema);
