const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  customer_type: {
    type: String,
    enum: ['REGULAR', 'ONE_TIME'],
    default: 'REGULAR'
  },
  company_name: {
    type: String,
    required: true
  },
  contact_person: String,
  phone_primary: {
    type: String,
    required: true
  },
  phone_alternate: String,
  address: String,
  tin_number: String,
  security_deposit: {
    type: Number,
    default: 0
  },
  holding_limit: {
    type: Number,
    default: 0
  },
  is_active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt
});

// Virtual for customer_id (for compatibility with existing frontend)
customerSchema.virtual('customer_id').get(function() {
  return this._id.toString();
});

// Ensure virtuals are included in JSON
customerSchema.set('toJSON', { virtuals: true });
customerSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Customer', customerSchema);
