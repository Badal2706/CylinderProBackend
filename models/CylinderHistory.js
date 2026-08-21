const mongoose = require('mongoose');
const { LOCATIONS } = require('../config/locations');

// ─── Phase 33: per-cylinder movement/action history ───
// One document per event that changes or concerns a cylinder's state. Purely OBSERVATIONAL —
// nothing here ever writes back to a Cylinder's location/stock_state (that stays owned by the
// Bill post-save hook and the manual-edit endpoint). A rolling window of the 15 most recent
// entries per cylinder is enforced in cylinderHistory.service.logEvents (not a scheduled job).
const cylinderHistorySchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  cylinder_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Cylinder', required: true, index: true },
  // Snapshot of the rotational number at event time — keeps the log readable even if the
  // cylinder is later renamed or deleted.
  rotational_number: { type: String, default: '' },
  event_type: {
    type: String,
    // BILL_DELETED / REMOVED_FROM_BILL record that an entry was undone — without them a cylinder
    // silently reverted with nothing in its log to explain why.
    enum: ['MIGRATED', 'RECEIVED', 'GIVEN', 'TRANSFER', 'FILLED', 'MANUAL_EDIT', 'BILL_DELETED', 'REMOVED_FROM_BILL'],
    required: true
  },
  description: { type: String, default: '' },
  // Before/after values (blank when not relevant to the event).
  from_location: { type: String, default: '' },
  to_location: { type: String, default: '' },
  from_state: { type: String, default: '' },
  to_state: { type: String, default: '' },
  // Related party / document (customer name, bill or challan number).
  customer_name: { type: String, default: '' },
  document_ref: { type: String, default: '' },
  // "Performed by" = the site's Manager Name, resolved from whichever location's session
  // performed the action. performed_at_location keeps that site for a clean fallback label.
  performed_by: { type: String, default: '' },
  performed_at_location: { type: String, enum: [...LOCATIONS, ''], default: '' },
  // When the event happened (may differ from createdAt for back-dated fills / the migration).
  event_at: { type: Date, default: Date.now }
}, { timestamps: true });

// Newest-first per cylinder — powers both the popup read and the rolling-cap trim.
cylinderHistorySchema.index({ user_id: 1, cylinder_id: 1, event_at: -1, createdAt: -1 });

module.exports = mongoose.model('CylinderHistory', cylinderHistorySchema);
