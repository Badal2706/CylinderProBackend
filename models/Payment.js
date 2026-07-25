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
    enum: ['CASH', 'CHEQUE', 'ONLINE'],
    required: true
  },
  cheque_number: String,
  remarks: String
}, {
  timestamps: true
});

paymentSchema.virtual('receipt_id').get(function() {
  return this._id.toString();
});

paymentSchema.set('toJSON', { virtuals: true });
paymentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Payment', paymentSchema);
