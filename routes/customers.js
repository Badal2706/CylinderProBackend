const express = require('express');
const router = express.Router();
const db = require('../database');

// Get all customers
router.get('/', (req, res) => {
  const { search, status } = req.query;
  
  let query = `
    SELECT 
      c.*,
      COALESCE(SUM(CASE WHEN b.transaction_type IN ('GIVEN', 'SWAP') THEN b.total_bill_amount ELSE 0 END), 0) -
      COALESCE(SUM(pr.amount_received - pr.discount), 0) as current_bill_amount,
      COALESCE(SUM(CASE WHEN bli.direction = 'GIVEN' THEN bli.quantity ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN bli.direction = 'RECEIVED' THEN bli.quantity ELSE 0 END), 0) as cylinders_held
    FROM customers c
    LEFT JOIN bills b ON c.customer_id = b.customer_id
    LEFT JOIN bill_line_items bli ON b.bill_id = bli.bill_id
    LEFT JOIN payment_receipts pr ON c.customer_id = pr.customer_id
    WHERE c.customer_type = 'REGULAR'
  `;

  if (search) {
    query += ` AND (c.company_name LIKE '%${search}%' OR c.phone_primary LIKE '%${search}%' OR c.tin_number LIKE '%${search}%')`;
  }

  query += ` GROUP BY c.customer_id ORDER BY c.company_name`;

  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // Add status field based on cylinder hold vs limit
    const customers = rows.map(customer => ({
      ...customer,
      status: customer.cylinders_held > customer.holding_limit ? 'OVER LIMIT' : 
              customer.is_active ? 'ACTIVE' : 'INACTIVE'
    }));

    // Filter by status if provided
    let filteredCustomers = customers;
    if (status) {
      if (status === 'OVER_LIMIT') {
        filteredCustomers = customers.filter(c => c.status === 'OVER LIMIT');
      } else if (status === 'ZERO_BALANCE') {
        filteredCustomers = customers.filter(c => c.current_bill_amount === 0);
      } else if (status === 'ACTIVE') {
        filteredCustomers = customers.filter(c => c.is_active === 1);
      }
    }

    res.json(filteredCustomers);
  });
});

// Get single customer with full details
router.get('/:id', (req, res) => {
  const customerId = req.params.id;

  const customerQuery = `
    SELECT 
      c.*,
      COALESCE(SUM(CASE WHEN b.transaction_type IN ('GIVEN', 'SWAP') THEN b.total_bill_amount ELSE 0 END), 0) as total_billed,
      COALESCE(SUM(pr.amount_received), 0) as total_received,
      COALESCE(SUM(pr.discount), 0) as total_discount,
      COALESCE(SUM(CASE WHEN b.transaction_type IN ('GIVEN', 'SWAP') THEN b.total_bill_amount ELSE 0 END), 0) -
      COALESCE(SUM(pr.amount_received - pr.discount), 0) as current_bill_amount,
      COALESCE(SUM(CASE WHEN bli.direction = 'GIVEN' THEN bli.quantity ELSE 0 END), 0) as total_given,
      COALESCE(SUM(CASE WHEN bli.direction = 'RECEIVED' THEN bli.quantity ELSE 0 END), 0) as total_received_qty,
      COALESCE(SUM(CASE WHEN bli.direction = 'GIVEN' THEN bli.quantity ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN bli.direction = 'RECEIVED' THEN bli.quantity ELSE 0 END), 0) as cylinders_held
    FROM customers c
    LEFT JOIN bills b ON c.customer_id = b.customer_id
    LEFT JOIN bill_line_items bli ON b.bill_id = bli.bill_id
    LEFT JOIN payment_receipts pr ON c.customer_id = pr.customer_id
    WHERE c.customer_id = ?
    GROUP BY c.customer_id
  `;

  db.get(customerQuery, [customerId], (err, customer) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get cylinder breakdown by type and size
    const breakdownQuery = `
      SELECT 
        gt.gas_type_name,
        cs.size_label,
        COALESCE(SUM(CASE WHEN bli.direction = 'GIVEN' THEN bli.quantity ELSE 0 END), 0) as total_given,
        COALESCE(SUM(CASE WHEN bli.direction = 'RECEIVED' THEN bli.quantity ELSE 0 END), 0) as total_received,
        COALESCE(SUM(CASE WHEN bli.direction = 'GIVEN' THEN bli.quantity ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN bli.direction = 'RECEIVED' THEN bli.quantity ELSE 0 END), 0) as currently_held
      FROM bill_line_items bli
      JOIN bills b ON bli.bill_id = b.bill_id
      JOIN gas_types gt ON bli.gas_type_id = gt.gas_type_id
      JOIN cylinder_sizes cs ON bli.cylinder_size_id = cs.size_id
      WHERE b.customer_id = ?
      GROUP BY gt.gas_type_name, cs.size_label
      HAVING currently_held != 0 OR total_given > 0
    `;

    db.all(breakdownQuery, [customerId], (err, breakdown) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      customer.cylinder_breakdown = breakdown;
      customer.status = customer.cylinders_held > customer.holding_limit ? 'OVER LIMIT' : 'ACTIVE';
      
      res.json(customer);
    });
  });
});

// Create new customer
router.post('/', (req, res) => {
  const {
    company_name,
    contact_person,
    phone_primary,
    phone_alternate,
    address,
    tin_number,
    security_deposit,
    holding_limit,
    notes
  } = req.body;

  const query = `
    INSERT INTO customers (
      customer_type, company_name, contact_person, phone_primary, 
      phone_alternate, address, tin_number, security_deposit, holding_limit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(
    query,
    ['REGULAR', company_name, contact_person, phone_primary, phone_alternate, address, tin_number, security_deposit || 0, holding_limit],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({
        customer_id: this.lastID,
        message: 'Customer created successfully'
      });
    }
  );
});

// Update customer
router.put('/:id', (req, res) => {
  const customerId = req.params.id;
  const {
    company_name,
    contact_person,
    phone_primary,
    phone_alternate,
    address,
    tin_number,
    security_deposit,
    holding_limit,
    is_active
  } = req.body;

  const query = `
    UPDATE customers SET
      company_name = ?,
      contact_person = ?,
      phone_primary = ?,
      phone_alternate = ?,
      address = ?,
      tin_number = ?,
      security_deposit = ?,
      holding_limit = ?,
      is_active = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE customer_id = ?
  `;

  db.run(
    query,
    [company_name, contact_person, phone_primary, phone_alternate, address, tin_number, security_deposit, holding_limit, is_active, customerId],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Customer not found' });
      }
      res.json({ message: 'Customer updated successfully' });
    }
  );
});

// Get customer transactions (given)
router.get('/:id/transactions/given', (req, res) => {
  const customerId = req.params.id;

  const query = `
    SELECT 
      bli.line_item_id,
      b.bill_date as date,
      b.bill_number,
      gt.gas_type_name,
      cs.size_label,
      bli.serial_number,
      bli.quantity,
      bli.rate,
      bli.amount
    FROM bill_line_items bli
    JOIN bills b ON bli.bill_id = b.bill_id
    JOIN gas_types gt ON bli.gas_type_id = gt.gas_type_id
    JOIN cylinder_sizes cs ON bli.cylinder_size_id = cs.size_id
    WHERE b.customer_id = ? AND bli.direction = 'GIVEN'
    ORDER BY b.bill_date DESC
  `;

  db.all(query, [customerId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Get customer transactions (received)
router.get('/:id/transactions/received', (req, res) => {
  const customerId = req.params.id;

  const query = `
    SELECT 
      bli.line_item_id,
      b.bill_date as date,
      b.bill_number,
      gt.gas_type_name,
      cs.size_label,
      bli.serial_number,
      bli.quantity
    FROM bill_line_items bli
    JOIN bills b ON bli.bill_id = b.bill_id
    JOIN gas_types gt ON bli.gas_type_id = gt.gas_type_id
    JOIN cylinder_sizes cs ON bli.cylinder_size_id = cs.size_id
    WHERE b.customer_id = ? AND bli.direction = 'RECEIVED'
    ORDER BY b.bill_date DESC
  `;

  db.all(query, [customerId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Get customer payment history
router.get('/:id/payments', (req, res) => {
  const customerId = req.params.id;

  const query = `
    SELECT 
      pr.*,
      b.bill_number
    FROM payment_receipts pr
    LEFT JOIN bills b ON pr.bill_id = b.bill_id
    WHERE pr.customer_id = ?
    ORDER BY pr.date DESC
  `;

  db.all(query, [customerId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

module.exports = router;
