const mongoose = require('mongoose');

// Gas type → its own scoped list of valid cylinder sizes (Phase 10).
// This collection is the runtime source of truth for an account's gas/size catalog. Each account
// gets its own copy of config/gasCapacities.js at signup, then manages it from
// Profile → Gas Types & Cylinder Sizes.
// The flat CylinderSize collection is kept alongside it because bill line items reference
// sizes by id — new sizes added here are upserted there too.
const gasCapacitySchema = new mongoose.Schema({
  // The account this catalog entry belongs to (24 Sep 2026). Catalogs used to be one global set
  // shared by every account in the database — one tenant adding "Helium" added it to everyone's
  // dropdowns, and deleting a size removed it for everyone. Each account now owns its own copy,
  // seeded from config/gasCapacities.js at signup (masters.service.seedDefaultCatalog).
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  gas_type_name: { type: String, required: true },
  sizes: { type: [String], default: [] }
}, { timestamps: true });

// One size list per gas per account; user_id leads so it also serves every per-account query.
gasCapacitySchema.index({ user_id: 1, gas_type_name: 1 }, { unique: true });

module.exports = mongoose.model('GasCapacity', gasCapacitySchema);
