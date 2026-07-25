const express = require('express');
const router = express.Router();
const db = require('../database');

// Generate next receipt number
function generateReceiptNumber(callback) {
  db.get('SELECT MAX(receipt_id) as max_id FROM payment_receipts', [], (err, row) => {
    if (err) {
      return callback(err);
    }
    const nextId = (row.max_id || 0) + 1;
    const receiptNumber = `RCP-${String(nextId).padStart(4, '0')}`;
    callback(null, receiptNumber);
  });
}

// Record new payment
router.post('/', (req, res) => {
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

  generateReceiptNumber((err, receiptNumber) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    const query = `
      INSERT INTO payment_receipts (
        receipt_number, customer_id, bill_id, date, amount_received,
        discount, payment_mode, cheque_number, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.run(
      query,
      [receiptNumber, customer_id, bill_id, date, amount_received, discount || 0, payment_mode, cheque_number, remarks],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        res.json({
          receipt_id: this.lastID,
          receipt_number: receiptNumber,
          message: 'Payment recorded successfully'
        });
      }
    );
  });
});

// Get all payments
router.get('/', (req, res) => {
  const { customer_id } = req.query;

  let query = `
    SELECT 
      pr.*,
      c.company_name,
      b.bill_number
    FROM payment_receipts pr
    JOIN customers c ON pr.customer_id = c.customer_id
    LEFT JOIN bills b ON pr.bill_id = b.bill_id
    WHERE 1=1
  `;

  const params = [];
  
  if (customer_id) {
    query += ` AND pr.customer_id = ?`;
    params.push(customer_id);
  }

  query += ` ORDER BY pr.date DESC`;

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

module.exports = router;
