const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/reports.controller');

router.use(authMiddleware);

router.get('/dsr', ctrl.getDSR);
router.get('/stock-summary', ctrl.getStockSummary);
router.get('/pc-stock', ctrl.getPcStock); // per-location personal-cylinder stock (Phase 11)
router.get('/ledger', ctrl.getLedgerReport);
router.get('/over-limit', ctrl.getOverLimitReport);
// Old /daily and /cylinder-stock reports removed (Phase 8) — superseded by /dsr and /stock-summary.
router.get('/outstanding', ctrl.getOutstandingReport);
router.get('/deposits', ctrl.getDepositsReport);
router.get('/customer-statement/:id', ctrl.getCustomerStatement);

module.exports = router;
