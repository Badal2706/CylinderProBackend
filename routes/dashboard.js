const express = require('express');
const router = express.Router();
const db = require('../database');

// Get dashboard statistics
router.get('/stats', (req, res) => {
  const stats = {};

  // Total Outstanding Amount
  const outstandingQuery = `
    SELECT 
      COALESCE(SUM(b.total_bill_amount), 0) - COALESCE(SUM(pr.amount_received - pr.discount), 0) as total_outstanding
    FROM bills b
    LEFT JOIN payment_receipts pr ON b.customer_id = pr.customer_id
  `;

  // Total Customers
  const customersQuery = `
    SELECT COUNT(*) as total_customers
    FROM customers
    WHERE customer_type = 'REGULAR' AND is_active = 1
  `;

  // Total Cylinders Out
  const cylindersQuery = `
    SELECT 
      COALESCE(SUM(CASE WHEN direction = 'GIVEN' THEN quantity ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN direction = 'RECEIVED' THEN quantity ELSE 0 END), 0) as total_cylinders_out
    FROM bill_line_items
  `;

  // Today's Transactions
  const todayQuery = `
    SELECT COUNT(*) as today_transactions
    FROM bills
    WHERE DATE(bill_date) = DATE('now')
  `;

  // Total Security Deposit
  const depositQuery = `
    SELECT COALESCE(SUM(security_deposit), 0) as total_deposit
    FROM customers
    WHERE customer_type = 'REGULAR'
  `;

  db.serialize(() => {
    db.get(outstandingQuery, [], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      stats.total_outstanding = row.total_outstanding;

      db.get(customersQuery, [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        stats.total_customers = row.total_customers;

        db.get(cylindersQuery, [], (err, row) => {
          if (err) return res.status(500).json({ error: err.message });
          stats.total_cylinders_out = row.total_cylinders_out;

          db.get(todayQuery, [], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            stats.today_transactions = row.today_transactions;

            db.get(depositQuery, [], (err, row) => {
              if (err) return res.status(500).json({ error: err.message });
              stats.total_security_deposit = row.total_deposit;

              res.json(stats);
            });
          });
        });
      });
    });
  });
});

// Get over limit customers
router.get('/over-limit', (req, res) => {
  const query = `
    SELECT 
      c.customer_id,
      c.company_name,
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

module.exports = router;
