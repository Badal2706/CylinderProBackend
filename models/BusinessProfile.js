const mongoose = require('mongoose');

// One business profile per user — shown on bill headers / printed PDFs.
const businessProfileSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  business_name: { type: String, default: 'GURU Industries' },
  business_address: { type: String, default: '' },
  business_phone: { type: String, default: '' },
  gst_number: { type: String, default: '' },
  // Optional logo stored as a data URL (data:image/png;base64,...). Kept small.
  logo: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('BusinessProfile', businessProfileSchema);
