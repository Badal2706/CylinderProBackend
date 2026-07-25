const mongoose = require('mongoose');

const cylinderSizeSchema = new mongoose.Schema({
  size_label: {
    type: String,
    required: true,
    unique: true
  },
  is_active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

cylinderSizeSchema.virtual('size_id').get(function() {
  return this._id.toString();
});

cylinderSizeSchema.set('toJSON', { virtuals: true });
cylinderSizeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('CylinderSize', cylinderSizeSchema);
