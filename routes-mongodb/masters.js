const express = require('express');
const router = express.Router();
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');

// Get all gas types
router.get('/gas-types', async (req, res) => {
  try {
    const gasTypes = await GasType.find({ is_active: true }).sort('gas_type_name');
    res.json(gasTypes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add new gas type
router.post('/gas-types', async (req, res) => {
  try {
    const { gas_type_name } = req.body;
    
    if (!gas_type_name) {
      return res.status(400).json({ error: 'Gas type name is required' });
    }

    const gasType = new GasType({ gas_type_name });
    await gasType.save();
    
    res.json({
      gas_type_id: gasType._id,
      message: 'Gas type added successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all cylinder sizes
router.get('/cylinder-sizes', async (req, res) => {
  try {
    const sizes = await CylinderSize.find({ is_active: true }).sort('size_label');
    res.json(sizes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add new cylinder size
router.post('/cylinder-sizes', async (req, res) => {
  try {
    const { size_label } = req.body;
    
    if (!size_label) {
      return res.status(400).json({ error: 'Size label is required' });
    }

    const size = new CylinderSize({ size_label });
    await size.save();
    
    res.json({
      size_id: size._id,
      message: 'Cylinder size added successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
