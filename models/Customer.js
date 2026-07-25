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
  phone_alternate: String, // displayed as "Telephone Number"
  address: String,
  gst_number: String,
  // Up to 4 additional contacts (5 total including the primary contact person above).
  additional_contacts: {
    type: [{
      name:   { type: String, default: '' },   // optional — user may only know the number
      number: { type: String, required: true }
    }],
    default: [],
    validate: {
      validator: (arr) => !arr || arr.length <= 4,
      message: 'A customer can have at most 4 additional contacts'
    }
  },
  // Quantity-only running count of THIS customer's own (personal) cylinders we currently hold.
  // Updated from bill line items' personalCylindersIn/Out. Never goes below 0.
  personalCylindersAtPlant: {
    type: Number,
    default: 0
  },
  security_deposit: {
    type: Number,
    default: 0
  },
  holding_limit: {
    type: Number,
    default: 0
  },
  // Filling vendor (Phase 11): third-party filling station / business partner. GIVEN reads
  // as "sent for filling", RECEIVED as "received back filled". Exempt from the holding-limit
  // block and from the PC non-negative guard (their PC balance may go negative = that many
  // personal cylinders are currently with the vendor). Everything else (location checks,
  // stock-state checks, history, aging) behaves exactly like a normal customer.
  is_filling_vendor: {
    type: Boolean,
    default: false
  },
  is_active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt
});

// Indexes for common queries (per-tenant name search & active-status filtering).
customerSchema.index({ user_id: 1, company_name: 1 });
customerSchema.index({ user_id: 1, is_active: 1 });

// Virtual for customer_id (for compatibility with existing frontend)
customerSchema.virtual('customer_id').get(function() {
  return this._id.toString();
});

// Ensure virtuals are included in JSON
customerSchema.set('toJSON', { virtuals: true });
customerSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Customer', customerSchema);
