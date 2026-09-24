const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { blockCreateWhileRestoring: noNew, blockChangesWhileRestoring } = require('../middleware/restoreGate');
const validate = require('../middleware/validate');
const V = require('../validators/schemas');
const ctrl = require('../controllers/bills.controller');

router.use(authMiddleware);
// R162: nothing changes while a restore is writing into this account.
router.use(blockChangesWhileRestoring());

router.post('/validate-cylinder', ctrl.validateCylinder);
// NOTE: '/drafts' and '/stats/today' MUST stay declared before '/:id'.
router.get('/drafts', ctrl.listDrafts);
router.post('/drafts', noNew, ctrl.saveDraft);
router.get('/stats/today', ctrl.getTodayStats);
router.get('/next-number', ctrl.getNextBillNumber); // Phase 27: prefill the form's Bill Number
router.get('/', ctrl.listBills);
router.get('/:id', ctrl.getBill);
router.post('/', noNew, validate(V.billCreate), ctrl.createBill);
router.put('/:id', validate(V.billUpdate), ctrl.updateBill);
router.patch('/:id/dsr-remark', ctrl.setDsrRemark);
router.delete('/:id', ctrl.deleteBill);

module.exports = router;
