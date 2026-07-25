const express = require('express');
const router = express.Router();
const db = require('../database');

// Customer Ledger Report (All Customers)
router.get('/ledger', (req, res) => {
  const query = `
    SELECT 
      c.customer_id,
      c.company_name,
      c.contact_person,
      c.phone_primary,
      c.tin_number,
      c.security_deposit,
      c.holding_limit,
      COALESCE(SUM(CASE WHEN b.transaction_type IN ('GIVEN', 'SWAP') THEN b.total_bill_amount ELSE 0 END), 0) -
      COALESCE(SUM(pr.amount_received - pr.discount), 0) as bill_amount,
      COALESCE(SUM(CASE WHEN bli.direction = 'GIVEN' THEN bli.quantity ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN bli.direction = 'RECEIVED' THEN bli.quantity ELSE 0 END), 0) as cylinder_hold
    FROM customers c
    LEFT JOIN bills b ON c.customer_id = b.customer_id
    LEFT JOIN bill_line_items bli ON b.bill_id = bli.bill_id
    LEFT JOIN payment_receipts pr ON c.customer_id = pr.customer_id
    WHERE c.customer_type = 'REGULAR' AND c.is_active = 1
    GROUP BY c.customer_id
    ORDER BY c.company_name
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const customers = rows.map(customer => ({
      ...customer,
      status: customer.cylinder_hold > customer.holding_limit ? 'OVER LIMIT' : ''
    }));

    res.json(customers);
  });
});

// Over Limit Customers Report
router.get('/over-limit', (req, res) => {
  const query = `
    SELECT 
      c.customer_id,
      c.company_name,
      c.contact_person,
      c.phone_primary,
      c.holding_limit,
      COALESCE(SUM(CASE WHEN bli.direction = 'GIVEN' THEN bli.quantity ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN bli.direction = 'RECEIVED' THEN bli.quantity ELSE 0 END), 0) as cylinders_held
    FROM customers c
    LEFT JOIN bills b ON c.customer_id = b.customer_id
    LEFT JOIN bill_line_items bli ON b.bill_id = bli.bill_id
    WHERE c.customer_type = 'REGULAR' AND c.is_active = 1
    GROUP BY c.customer_id
    HAVING cylinders_held > c.holding_limit
    ORDER BY (cylinders_held - c.holding_limit) DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Daily Transaction Report
router.get('/daily', (req, res) => {
  const { date } = req.query;
  
  if (!date) {
    return res.status(400).json({ error: 'Date parameter is required' });
  }

  const query = `
    SELECT 
      b.*,
      c.company_name,
      c.phone_primary
    FROM bills b
    JOIN customers c ON b.customer_id = c.customer_id
    WHERE DATE(b.bill_date) = DATE(?)
    ORDER BY b.bill_id DESC
  `;

  db.all(query, [date], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Cylinder Stock Summary
router.get('/cylinder-stock', (req, res) => {
  const query = `
    SELECT 
      gt.gas_type_name,
      cs.size_label,
      COALESCE(SUM(CASE WHEN bli.direction = 'GIVEN' THEN bli.quantity ELSE 0 END), 0) as total_given,
      COALESCE(SUM(CASE WHEN bli.direction = 'RECEIVED' THEN bli.quantity ELSE 0 END), 0) as total_received,
      COALESCE(SUM(CASE WHEN bli.direction = 'GIVEN' THEN bli.quantity ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN bli.direction = 'RECEIVED' THEN bli.quantity ELSE 0 END), 0) as currently_out
    FROM bill_line_items bli
    JOIN gas_types gt ON bli.gas_type_id = gt.gas_type_id
    JOIN cylinder_sizes cs ON bli.cylinder_size_id = cs.size_id
    GROUP BY gt.gas_type_name, cs.size_label
    ORDER BY gt.gas_type_name, cs.size_label
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Outstanding Dues Report
router.get('/outstanding', (req, res) => {
  const query = `
    SELECT 
      c.customer_id,
      c.company_name,
      c.phone_primary,
      COALESCE(SUM(b.total_bill_amount), 0) -
      COALESCE(SUM(pr.amount_received - pr.discount), 0) as outstanding_amount
    FROM customers c
    LEFT JOIN bills b ON c.customer_id = b.customer_id
    LEFT JOIN payment_receipts pr ON c.customer_id = pr.customer_id
    WHERE c.customer_type = 'REGULAR'
    GROUP BY c.customer_id
    HAVING outstanding_amount > 0
    ORDER BY outstanding_amount DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Deposit Summary Report
router.get('/deposits', (req, res) => {
  const query = `
    SELECT 
      customer_id,
      company_name,
      contact_person,
      phone_primary,
      security_deposit
    FROM customers
    WHERE customer_type = 'REGULAR' AND security_deposit > 0
    ORDER BY company_name
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Customer Statement (Date range)
router.get('/customer-statement/:id', (req, res) => {
  const customerId = req.params.id;
  const { start_date, end_date } = req.query;

  let query = `
    SELECT 
      b.bill_date as date,
      b.bill_number,
      b.transaction_type,
      'BILL' as type,
      b.total_bill_amount as debit,
      0 as credit,
      b.remarks
    FROM bills b
    WHERE b.customer_id = ?
  `;

  const params = [customerId];

  if (start_date && end_date) {
    query += ` AND DATE(b.bill_date) BETWEEN DATE(?) AND DATE(?)`;
    params.push(start_date, end_date);
  }

  query += `
    UNION ALL
    SELECT 
      pr.date,
      pr.receipt_number,
      pr.payment_mode,
      'PAYMENT' as type,
      0 as debit,
      pr.amount_received - pr.discount as credit,
      pr.remarks
    FROM payment_receipts pr
    WHERE pr.customer_id = ?
  `;

  params.push(customerId);

  if (start_date && end_date) {
    query += ` AND DATE(pr.date) BETWEEN DATE(?) AND DATE(?)`;
    params.push(start_date, end_date);
  }

  query += ` ORDER BY date DESC`;

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

module.exports = router;
