const mongoose = require('mongoose');

// Gas type → its own scoped list of valid cylinder sizes (Phase 10).
// This collection is the runtime source of truth for the gas/size catalog; it is seeded once
// from config/gasCapacities.js and from the sizes actually present in inventory
// (scripts/migratePhase10.js), then managed from Profile → Gas Types & Cylinder Sizes.
// The flat CylinderSize collection is kept alongside it because bill line items reference
// sizes by id — new sizes added here are upserted there too.
const gasCapacitySchema = new mongoose.Schema({
  gas_type_name: { type: String, required: true, unique: true },
  sizes: { type: [String], default: [] }
}, { timestamps: true });

module.exports = mongoose.model('GasCapacity', gasCapacitySchema);
