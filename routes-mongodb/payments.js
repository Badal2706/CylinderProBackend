const express = require('express');
const router = express.Router();
const Payment = require('../models/Payment');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

async function generateReceiptNumber() {
  const lastReceipt = await Payment.findOne().sort('-createdAt');
  const nextId = lastReceipt ? parseInt(lastReceipt.receipt_number.split('-')[1]) + 1 : 1;
  return `RCP-${String(nextId).padStart(4, '0')}`;
}

// Record new payment
router.post('/', async (req, res) => {
  try {
    const {
      customer_id,
      bill_id,
      date,
      amount_received,
      discount,
      payment_mode,
      cheque_number,
      remarks
    } = req.body;

    if (!customer_id || !amount_received || !payment_mode) {
      return res.status(400).json({ error: 'Customer ID, amount, and payment mode are required' });
    }

    if (payment_mode === 'CHEQUE' && !cheque_number) {
      return res.status(400).json({ error: 'Cheque number is required for cheque payments' });
    }

    const receiptNumber = await generateReceiptNumber();

    const payment = new Payment({
      user_id: req.user.id,
      receipt_number: receiptNumber,
      customer_id,
      bill_id: bill_id || undefined,
      date,
      amount_received,
      discount: discount || 0,
      payment_mode,
      cheque_number,
      remarks
    });

    await payment.save();

    res.json({
      receipt_id: payment._id,
      receipt_number: receiptNumber,
      message: 'Payment recorded successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all payments
router.get('/', async (req, res) => {
  try {
    const { customer_id } = req.query;

    let query = { user_id: req.user.id };
    if (customer_id) {
      query.customer_id = customer_id;
    }

    const payments = await Payment.find(query)
      .populate('customer_id')
      .populate('bill_id')
      .sort('-date');

    const paymentsData = payments.map(payment => ({
      ...payment.toObject(),
      company_name: payment.customer_id.company_name,
      bill_number: payment.bill_id ? payment.bill_id.bill_number : null
    }));

    res.json(paymentsData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
