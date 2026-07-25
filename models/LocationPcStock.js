const mongoose = require('mongoose');
const { LOCATIONS } = require('../config/locations');

// Per-location personal-cylinder (PC) stock by gas+size (Phase 11). A separate, additional
// tracked value alongside the per-customer PC balance (which remains the source of truth for
// customer-facing checks). Fully recomputed from bill line items on every bill save/delete:
//   customer bill at location L → qty += personalCylindersIn − personalCylindersOut
//   internal transfer PC lines  → from_location −= qty, to_location += qty
const locationPcStockSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  location: { type: String, enum: LOCATIONS, required: true },
  gas_type: { type: String, required: true },
  capacity: { type: String, required: true },
  qty: { type: Number, default: 0 }
}, { timestamps: true });

locationPcStockSchema.index({ user_id: 1, location: 1, gas_type: 1, capacity: 1 }, { unique: true });

module.exports = mongoose.model('LocationPcStock', locationPcStockSchema);
