const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { requireStepUpAuth } = require('../middleware/stepUp');
const ctrl = require('../controllers/profile.controller');

router.use(authMiddleware);

router.get('/', ctrl.getAccount);
// Phase 20: Account Information saves are step-up-gated like every other Profile section.
router.put('/', requireStepUpAuth, ctrl.updateAccount);
// Phase 19: password change is step-up-gated ON TOP of the current-password check inside
// the service — one person knowing the shared password can't lock the others out alone.
router.post('/change-password', requireStepUpAuth, ctrl.changePassword);
// Phase 26: email changes go through a code sent to the NEW address. Requesting is step-up
// gated exactly like the Account Information save it replaces; confirming is not, because
// possession of the pending token PLUS the code from the new inbox is already the proof.
router.post('/email-change/request', requireStepUpAuth, ctrl.requestEmailChange);
router.post('/email-change/verify', ctrl.confirmEmailChange);
// Viewing stays open to any logged-in session; SAVING requires step-up approval (Phase 18).
router.get('/business', ctrl.getBusinessProfile);
router.put('/business', requireStepUpAuth, ctrl.updateBusinessProfile);
router.get('/locations', ctrl.getLocationProfiles);
// Phase 20: single shared save for all three location profiles.
router.put('/locations', requireStepUpAuth, ctrl.updateLocationProfilesBatch);
router.put('/locations/:location', requireStepUpAuth, ctrl.updateLocationProfile);
router.get('/audit-log', ctrl.getAuditLog);
router.patch('/active-location', ctrl.setActiveLocation);
router.post('/logout-all', ctrl.logoutAll);
router.delete('/delete-account', ctrl.deleteAccount);
router.get('/export-data', ctrl.exportData);

module.exports = router;
