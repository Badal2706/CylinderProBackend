const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  receipt_number: {
    type: String,
    required: true,
    unique: true
  },
  customer_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  bill_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bill'
  },
  challan_no: {
    type: String,
    default: ''
  },
  date: {
    type: Date,
    required: true
  },
  amount_received: {
    type: Number,
    required: true
  },
  discount: {
    type: Number,
    default: 0
  },
  payment_mode: {
    type: String,
    // 'ONLINE' kept for backward-compat with old records; new payments use 'UPI'.
    enum: ['CASH', 'CHEQUE', 'ONLINE', 'UPI'],
    required: true
  },
  cheque_number: String,
  upi_transaction_id: String,
  remarks: String
}, {
  timestamps: true
});

// Indexes for common queries (receipt_number is already unique-indexed above).
paymentSchema.index({ user_id: 1, customer_id: 1 });  // per-customer payment history
paymentSchema.index({ user_id: 1, date: -1 });         // date-sorted listings
paymentSchema.index({ user_id: 1, createdAt: -1 });    // recent-first listings
paymentSchema.index({ receipt_number: 1 });             // receipt number sequence lookup

paymentSchema.virtual('receipt_id').get(function() {
  return this._id.toString();
});

paymentSchema.set('toJSON', { virtuals: true });
paymentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Payment', paymentSchema);
