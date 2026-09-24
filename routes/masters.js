const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { blockChangesWhileRestoring } = require('../middleware/restoreGate');
const { stepUpGate } = require('../middleware/stepUp');
const ctrl = require('../controllers/masters.controller');

// Each account owns its own catalogs (24 Sep 2026), so every route is signed-in and works on the
// caller's catalog only. Until then these were global, reads were public, and a mutation needed
// only SOME account's step-up token — so one tenant could change another's catalog.
router.use(authMiddleware);
// R162: nothing changes while a restore is writing into this account.
router.use(blockChangesWhileRestoring());

// Mutations still need a verified step-up approval (Phase 18), now bound to the signed-in account.
// The label keeps the refusal message word-for-word what it was.
const approved = stepUpGate('Changing the gas/size catalogs');

router.get('/gas-types', ctrl.listGasTypes);
router.post('/gas-types', approved, ctrl.createGasType);
router.delete('/gas-types/:id', approved, ctrl.deleteGasType);
router.get('/cylinder-sizes', ctrl.listCylinderSizes);
router.post('/cylinder-sizes', approved, ctrl.createCylinderSize);
router.delete('/cylinder-sizes/:id', approved, ctrl.deleteCylinderSize);
// Per-gas scoped size catalog (Phase 10) — the runtime gas → sizes source of truth.
router.get('/gas-capacities', ctrl.getGasCapacities);
router.post('/gas-capacities/:gas/sizes', approved, ctrl.addSizeToGas);
router.delete('/gas-capacities/:gas/sizes', approved, ctrl.removeSizeFromGas);

module.exports = router;
