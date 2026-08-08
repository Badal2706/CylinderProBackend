const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const validate = require('../middleware/validate');
const V = require('../validators/schemas');
const ctrl = require('../controllers/bills.controller');

router.use(authMiddleware);

router.post('/validate-cylinder', ctrl.validateCylinder);
// NOTE: '/drafts' and '/stats/today' MUST stay declared before '/:id'.
router.get('/drafts', ctrl.listDrafts);
router.post('/drafts', ctrl.saveDraft);
router.get('/stats/today', ctrl.getTodayStats);
router.get('/next-number', ctrl.getNextBillNumber); // Phase 27: prefill the form's Bill Number
router.get('/', ctrl.listBills);
router.get('/:id', ctrl.getBill);
router.post('/', validate(V.billCreate), ctrl.createBill);
router.put('/:id', validate(V.billUpdate), ctrl.updateBill);
router.patch('/:id/dsr-remark', ctrl.setDsrRemark);
router.delete('/:id', ctrl.deleteBill);

module.exports = router;
