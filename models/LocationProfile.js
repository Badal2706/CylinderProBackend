const mongoose = require('mongoose');
const { LOCATION_LABELS } = require('../config/locations');

// One per (user, location). Phase GEN-B1: this collection is now the AUTHORITATIVE REGISTRY of
// which locations exist for a user and which one fills cylinders — it is no longer a decoration on
// top of a fixed 3-entry config array. config/locations.js survives only as the seed list for a
// brand-new user and as a migration fallback; nothing at runtime may treat it as the truth.
//
// `location` is the permanent code and stays immutable: Cylinder.location, Bill.location /
// from_location / to_location and CylinderHistory reference it as a bare string forever, so
// renaming one would silently orphan history — the same permanence rule as bill_number.
// `label` is the display name and IS editable; it is what prints and what the UI shows.
const locationProfileSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  location: {
    type: String,
    required: true,
    trim: true,
    immutable: true
  },
  // Replaces the static LOCATION_LABELS map — every location carries its own display name.
  label: { type: String, required: true, trim: true },
  // The site that fills cylinders. At most ONE per user (see the partial unique index below).
  // Everything anchored on "Chandisar" before GEN-B1 now anchors on whichever site this is:
  // DSR/Stock Summary transfer classification, the maintenance gate, the gas-type/capacity edit
  // gate, and filling-log entries. A user may have none, in which case those rules have no anchor
  // and transfers stay flagged/unclassified — the same path Palanpur↔Chhapi already took.
  is_filling_location: { type: Boolean, default: false },
  manager_name: { type: String, default: '', trim: true },
  contact_number: { type: String, default: '', trim: true },
  // Locked challan prefix for bills at this site (e.g. "C-", "P-", "CHHAPI-").
  challan_prefix: { type: String, default: '', trim: true }
}, { timestamps: true });

// A record for one of the original seed sites can fill in its own label, so every pre-GEN-B1
// caller that creates a LocationProfile without one keeps working. A location code the seed map
// does not know still has to supply a label explicitly — otherwise a new site would silently be
// named after its raw code (e.g. "AT_DEPOT_02") and nobody would notice until it printed.
locationProfileSchema.pre('validate', function () {
  if ((this.label === undefined || this.label === null || String(this.label).trim() === '') &&
      LOCATION_LABELS[this.location]) {
    this.label = LOCATION_LABELS[this.location];
  }
});

locationProfileSchema.index({ user_id: 1, location: 1 }, { unique: true });

// "At most one filling location per user" enforced by the DATABASE, not just by service code —
// a partial index so the many `false` rows don't collide with each other.
locationProfileSchema.index(
  { user_id: 1, is_filling_location: 1 },
  { unique: true, partialFilterExpression: { is_filling_location: true } }
);

module.exports = mongoose.model('LocationProfile', locationProfileSchema);
