const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create database connection
const db = new sqlite3.Database(path.join(__dirname, 'cylinder_management.db'), (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

// Initialize database tables
function initializeDatabase() {
  // Customers table
  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_type TEXT CHECK(customer_type IN ('REGULAR', 'ONE_TIME')) NOT NULL,
      company_name TEXT NOT NULL,
      contact_person TEXT,
      phone_primary TEXT NOT NULL,
      phone_alternate TEXT,
      address TEXT,
      tin_number TEXT,
      security_deposit REAL DEFAULT 0,
      holding_limit INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Gas Type Master table
  db.run(`
    CREATE TABLE IF NOT EXISTS gas_types (
      gas_type_id INTEGER PRIMARY KEY AUTOINCREMENT,
      gas_type_name TEXT NOT NULL UNIQUE,
      is_active INTEGER DEFAULT 1
    )
  `);

  // Cylinder Size Master table
  db.run(`
    CREATE TABLE IF NOT EXISTS cylinder_sizes (
      size_id INTEGER PRIMARY KEY AUTOINCREMENT,
      size_label TEXT NOT NULL UNIQUE,
      is_active INTEGER DEFAULT 1
    )
  `);

  // Bills/Transactions table
  db.run(`
    CREATE TABLE IF NOT EXISTS bills (
      bill_id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      bill_date DATE NOT NULL,
      transaction_type TEXT CHECK(transaction_type IN ('GIVEN', 'RECEIVED', 'SWAP')) NOT NULL,
      total_given_qty INTEGER DEFAULT 0,
      total_received_qty INTEGER DEFAULT 0,
      total_bill_amount REAL DEFAULT 0,
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
    )
  `);

  // Bill Line Items table
  db.run(`
    CREATE TABLE IF NOT EXISTS bill_line_items (
      line_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL,
      direction TEXT CHECK(direction IN ('GIVEN', 'RECEIVED')) NOT NULL,
      gas_type_id INTEGER NOT NULL,
      cylinder_size_id INTEGER NOT NULL,
      serial_number TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      FOREIGN KEY (bill_id) REFERENCES bills(bill_id),
      FOREIGN KEY (gas_type_id) REFERENCES gas_types(gas_type_id),
      FOREIGN KEY (cylinder_size_id) REFERENCES cylinder_sizes(size_id)
    )
  `);

  // Payment Receipts table
  db.run(`
    CREATE TABLE IF NOT EXISTS payment_receipts (
      receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      bill_id INTEGER,
      date DATE NOT NULL,
      amount_received REAL NOT NULL,
      discount REAL DEFAULT 0,
      payment_mode TEXT CHECK(payment_mode IN ('CASH', 'CHEQUE', 'ONLINE')) NOT NULL,
      cheque_number TEXT,
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
      FOREIGN KEY (bill_id) REFERENCES bills(bill_id)
    )
  `);

  // Users table for authentication
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'ADMIN',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Insert default gas types after tables are created
  db.serialize(() => {
    db.run(`
      INSERT OR IGNORE INTO gas_types (gas_type_name) VALUES 
      ('Medical Oxygen'),
      ('Industrial Oxygen'),
      ('Nitrogen'),
      ('CO2'),
      ('Argon')
    `, (err) => {
      if (err) console.error('Error inserting gas types:', err);
    });

    // Insert default cylinder sizes
    db.run(`
      INSERT OR IGNORE INTO cylinder_sizes (size_label) VALUES 
      ('1.5mm'),
      ('7mm'),
      ('10mm')
    `, (err) => {
      if (err) console.error('Error inserting cylinder sizes:', err);
      else console.log('Database tables initialized');
    });
  });
}

module.exports = db;
