const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

async function getCustomerLedgerData(userId) {
  const customers = await Customer.find({
    user_id: userId,
    customer_type: 'REGULAR',
    is_active: true
  }).sort('company_name');

  const ledgerData = [];

  for (const customer of customers) {
    const bills = await Bill.find({ customer_id: customer._id, user_id: userId });
    const payments = await Payment.find({ customer_id: customer._id, user_id: userId });

    let cylindersHeld = 0;
    let billAmount = 0;

    bills.forEach(bill => {
      billAmount += bill.total_bill_amount;
      bill.line_items.forEach(item => {
        if (item.direction === 'GIVEN') {
          cylindersHeld += item.quantity;
        } else if (item.direction === 'RECEIVED') {
          cylindersHeld -= item.quantity;
        }
      });
    });

    const totalPaid = payments.reduce((sum, p) => sum + p.amount_received - p.discount, 0);
    billAmount -= totalPaid;

    ledgerData.push({
      customer_id: customer._id,
      company_name: customer.company_name,
      contact_person: customer.contact_person,
      phone_primary: customer.phone_primary || '',
      tin_number: customer.tin_number || '',
      security_deposit: customer.security_deposit || 0,
      holding_limit: customer.holding_limit || 0,
      bill_amount: billAmount,
      cylinder_hold: cylindersHeld,
      status: cylindersHeld > customer.holding_limit ? 'OVER LIMIT' : ''
    });
  }

  return ledgerData;
}

// Customer Ledger Report
router.get('/ledger', async (req, res) => {
  try {
    const ledgerData = await getCustomerLedgerData(req.user.id);
    res.json(ledgerData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Over Limit Customers Report
router.get('/over-limit', async (req, res) => {
  try {
    const ledgerData = await getCustomerLedgerData(req.user.id);
    const overLimit = ledgerData.filter(c => c.status === 'OVER LIMIT');

    res.json(overLimit.map(c => ({
      customer_id: c.customer_id,
      company_name: c.company_name,
      contact_person: c.contact_person,
      phone_primary: c.phone_primary || '',
      holding_limit: c.holding_limit || 0,
      cylinders_held: c.cylinder_hold || 0
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Daily Transaction Report
router.get('/daily', async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }

    const startDate = new Date(date);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const bills = await Bill.find({
      user_id: req.user.id,
      bill_date: { $gte: startDate, $lte: endDate }
    })
    .populate('customer_id')
    .sort('-createdAt');

    const billsData = bills.map(bill => ({
      ...bill.toObject(),
      company_name: bill.customer_id.company_name,
      phone_primary: bill.customer_id.phone_primary
    }));

    res.json(billsData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cylinder Stock Summary
router.get('/cylinder-stock', async (req, res) => {
  try {
    const bills = await Bill.find({ user_id: req.user.id })
      .populate('line_items.gas_type_id')
      .populate('line_items.cylinder_size_id');

    const stockMap = {};

    bills.forEach(bill => {
      bill.line_items.forEach(item => {
        const key = `${item.gas_type_id._id}-${item.cylinder_size_id._id}`;

        if (!stockMap[key]) {
          stockMap[key] = {
            gas_type_name: item.gas_type_id.gas_type_name,
            size_label: item.cylinder_size_id.size_label,
            total_given: 0,
            total_received: 0,
            currently_out: 0
          };
        }

        if (item.direction === 'GIVEN') {
          stockMap[key].total_given += item.quantity;
          stockMap[key].currently_out += item.quantity;
        } else if (item.direction === 'RECEIVED') {
          stockMap[key].total_received += item.quantity;
          stockMap[key].currently_out -= item.quantity;
        }
      });
    });

    const stockData = Object.values(stockMap).sort((a, b) => {
      if (a.gas_type_name !== b.gas_type_name) {
        return a.gas_type_name.localeCompare(b.gas_type_name);
      }
      return a.size_label.localeCompare(b.size_label);
    });

    res.json(stockData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Outstanding Dues Report
router.get('/outstanding', async (req, res) => {
  try {
    const uid = req.user.id;
    const customers = await Customer.find({ user_id: uid }).sort('company_name');
    const outstandingData = [];

    for (const customer of customers) {
      const bills = await Bill.find({ customer_id: customer._id, user_id: uid });
      const payments = await Payment.find({ customer_id: customer._id, user_id: uid });

      const totalBilled = bills.reduce((sum, bill) => sum + bill.total_bill_amount, 0);
      const totalPaid = payments.reduce((sum, p) => sum + p.amount_received - p.discount, 0);
      const outstanding = totalBilled - totalPaid;

      if (outstanding > 0) {
        outstandingData.push({
          customer_id: customer._id,
          company_name: customer.company_name,
          contact_person: customer.contact_person || '',
          phone_primary: customer.phone_primary || '',
          customer_type: customer.customer_type,
          total_billed: totalBilled,
          total_paid: totalPaid,
          outstanding_amount: outstanding
        });
      }
    }

    outstandingData.sort((a, b) => b.outstanding_amount - a.outstanding_amount);

    res.json(outstandingData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Deposit Summary Report
router.get('/deposits', async (req, res) => {
  try {
    const customers = await Customer.find({
      user_id: req.user.id,
      customer_type: 'REGULAR',
      security_deposit: { $gt: 0 }
    }).sort('company_name');

    const depositsData = customers.map(c => ({
      customer_id: c._id,
      company_name: c.company_name,
      contact_person: c.contact_person || '',
      phone_primary: c.phone_primary || '',
      security_deposit: c.security_deposit || 0
    }));

    res.json(depositsData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Customer Statement
router.get('/customer-statement/:id', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const customerId = req.params.id;
    const uid = req.user.id;

    let billQuery = { customer_id: customerId, user_id: uid };
    let paymentQuery = { customer_id: customerId, user_id: uid };

    if (start_date && end_date) {
      const startDate = new Date(start_date);
      const endDate = new Date(end_date);
      endDate.setHours(23, 59, 59, 999);

      billQuery.bill_date = { $gte: startDate, $lte: endDate };
      paymentQuery.date = { $gte: startDate, $lte: endDate };
    }

    const bills = await Bill.find(billQuery);
    const payments = await Payment.find(paymentQuery);

    const statement = [];

    bills.forEach(bill => {
      statement.push({
        date: bill.bill_date,
        bill_number: bill.bill_number,
        transaction_type: bill.transaction_type,
        type: 'BILL',
        debit: bill.total_bill_amount,
        credit: 0,
        remarks: bill.remarks
      });
    });

    payments.forEach(payment => {
      statement.push({
        date: payment.date,
        receipt_number: payment.receipt_number,
        payment_mode: payment.payment_mode,
        type: 'PAYMENT',
        debit: 0,
        credit: payment.amount_received - payment.discount,
        remarks: payment.remarks
      });
    });

    statement.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(statement);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
