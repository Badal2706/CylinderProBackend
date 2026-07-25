const express = require('express');
const router = express.Router();
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

async function getCustomerStats(customerId) {
  const bills = await Bill.find({ customer_id: customerId });

  let totalGiven = 0;
  let totalReceived = 0;
  let totalBillAmount = 0;

  bills.forEach(bill => {
    bill.line_items.forEach(item => {
      if (item.direction === 'GIVEN') {
        totalGiven += item.quantity;
        totalBillAmount += item.amount;
      } else if (item.direction === 'RECEIVED') {
        totalReceived += item.quantity;
      }
    });
  });

  const payments = await Payment.find({ customer_id: customerId });
  const totalPaid = payments.reduce((sum, p) => sum + p.amount_received - p.discount, 0);

  return {
    total_given: totalGiven,
    total_received_qty: totalReceived,
    cylinders_held: totalGiven - totalReceived,
    total_billed: totalBillAmount,
    total_received: totalPaid,
    total_discount: payments.reduce((sum, p) => sum + p.discount, 0),
    current_bill_amount: totalBillAmount - totalPaid
  };
}

// Get all customers
router.get('/', async (req, res) => {
  try {
    const { search, status } = req.query;

    let query = { customer_type: 'REGULAR', user_id: req.user.id };

    if (search) {
      query.$or = [
        { company_name: { $regex: search, $options: 'i' } },
        { phone_primary: { $regex: search, $options: 'i' } },
        { tin_number: { $regex: search, $options: 'i' } }
      ];
    }

    const customers = await Customer.find(query).sort('company_name');

    const customersWithStats = await Promise.all(
      customers.map(async (customer) => {
        const stats = await getCustomerStats(customer._id);
        const customerObj = customer.toObject();
        return {
          ...customerObj,
          ...stats,
          status: stats.cylinders_held > customer.holding_limit ? 'OVER LIMIT' :
                  customer.is_active ? 'ACTIVE' : 'INACTIVE'
        };
      })
    );

    let filtered = customersWithStats;
    if (status === 'OVER_LIMIT') {
      filtered = customersWithStats.filter(c => c.status === 'OVER LIMIT');
    } else if (status === 'ZERO_BALANCE') {
      filtered = customersWithStats.filter(c => c.current_bill_amount === 0);
    } else if (status === 'ACTIVE') {
      filtered = customersWithStats.filter(c => c.is_active);
    }

    res.json(filtered);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single customer with details
router.get('/:id', async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, user_id: req.user.id });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const stats = await getCustomerStats(customer._id);

    const bills = await Bill.find({ customer_id: customer._id, user_id: req.user.id })
      .populate('line_items.gas_type_id')
      .populate('line_items.cylinder_size_id');

    const breakdown = {};
    bills.forEach(bill => {
      bill.line_items.forEach(item => {
        const key = `${item.gas_type_id.gas_type_name}-${item.cylinder_size_id.size_label}`;
        if (!breakdown[key]) {
          breakdown[key] = {
            gas_type_name: item.gas_type_id.gas_type_name,
            size_label: item.cylinder_size_id.size_label,
            total_given: 0,
            total_received: 0,
            currently_held: 0
          };
        }
        if (item.direction === 'GIVEN') {
          breakdown[key].total_given += item.quantity;
        } else {
          breakdown[key].total_received += item.quantity;
        }
        breakdown[key].currently_held = breakdown[key].total_given - breakdown[key].total_received;
      });
    });

    const customerObj = customer.toObject();
    res.json({
      ...customerObj,
      ...stats,
      cylinder_breakdown: Object.values(breakdown).filter(b => b.currently_held !== 0 || b.total_given > 0),
      status: stats.cylinders_held > customer.holding_limit ? 'OVER LIMIT' : 'ACTIVE'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new customer
router.post('/', async (req, res) => {
  try {
    const customer = new Customer({ ...req.body, user_id: req.user.id });
    await customer.save();
    res.json({ customer_id: customer._id, message: 'Customer created successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update customer
router.put('/:id', async (req, res) => {
  try {
    const customer = await Customer.findOneAndUpdate(
      { _id: req.params.id, user_id: req.user.id },
      req.body,
      { new: true, runValidators: true }
    );

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ message: 'Customer updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get customer transactions (given)
router.get('/:id/transactions/given', async (req, res) => {
  try {
    const bills = await Bill.find({ customer_id: req.params.id, user_id: req.user.id })
      .populate('line_items.gas_type_id')
      .populate('line_items.cylinder_size_id')
      .sort('-bill_date');

    const transactions = [];
    bills.forEach(bill => {
      bill.line_items.forEach(item => {
        if (item.direction === 'GIVEN') {
          transactions.push({
            line_item_id: item._id,
            date: bill.bill_date,
            bill_number: bill.bill_number,
            gas_type_name: item.gas_type_id.gas_type_name,
            size_label: item.cylinder_size_id.size_label,
            serial_number: item.serial_number,
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount
          });
        }
      });
    });

    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get customer transactions (received)
router.get('/:id/transactions/received', async (req, res) => {
  try {
    const bills = await Bill.find({ customer_id: req.params.id, user_id: req.user.id })
      .populate('line_items.gas_type_id')
      .populate('line_items.cylinder_size_id')
      .sort('-bill_date');

    const transactions = [];
    bills.forEach(bill => {
      bill.line_items.forEach(item => {
        if (item.direction === 'RECEIVED') {
          transactions.push({
            line_item_id: item._id,
            date: bill.bill_date,
            bill_number: bill.bill_number,
            gas_type_name: item.gas_type_id.gas_type_name,
            size_label: item.cylinder_size_id.size_label,
            serial_number: item.serial_number,
            quantity: item.quantity
          });
        }
      });
    });

    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get customer payments
router.get('/:id/payments', async (req, res) => {
  try {
    const payments = await Payment.find({ customer_id: req.params.id, user_id: req.user.id })
      .populate('bill_id')
      .sort('-date');

    const paymentsData = payments.map(p => ({
      ...p.toObject(),
      bill_number: p.bill_id ? p.bill_id.bill_number : null
    }));

    res.json(paymentsData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
