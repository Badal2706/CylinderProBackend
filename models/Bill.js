const mongoose = require('mongoose');

const billLineItemSchema = new mongoose.Schema({
  direction: {
    type: String,
    enum: ['GIVEN', 'RECEIVED'],
    required: true
  },
  gas_type_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GasType',
    required: true
  },
  cylinder_size_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CylinderSize',
    required: true
  },
  serial_number: {
    type: String,
    required: true
  },
  quantity: {
    type: Number,
    default: 1
  },
  rate: {
    type: Number,
    default: 0
  },
  amount: {
    type: Number,
    default: 0
  }
});

const billSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  bill_number: {
    type: String,
    required: true,
    unique: true
  },
  customer_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  bill_date: {
    type: Date,
    required: true
  },
  transaction_type: {
    type: String,
    enum: ['GIVEN', 'RECEIVED', 'SWAP'],
    required: true
  },
  total_given_qty: {
    type: Number,
    default: 0
  },
  total_received_qty: {
    type: Number,
    default: 0
  },
  total_bill_amount: {
    type: Number,
    default: 0
  },
  remarks: String,
  line_items: [billLineItemSchema]
}, {
  timestamps: true
});

billSchema.virtual('bill_id').get(function() {
  return this._id.toString();
});

billSchema.set('toJSON', { virtuals: true });
billSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Bill', billSchema);
