const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10; // minimum per security policy

const userSchema = new mongoose.Schema({
  name:  { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  phone: { type: String, default: '' },
  // Site the user is currently "operating as" — drives UI defaults only (never rewrites data).
  active_location: {
    type: String,
    enum: ['AT_PLANT_CHANDISAR', 'AT_PALANPUR_OFFICE', 'AT_CHHAPI_OFFICE'],
    default: 'AT_PLANT_CHANDISAR'
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

userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
});

userSchema.methods.comparePassword = function(plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('User', userSchema);
