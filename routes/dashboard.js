const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/dashboard.controller');

router.use(authMiddleware);

router.get('/stats', ctrl.getStats);
router.get('/cylinder-stock', ctrl.getCylinderStock);
router.get('/over-limit', ctrl.getOverLimitCustomers);

module.exports = router;
