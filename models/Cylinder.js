const mongoose = require('mongoose');
const { LOCATIONS } = require('../config/locations');

const cylinderSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  rotational_number: {
    type: String,
    required: true,
    trim: true
  },
  // Optional — rotational_number is the primary identifier. May be added later.
  physical_number: {
    type: String,
    trim: true
  },
  gas_type: {
    type: String,
    required: true,
    trim: true
  },
  capacity: {
    type: String,
    required: true,
    trim: true
  },
  // Physical site the cylinder is at (or was last dispatched from, when AT_CUSTOMER).
  // Changed ONLY by the Bill post-save hook (CUSTOMER bills set it to the bill's site;
  // INTERNAL_TRANSFER bills move it from_location -> to_location).
  location: {
    type: String,
    enum: LOCATIONS,
    default: 'AT_PLANT_CHANDISAR'
  },
  // Whether the cylinder is in our stock or out with a customer. Derived from Bill saves.
  stock_state: {
    type: String,
    enum: ['IN_STOCK', 'AT_CUSTOMER'],
    default: 'IN_STOCK'
  },
  // Maintenance is an independent flag, NOT a stock_state value — it never goes through Bill.
  // Only settable while the cylinder is IN_STOCK at AT_PLANT_CHANDISAR (service-enforced).
  under_maintenance: {
    type: Boolean,
    default: false
  },
  maintenance_since: {
    type: Date,
    default: null
  },
  // Rental billing (Phase 4): the date this cylinder's CURRENT holding has been charged
  // through. Days-since-last-charge start at max(date_given, rental_charged_through), so a
  // stale value from a previous holding is harmless — no reset needed on return.
  rental_charged_through: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Rotational number is unique per user (multi-tenant scoping).
cylinderSchema.index({ user_id: 1, rotational_number: 1 }, { unique: true });
// Physical number is optional: unique per user only when a non-empty value is set
// (partial index ignores cylinders with no physical number).
cylinderSchema.index(
  { user_id: 1, physical_number: 1 },
  { unique: true, partialFilterExpression: { physical_number: { $type: 'string', $gt: '' } } }
);
// Stock/location filtering per tenant.
cylinderSchema.index({ user_id: 1, stock_state: 1 });
cylinderSchema.index({ user_id: 1, location: 1 });
cylinderSchema.index({ user_id: 1, stock_state: 1, location: 1 }); // compound for aging/in-rotation queries

cylinderSchema.virtual('cylinder_id').get(function() {
  return this._id.toString();
});

cylinderSchema.set('toJSON', { virtuals: true });
cylinderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Cylinder', cylinderSchema);
