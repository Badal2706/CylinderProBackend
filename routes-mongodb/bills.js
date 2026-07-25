const express = require('express');
const router = express.Router();
const Bill = require('../models/Bill');
const Customer = require('../models/Customer');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// Bill numbers are globally sequential (not per-user)
async function generateBillNumber() {
  const lastBill = await Bill.findOne().sort('-createdAt');
  const nextId = lastBill ? parseInt(lastBill.bill_number.split('-')[1]) + 1 : 1;
  return `BILL-${String(nextId).padStart(4, '0')}`;
}

// Get all bills
router.get('/', async (req, res) => {
  try {
    const { date, customer_id } = req.query;

    let query = { user_id: req.user.id };

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      query.bill_date = { $gte: startDate, $lte: endDate };
    }

    if (customer_id) {
      query.customer_id = customer_id;
    }

    const bills = await Bill.find(query)
      .populate('customer_id')
      .sort('-bill_date -createdAt');

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

// Get single bill
router.get('/:id', async (req, res) => {
  try {
    const bill = await Bill.findOne({ _id: req.params.id, user_id: req.user.id })
      .populate('customer_id')
      .populate('line_items.gas_type_id')
      .populate('line_items.cylinder_size_id');

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const billData = bill.toObject();
    billData.company_name = bill.customer_id.company_name;
    billData.contact_person = bill.customer_id.contact_person;
    billData.phone_primary = bill.customer_id.phone_primary;
    billData.phone_alternate = bill.customer_id.phone_alternate;
    billData.address = bill.customer_id.address;
    billData.tin_number = bill.customer_id.tin_number;

    billData.line_items = billData.line_items.map(item => ({
      ...item,
      gas_type_name: item.gas_type_id.gas_type_name,
      size_label: item.cylinder_size_id.size_label
    }));

    billData.given_items = billData.line_items.filter(item => item.direction === 'GIVEN');
    billData.received_items = billData.line_items.filter(item => item.direction === 'RECEIVED');

    res.json(billData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new bill
router.post('/', async (req, res) => {
  try {
    const {
      customer_id,
      customer_type,
      one_time_customer,
      bill_date,
      transaction_type,
      remarks,
      given_items,
      received_items
    } = req.body;

    if (!customer_id && customer_type !== 'ONE_TIME') {
      return res.status(400).json({ error: 'Customer ID is required for regular customers' });
    }

    if (customer_type === 'ONE_TIME' && !one_time_customer) {
      return res.status(400).json({ error: 'One-time customer details are required' });
    }

    if (!given_items && !received_items) {
      return res.status(400).json({ error: 'At least one cylinder must be in the cart' });
    }

    const allItems = [...(given_items || []), ...(received_items || [])];
    for (const item of allItems) {
      if (!item.serial_numbers || item.serial_numbers.length === 0) {
        return res.status(400).json({ error: 'Serial numbers cannot be blank' });
      }
      if (item.serial_numbers.length !== item.quantity) {
        return res.status(400).json({ error: 'Number of serial numbers must match quantity' });
      }
    }

    let finalCustomerId = customer_id;

    if (customer_type === 'ONE_TIME') {
      const newCustomer = new Customer({
        customer_type: 'ONE_TIME',
        user_id: req.user.id,
        ...one_time_customer
      });
      await newCustomer.save();
      finalCustomerId = newCustomer._id;
    }

    const billNumber = await generateBillNumber();

    const total_given_qty = given_items ? given_items.reduce((sum, item) => sum + item.quantity, 0) : 0;
    const total_received_qty = received_items ? received_items.reduce((sum, item) => sum + item.quantity, 0) : 0;
    const total_bill_amount = given_items ? given_items.reduce((sum, item) => sum + item.amount, 0) : 0;

    const lineItems = [];

    if (given_items) {
      given_items.forEach(item => {
        item.serial_numbers.forEach(serialNumber => {
          lineItems.push({
            direction: 'GIVEN',
            gas_type_id: item.gas_type_id,
            cylinder_size_id: item.cylinder_size_id,
            serial_number: serialNumber,
            quantity: 1,
            rate: item.rate || 0,
            amount: item.rate || 0
          });
        });
      });
    }

    if (received_items) {
      received_items.forEach(item => {
        item.serial_numbers.forEach(serialNumber => {
          lineItems.push({
            direction: 'RECEIVED',
            gas_type_id: item.gas_type_id,
            cylinder_size_id: item.cylinder_size_id,
            serial_number: serialNumber,
            quantity: 1,
            rate: 0,
            amount: 0
          });
        });
      });
    }

    const bill = new Bill({
      user_id: req.user.id,
      bill_number: billNumber,
      customer_id: finalCustomerId,
      bill_date,
      transaction_type,
      total_given_qty,
      total_received_qty,
      total_bill_amount,
      remarks,
      line_items: lineItems
    });

    await bill.save();

    res.json({ bill_id: bill._id, bill_number: billNumber, message: 'Bill created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Today's transactions count
router.get('/stats/today', async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const count = await Bill.countDocuments({
      user_id: req.user.id,
      bill_date: { $gte: startOfDay, $lte: endOfDay }
    });

    res.json({ today_transactions: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
