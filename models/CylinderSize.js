const mongoose = require('mongoose');

const cylinderSizeSchema = new mongoose.Schema({
  // The account this catalog entry belongs to (24 Sep 2026). Catalogs used to be one global set
  // shared by every account in the database — one tenant adding "Helium" added it to everyone's
  // dropdowns, and deleting a size removed it for everyone. Each account now owns its own copy,
  // seeded from config/gasCapacities.js at signup (masters.service.seedDefaultCatalog).
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  size_label: {
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

// Unique WITHIN an account; user_id leads so it also serves every per-account query.
cylinderSizeSchema.index({ user_id: 1, size_label: 1 }, { unique: true });

cylinderSizeSchema.virtual('size_id').get(function() {
  return this._id.toString();
});

cylinderSizeSchema.set('toJSON', { virtuals: true });
cylinderSizeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('CylinderSize', cylinderSizeSchema);
