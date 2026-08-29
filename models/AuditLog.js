const mongoose = require('mongoose');

// Step-up authorization audit (Phase 18). One entry per successfully VERIFIED gated action
// (bill edit/delete, over-limit override, profile-section saves) recording WHO approved it
// (which Trusted Person) and by which method (OTP / TOTP). This complements — never replaces —
// the existing edit_history / bill_number_history on the bill itself: those keep recording
// WHAT changed; this records who authorized the change. Deletes live only here (the bill
// document is gone afterwards).
const auditLogSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: {
    type: String,
    enum: ['BILL_EDIT', 'BILL_DELETE', 'OVER_LIMIT_OVERRIDE', 'PROFILE_SAVE', 'MASTERS_CHANGE',
           'TRUSTED_PEOPLE_CHANGE', 'BACKUP_TAKEN'],
    required: true
  },
  target: { type: String, default: '' },  // e.g. bill number, section name, gas type
  detail: { type: String, default: '' },
  // How the action was authorised. 'SESSION' means the logged-in session alone — no trusted
  // person approved it. Backups moved to that in Aug 2026 on the owner's instruction; the log
  // entry is what preserves accountability now that approval no longer gates them.
  via: { type: String, enum: ['OTP', 'TOTP', 'SESSION'], required: true },
  person_id: { type: mongoose.Schema.Types.ObjectId, ref: 'TrustedPerson', default: null },
  person_name: { type: String, default: '' }
}, { timestamps: true });

auditLogSchema.index({ user_id: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
