const mongoose = require('mongoose');

// One-time email codes (Phase 17). A code is bound to a purpose + target (email and/or
// trusted person), stored HASHED, valid 10 minutes, max 5 attempts, single-use.
const otpTokenSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  purpose: {
    type: String,
    enum: ['USER_EMAIL_VERIFY', 'TP_EMAIL_VERIFY', 'STEP_UP'],
    required: true
  },
  email: { type: String, lowercase: true, trim: true, default: '' },
  trusted_person_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TrustedPerson', default: null },
  code_hash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  consumed: { type: Boolean, default: false },
  expires_at: { type: Date, required: true }
}, { timestamps: true });

// Auto-purge expired codes.
otpTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OtpToken', otpTokenSchema);
