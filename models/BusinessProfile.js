const mongoose = require('mongoose');

// One business profile per user — shown on bill headers / printed PDFs.
const businessProfileSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  // Phase GEN-A: no business-identity default may live in code — a blank default is what keeps
  // one client's name from appearing on another client's letterhead. Seeded per user by
  // scripts/migrateGenA_branding.js instead.
  business_name: { type: String, default: '' },
  business_address: { type: String, default: '' },
  business_phone: { type: String, default: '' },
  gst_number: { type: String, default: '' },
  // Phase GEN-A: letterhead lines previously hardcoded in the print template. Each prints
  // EXACTLY as typed (case and line breaks preserved) and is omitted entirely when blank.
  certification_line: { type: String, default: '' },
  business_email: { type: String, default: '' },
  products_line: { type: String, default: '' },
  // Contact box on the letterhead: one entry per block of text, printed in order, each verbatim
  // (a newline typed in the field is a newline on the page). Deliberately NOT read from
  // LocationProfile.contact_number — the number a site is administered by and the number printed
  // on a challan are allowed to differ. An ordered array rather than three named fields so a
  // fourth site (F-02) needs no schema change.
  contact_lines: { type: [String], default: [] },
  // Printed logo size as a percentage of its normal size. 100 = today's appearance. The logo
  // scales on its own; letterhead text size is unaffected.
  logo_scale: { type: Number, default: 100 },
  // Optional logo stored as a data URL (data:image/png;base64,...). Kept small.
  logo: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('BusinessProfile', businessProfileSchema);
