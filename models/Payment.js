const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // GEN-C: uniqueness is scoped to (account_code, financial_year), not global — the receipt
  // series restarts each 1 April when the account has opted into that.
  receipt_number: {
    type: String,
    required: true
  },
  // ─── Phase GEN-C: numbering identity (mirrors Bill) ───
  account_code: { type: String, default: '', index: true },
  financial_year: { type: String, default: '', index: true },
  receipt_uid: { type: String, default: '', index: true },
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

// GEN-C: keep the derived numbering fields in step with date and receipt_number.
paymentSchema.pre('validate', async function () {
  const { financialYear, buildUid } = require('../services/numbering.service');
  // Filled here rather than at each creation site, so a new one cannot forget it. Immutable
  // once set, and the lookup behind this is cached for the life of the process.
  if (!this.account_code && this.user_id) {
    try {
      this.account_code = await require('../services/accountNumbering.service').accountCodeFor(this.user_id);
    } catch { /* leave blank — the migration backfills, and buildUid returns '' meanwhile */ }
  }
  if (this.date) {
    try { this.financial_year = financialYear(this.date); } catch { /* leave as-is */ }
  }
  this.receipt_uid = buildUid(this.account_code, this.financial_year, this.receipt_number);
});


// GEN-C: findOneAndUpdate / updateOne / updateMany bypass DOCUMENT middleware entirely, so a
// direct write touching date or receipt_number would leave financial_year and the uid
// STALE — silently scoping the uniqueness check to the wrong year and making the record
// unfindable by its identity. payment.service.updatePayment does exactly this kind of write.
// Recompute here so there is one rule regardless of how the write arrives.
// NOTE: async hooks must NOT declare a `next` parameter — Mongoose awaits the returned promise
// and passes no callback, so calling next() throws "next is not a function". Errors propagate by
// being thrown.
async function syncNumberingOnQuery() {
  const update = this.getUpdate() || {};
  const $set = update.$set || {};

  // A field can arrive EITHER at the top level ({ date: x }) or inside $set. Both forms
  // reach this hook, and `timestamps: true` guarantees $set already exists (Mongoose puts
  // updatedAt there before middleware runs) — so `update.$set || update` would silently read the
  // timestamp object, find no date, and skip the sync entirely.
  const read = (f) => ($set[f] !== undefined ? $set[f] : update[f]);

  const nextDate = read('date');
  const nextNumber = read('receipt_number');
  if (nextDate === undefined && nextNumber === undefined) return;

  // Whatever is NOT being written still has to come from the stored document.
  const current = await this.model
    .findOne(this.getQuery())
    .select('account_code date receipt_number')
    .lean();
  if (!current) return;

  const { financialYear, buildUid } = require('../services/numbering.service');
  const date = nextDate !== undefined ? nextDate : current.date;
  const number = nextNumber !== undefined ? nextNumber : current.receipt_number;
  const fy = financialYear(date);

  // Written into $set specifically: a plain top-level assignment would be dropped if the caller
  // used operator form.
  update.$set = Object.assign({}, $set, {
    financial_year: fy,
    receipt_uid: buildUid(current.account_code, fy, number)
  });
  this.setUpdate(update);
}
paymentSchema.pre('findOneAndUpdate', syncNumberingOnQuery);
paymentSchema.pre('updateOne', syncNumberingOnQuery);
paymentSchema.pre('updateMany', syncNumberingOnQuery);
// Indexes for common queries.
// GEN-C: receipt numbers are unique per (account, financial year) — see Bill.js.
paymentSchema.index({ account_code: 1, financial_year: 1, receipt_number: 1 }, { unique: true });
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
