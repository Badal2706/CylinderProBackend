const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/rental.controller');

router.use(authMiddleware);

router.get('/:id', ctrl.getRentalCharge);

module.exports = router;
