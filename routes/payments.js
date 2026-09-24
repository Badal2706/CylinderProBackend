const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { blockCreateWhileRestoring: noNew, blockChangesWhileRestoring } = require('../middleware/restoreGate');
const validate = require('../middleware/validate');
const V = require('../validators/schemas');
const ctrl = require('../controllers/payments.controller');

router.use(authMiddleware);
// R162: nothing changes while a restore is writing into this account.
router.use(blockChangesWhileRestoring());

router.post('/', noNew, validate(V.paymentCreate), ctrl.createPayment);
router.get('/', ctrl.listPayments);
router.put('/:id', ctrl.updatePayment);

module.exports = router;
