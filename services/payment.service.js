const Payment = require('../models/Payment');
const Bill = require('../models/Bill');
const HttpError = require('../utils/HttpError');

// receipt_number is globally unique, so the next number must come from the numeric max —
// not the newest-by-createdAt document, whose number can lag behind (e.g. backdated entries).
async function generateReceiptNumber() {
  const result = await Payment.aggregate([
    { $match: { receipt_number: /^RCP-\d+$/ } },
    { $project: { num: { $toInt: { $arrayElemAt: [{ $split: ['$receipt_number', '-'] }, 1] } } } },
    { $group: { _id: null, max: { $max: '$num' } } }
  ]);
  const max = (result.length && result[0].max) || 0;
  return `RCP-${String(max + 1).padStart(4, '0')}`;
}

async function createPayment(userId, body) {
  const {
    customer_id,
    bill_id,
    date,
    amount_received,
    discount,
    payment_mode,
    cheque_number,
    upi_transaction_id,
    remarks
  } = body;

  if (!customer_id || !amount_received || !payment_mode) {
    throw new HttpError(400, 'Customer ID, amount, and payment mode are required');
  }

  if (payment_mode === 'CHEQUE' && !cheque_number) {
    throw new HttpError(400, 'Cheque number is required for cheque payments');
  }

  const receiptNumber = await generateReceiptNumber();

  // Challan is never entered manually on payments (Phase 5) — it is derived from the linked
  // bill when there is one, purely for receipt display.
  let finalChallanNo = '';
  if (bill_id) {
    const linkedBill = await Bill.findOne({ _id: bill_id, user_id: userId });
    if (linkedBill) finalChallanNo = linkedBill.challan_no || '';
  }

  const payment = new Payment({
    user_id: userId,
    receipt_number: receiptNumber,
    customer_id,
    bill_id: bill_id || undefined,
    date,
    amount_received,
    discount: discount || 0,
    payment_mode,
    cheque_number,
    upi_transaction_id,
    challan_no: finalChallanNo,
    remarks
  });

  await payment.save();

  return {
    receipt_id: payment._id,
    receipt_number: receiptNumber,
    message: 'Payment recorded successfully'
  };
}

async function listPayments(userId, customerId, { page, limit } = {}) {
  const query = { user_id: userId };
  if (customerId) {
    query.customer_id = customerId;
  }

  const { parsePagination, paginatedResponse } = require('../utils/paginate');
  const pg = parsePagination({ page, limit });

  const [payments, total] = await Promise.all([
    Payment.find(query)
      .populate('customer_id', 'company_name')
      .populate('bill_id', 'bill_number')
      .sort('-date')
      .skip(pg.skip)
      .limit(pg.limit)
      .lean(),
    Payment.countDocuments(query)
  ]);

  const data = payments.map(payment => ({
    ...payment,
    company_name: payment.customer_id ? payment.customer_id.company_name : '',
    bill_number: payment.bill_id ? payment.bill_id.bill_number : null
  }));

  return paginatedResponse(data, total, pg);
}

async function updatePayment(userId, paymentId, body) {
  const allowed = ['cheque_number', 'upi_transaction_id', 'remarks', 'payment_mode', 'amount_received', 'discount', 'date'];
  const updates = {};
  allowed.forEach(field => {
    if (body[field] !== undefined) updates[field] = body[field];
  });

  const payment = await Payment.findOneAndUpdate(
    { _id: paymentId, user_id: userId },
    updates,
    { new: true }
  );

  if (!payment) {
    throw new HttpError(404, 'Payment not found');
  }

  return { receipt_id: payment._id, message: 'Payment updated successfully' };
}

module.exports = { generateReceiptNumber, createPayment, listPayments, updatePayment };
