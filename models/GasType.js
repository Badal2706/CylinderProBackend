const mongoose = require('mongoose');

const gasTypeSchema = new mongoose.Schema({
  gas_type_name: {
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

gasTypeSchema.virtual('gas_type_id').get(function() {
  return this._id.toString();
});

gasTypeSchema.set('toJSON', { virtuals: true });
gasTypeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('GasType', gasTypeSchema);
