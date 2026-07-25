const express = require('express');
const router = express.Router();
const db = require('../database');

// Get all gas types
router.get('/gas-types', (req, res) => {
  const query = `SELECT * FROM gas_types WHERE is_active = 1 ORDER BY gas_type_name`;
  
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Add new gas type
router.post('/gas-types', (req, res) => {
  const { gas_type_name } = req.body;
  
  if (!gas_type_name) {
    return res.status(400).json({ error: 'Gas type name is required' });
  }

  const query = `INSERT INTO gas_types (gas_type_name) VALUES (?)`;
  
  db.run(query, [gas_type_name], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({
      gas_type_id: this.lastID,
      message: 'Gas type added successfully'
    });
  });
});

// Get all cylinder sizes
router.get('/cylinder-sizes', (req, res) => {
  const query = `SELECT * FROM cylinder_sizes WHERE is_active = 1 ORDER BY size_label`;
  
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Add new cylinder size
router.post('/cylinder-sizes', (req, res) => {
  const { size_label } = req.body;
  
  if (!size_label) {
    return res.status(400).json({ error: 'Size label is required' });
  }

  const query = `INSERT INTO cylinder_sizes (size_label) VALUES (?)`;
  
  db.run(query, [size_label], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({
      size_id: this.lastID,
      message: 'Cylinder size added successfully'
    });
  });
});

module.exports = router;
