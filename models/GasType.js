const mongoose = require('mongoose');

const gasTypeSchema = new mongoose.Schema({
  // The account this catalog entry belongs to (24 Sep 2026). Catalogs used to be one global set
  // shared by every account in the database — one tenant adding "Helium" added it to everyone's
  // dropdowns, and deleting a size removed it for everyone. Each account now owns its own copy,
  // seeded from config/gasCapacities.js at signup (masters.service.seedDefaultCatalog).
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  gas_type_name: {
    type: String,
    required: true
  },
  is_active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// A name is unique WITHIN an account, not across the database: two clients may both sell "Oxygen".
// user_id leads, so this also serves every "this account's gas types" query.
gasTypeSchema.index({ user_id: 1, gas_type_name: 1 }, { unique: true });

gasTypeSchema.virtual('gas_type_id').get(function() {
  return this._id.toString();
});

gasTypeSchema.set('toJSON', { virtuals: true });
gasTypeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('GasType', gasTypeSchema);
