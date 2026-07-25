const mongoose = require('mongoose');

// Chandisar daily filling log (Phase 11): staff record cylinder numbers as they are
// physically filled through the day. Purely additive data feeding the Chandisar stock
// summary's "Filled Today" figure — it NEVER alters Cylinder.location/stock_state and
// NEVER creates or touches a Bill.
const fillingLogEntrySchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  date: { type: String, required: true },              // 'YYYY-MM-DD' (local day the fill happened)
  rotational_number: { type: String, default: '' },    // optional — quantity-only entries allowed
  gas_type: { type: String, required: true },
  capacity: { type: String, required: true }
}, { timestamps: true });

fillingLogEntrySchema.index({ user_id: 1, date: 1 });

module.exports = mongoose.model('FillingLogEntry', fillingLogEntrySchema);
