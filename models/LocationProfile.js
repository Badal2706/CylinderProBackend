const mongoose = require('mongoose');
const { LOCATIONS } = require('../config/locations');

// One per (user, location) — fixed set of 3 per user, seeded on migration / lazily on first read.
// `location` is immutable after creation; only manager/contact/challan_prefix are user-editable.
// BusinessProfile (name/address/GST/logo) stays a SINGLE shared record — this model does not duplicate it.
const locationProfileSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  location: {
    type: String,
    enum: LOCATIONS,
    required: true,
    immutable: true
  },
  manager_name: { type: String, default: '', trim: true },
  contact_number: { type: String, default: '', trim: true },
  // Locked challan prefix for bills at this site (e.g. "C-", "P-", "CHHAPI-").
  challan_prefix: { type: String, default: '', trim: true }
}, { timestamps: true });

locationProfileSchema.index({ user_id: 1, location: 1 }, { unique: true });

module.exports = mongoose.model('LocationProfile', locationProfileSchema);
