const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/payments.controller');

router.use(authMiddleware);

router.post('/', ctrl.createPayment);
router.get('/', ctrl.listPayments);
router.put('/:id', ctrl.updatePayment);

module.exports = router;
