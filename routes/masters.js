const express = require('express');
const router = express.Router();
const { requireStepUpAny } = require('../middleware/stepUp');
const ctrl = require('../controllers/masters.controller');

// NOTE: reads stay unauthenticated — these are global catalogs, not per-tenant data.
// Mutations require a verified step-up approval token (Phase 18): the token itself proves a
// trusted person approved the change, so no session auth is needed here.
router.get('/gas-types', ctrl.listGasTypes);
router.post('/gas-types', requireStepUpAny, ctrl.createGasType);
router.delete('/gas-types/:id', requireStepUpAny, ctrl.deleteGasType);
router.get('/cylinder-sizes', ctrl.listCylinderSizes);
router.post('/cylinder-sizes', requireStepUpAny, ctrl.createCylinderSize);
router.delete('/cylinder-sizes/:id', requireStepUpAny, ctrl.deleteCylinderSize);
// Per-gas scoped size catalog (Phase 10) — the runtime gas → sizes source of truth.
router.get('/gas-capacities', ctrl.getGasCapacities);
router.post('/gas-capacities/:gas/sizes', requireStepUpAny, ctrl.addSizeToGas);
router.delete('/gas-capacities/:gas/sizes', requireStepUpAny, ctrl.removeSizeFromGas);

module.exports = router;
