const express = require('express');
const router = express.Router();
const db = require('../database');

// Get all bills
router.get('/', (req, res) => {
  const { date, customer_id } = req.query;
  
  let query = `
    SELECT 
      b.*,
      c.company_name,
      c.phone_primary
    FROM bills b
    JOIN customers c ON b.customer_id = c.customer_id
    WHERE 1=1
  `;

  const params = [];
  
  if (date) {
    query += ` AND DATE(b.bill_date) = DATE(?)`;
    params.push(date);
  }
  
  if (customer_id) {
    query += ` AND b.customer_id = ?`;
    params.push(customer_id);
  }

  query += ` ORDER BY b.bill_date DESC, b.bill_id DESC`;

  db.all(query, params, (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Get single bill with line items
router.get('/:id', (req, res) => {
  const billId = req.params.id;

  const billQuery = `
    SELECT 
      b.*,
      c.company_name,
      c.contact_person,
      c.phone_primary,
      c.phone_alternate,
      c.address,
      c.tin_number
    FROM bills b
    JOIN customers c ON b.customer_id = c.customer_id
    WHERE b.bill_id = ?
  `;

  db.get(billQuery, [billId], (err, bill) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const lineItemsQuery = `
      SELECT 
        bli.*,
        gt.gas_type_name,
        cs.size_label
      FROM bill_line_items bli
      JOIN gas_types gt ON bli.gas_type_id = gt.gas_type_id
      JOIN cylinder_sizes cs ON bli.cylinder_size_id = cs.size_id
      WHERE bli.bill_id = ?
      ORDER BY bli.direction, bli.line_item_id
    `;

    db.all(lineItemsQuery, [billId], (err, lineItems) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      bill.line_items = lineItems;
      bill.given_items = lineItems.filter(item => item.direction === 'GIVEN');
      bill.received_items = lineItems.filter(item => item.direction === 'RECEIVED');
      
      res.json(bill);
    });
  });
});

// Generate next bill number
function generateBillNumber(callback) {
  db.get('SELECT MAX(bill_id) as max_id FROM bills', [], (err, row) => {
    if (err) {
      return callback(err);
    }
    const nextId = (row.max_id || 0) + 1;
    const billNumber = `BILL-${String(nextId).padStart(4, '0')}`;
    callback(null, billNumber);
  });
}

// Create new bill
router.post('/', (req, res) => {
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

  // Validation
  if (!customer_id && customer_type !== 'ONE_TIME') {
    return res.status(400).json({ error: 'Customer ID is required for regular customers' });
  }

  if (customer_type === 'ONE_TIME' && !one_time_customer) {
    return res.status(400).json({ error: 'One-time customer details are required' });
  }

  if (!given_items && !received_items) {
    return res.status(400).json({ error: 'At least one cylinder must be in the cart' });
  }

  // Validate serial numbers match quantity
  const allItems = [...(given_items || []), ...(received_items || [])];
  for (const item of allItems) {
    if (!item.serial_numbers || item.serial_numbers.length === 0) {
      return res.status(400).json({ error: 'Serial numbers cannot be blank' });
    }
    if (item.serial_numbers.length !== item.quantity) {
      return res.status(400).json({ error: 'Number of serial numbers must match quantity' });
    }
  }

  generateBillNumber((err, billNumber) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      let finalCustomerId = customer_id;

      // Create one-time customer if needed
      if (customer_type === 'ONE_TIME') {
        const insertCustomerQuery = `
          INSERT INTO customers (
            customer_type, company_name, contact_person, phone_primary, address
          ) VALUES ('ONE_TIME', ?, ?, ?, ?)
        `;

        db.run(
          insertCustomerQuery,
          [
            one_time_customer.company_name,
            one_time_customer.contact_person,
            one_time_customer.phone_primary,
            one_time_customer.address
          ],
          function(err) {
            if (err) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: err.message });
            }
            finalCustomerId = this.lastID;
            createBill();
          }
        );
      } else {
        createBill();
      }

      function createBill() {
        const total_given_qty = given_items ? given_items.reduce((sum, item) => sum + item.quantity, 0) : 0;
        const total_received_qty = received_items ? received_items.reduce((sum, item) => sum + item.quantity, 0) : 0;
        const total_bill_amount = given_items ? given_items.reduce((sum, item) => sum + item.amount, 0) : 0;

        const insertBillQuery = `
          INSERT INTO bills (
            bill_number, customer_id, bill_date, transaction_type,
            total_given_qty, total_received_qty, total_bill_amount, remarks
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(
          insertBillQuery,
          [billNumber, finalCustomerId, bill_date, transaction_type, total_given_qty, total_received_qty, total_bill_amount, remarks],
          function(err) {
            if (err) {
              db.run('ROLLBACK');
              return res.status(500).json({ error: err.message });
            }

            const billId = this.lastID;
            let itemsProcessed = 0;
            const totalItems = allItems.length;

            if (totalItems === 0) {
              db.run('COMMIT');
              return res.json({
                bill_id: billId,
                bill_number: billNumber,
                message: 'Bill created successfully'
              });
            }

            // Insert line items
            allItems.forEach(item => {
              item.serial_numbers.forEach(serialNumber => {
                const insertLineItemQuery = `
                  INSERT INTO bill_line_items (
                    bill_id, direction, gas_type_id, cylinder_size_id,
                    serial_number, quantity, rate, amount
                  ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                `;

                db.run(
                  insertLineItemQuery,
                  [
                    billId,
                    item.direction,
                    item.gas_type_id,
                    item.cylinder_size_id,
                    serialNumber,
                    item.rate || 0,
                    item.direction === 'GIVEN' ? item.rate : 0
                  ],
                  function(err) {
                    if (err) {
                      db.run('ROLLBACK');
                      return res.status(500).json({ error: err.message });
                    }

                    itemsProcessed++;
                    if (itemsProcessed === totalItems * item.serial_numbers.length || itemsProcessed >= totalItems) {
                      db.run('COMMIT', (err) => {
                        if (err) {
                          return res.status(500).json({ error: err.message });
                        }
                        res.json({
                          bill_id: billId,
                          bill_number: billNumber,
                          message: 'Bill created successfully'
                        });
                      });
                    }
                  }
                );
              });
            });
          }
        );
      }
    });
  });
});

// Today's transactions count
router.get('/stats/today', (req, res) => {
  const query = `
    SELECT COUNT(*) as count
    FROM bills
    WHERE DATE(bill_date) = DATE('now')
  `;

  db.get(query, [], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ today_transactions: row.count });
  });
});

module.exports = router;
