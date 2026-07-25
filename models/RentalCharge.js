const mongoose = require('mongoose');

// A generated rental-summary charge for one customer (Phase 4).
// Purely a standalone record: it does NOT touch Bill, Payment, or Outstanding Receivables.
// Per included cylinder, Cylinder.rental_charged_through is advanced so the next
// calculation never re-bills already-charged days.
const rentalChargeLineSchema = new mongoose.Schema({
  serial_number: { type: String, required: true }, // cylinder rotational number
  gas_type: { type: String, default: '' },
  capacity: { type: String, default: '' },
  date_given: { type: Date, default: null },       // start of the current holding
  charged_from: { type: Date, default: null },     // max(date_given, previous rental_charged_through)
  charged_through: { type: Date, default: null },  // = generated_date
  days_held: { type: Number, default: 0 },         // uncharged days held at generation time
  days_charged: { type: Number, default: 0 },      // max(0, days_held - free_days)
  amount: { type: Number, default: 0 }             // days_charged × rate_per_day
}, { _id: false });

const rentalChargeSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  customer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
  generated_date: { type: Date, default: Date.now },
  free_days: { type: Number, default: 10 },
  rate_per_day: { type: Number, default: 0 },
  line_items: [rentalChargeLineSchema],
  total_amount: { type: Number, default: 0 }
}, { timestamps: true });

rentalChargeSchema.index({ user_id: 1, customer_id: 1, generated_date: -1 });

rentalChargeSchema.virtual('rental_charge_id').get(function () {
  return this._id.toString();
});
rentalChargeSchema.set('toJSON', { virtuals: true });
rentalChargeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('RentalCharge', rentalChargeSchema);
