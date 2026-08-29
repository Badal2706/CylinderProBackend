const Payment = require('../models/Payment');
const Bill = require('../models/Bill');
const Customer = require('../models/Customer');
const HttpError = require('../utils/HttpError');
const accountNumbering = require('./accountNumbering.service');

// The next number comes from the numeric MAX, not the newest-by-createdAt document — a backdated
// entry can carry a number lower than the latest one created.
//
// GEN-C: scoped to one account, and to one financial year when that account has opted into
// restarting its series each 1 April. It used to aggregate across EVERY payment in the database
// with no account filter at all, which would have handed a second CylinderPro client a receipt
// series continuing from the first client's.
async function generateReceiptNumber(userId, date = new Date()) {
  const { accountCode, financialYear, resets } = await accountNumbering.getContext(userId, date);

  const match = { user_id: userId, receipt_number: /^RCP-\d+$/ };
  // With reset OFF the series is continuous for the life of the account, so the max is taken
  // across every year. With it ON, only this financial year's receipts count.
  if (resets) match.financial_year = financialYear;

  const result = await Payment.aggregate([
    { $match: match },
    { $project: { num: { $toInt: { $arrayElemAt: [{ $split: ['$receipt_number', '-'] }, 1] } } } },
    { $group: { _id: null, max: { $max: '$num' } } }
  ]);
  let n = ((result.length && result[0].max) || 0) + 1;

  // The max may sit below a gap that a backdated receipt already occupies in THIS year, so step
  // past anything taken rather than trusting the max alone.
  for (let guard = 0; guard < 100000; guard++) {
    const candidate = `RCP-${String(n).padStart(4, '0')}`;
    const taken = await Payment.exists({
      account_code: accountCode, financial_year: financialYear, receipt_number: candidate
    });
    if (!taken) return candidate;
    n++;
  }
  return `RCP-${String(n).padStart(4, '0')}`;
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

  const receiptNumber = await generateReceiptNumber(userId, date);

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

async function listPayments(userId, customerId, { page, limit, search } = {}) {
  const query = { user_id: userId };
  if (customerId) {
    query.customer_id = customerId;
  }

  // Search runs on the SERVER so it spans every payment, not just the batch the client happens
  // to have loaded. The customer's name lives on the Customer document, so matching it means
  // resolving ids first -- receipt/challan numbers match directly on the payment.
  const term = (search || '').trim();
  if (term) {
    // Escape every non-alphanumeric character so a customer name containing '.' or '('
    // is matched literally rather than as a regex.
    const rx = new RegExp(term.replace(/[^A-Za-z0-9\s]/g, (c) => '\\' + c), 'i');
    const custIds = await Customer.find({ user_id: userId, company_name: rx })
      .select('_id').limit(500).lean();
    query.$or = [
      { receipt_number: rx },
      { challan_no: rx },
      ...(custIds.length ? [{ customer_id: { $in: custIds.map(c => c._id) } }] : [])
    ];
  }

  const { parsePagination, paginatedResponse } = require('../utils/paginate');
  const pg = parsePagination({ page, limit });

  const [payments, total] = await Promise.all([
    Payment.find(query)
      .populate('customer_id', 'company_name')
      .populate('bill_id', 'bill_number')
      // Newest first by entry order, not by the user-entered date: several payments recorded on
      // the same date must still show most-recent-first, which '-date' alone cannot do.
      .sort('-createdAt')
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
