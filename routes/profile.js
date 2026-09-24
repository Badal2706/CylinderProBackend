const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { requireStepUpAuth, stepUpGate } = require('../middleware/stepUp');
const { blockChangesWhileRestoring } = require('../middleware/restoreGate');
const validate = require('../middleware/validate');
const V = require('../validators/schemas');
const ctrl = require('../controllers/profile.controller');

router.use(authMiddleware);
// R162: while a restore is writing into this account (or died while writing), nothing here may
// change it. Reads stay open, except the backup download, which writes a BACKUP_TAKEN audit row
// the restore's final count check would trip over. The recovery actions below stay reachable.
router.use(blockChangesWhileRestoring({
  allow: ['POST /verify-password', 'POST /logout-all', 'POST /restore-recovery'],
  alsoBlock: ['GET /backup']
}));

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
router.put('/business', requireStepUpAuth, validate(V.businessProfile), ctrl.updateBusinessProfile);
router.get('/locations', ctrl.getLocationProfiles);
// Phase 20: single shared save for all three location profiles.
router.post('/locations', requireStepUpAuth, validate(V.locationCreate), ctrl.createLocationProfile);
router.put('/locations', requireStepUpAuth, ctrl.updateLocationProfilesBatch);
router.put('/locations/:location', requireStepUpAuth, ctrl.updateLocationProfile);
router.get('/audit-log', ctrl.getAuditLog);
router.patch('/active-location', ctrl.setActiveLocation);
// Confirms the account password alone. Lets the UI stop a wrong password before it drags the
// operator through owner approval — see profile.service.verifyPassword.
router.post('/verify-password', ctrl.verifyPassword);
router.post('/logout-all', ctrl.logoutAll);
router.delete('/delete-account', ctrl.deleteAccount);
// R161: the explicit, separate step that lets a backup be restored into an account that has data.
router.post('/empty-account', ctrl.emptyAccountForRestore);
router.get('/export-data', ctrl.exportData);
// Phase GEN-C: the disaster-recovery backup.
//
// NOT step-up gated (changed 30 Aug 2026, on the owner's explicit instruction, so that taking
// a backup does not demand a trusted-person code every day). Be clear about what that means:
// this archive is enough to reconstruct the entire account elsewhere, so ANY logged-in session
// can now export every customer, bill, payment and history record in one request. The session
// itself is the only thing standing in front of it.
//
// Two things deliberately did NOT change. Every backup is written to the audit log as
// BACKUP_TAKEN / via SESSION, so it is still answerable after the fact. And RESTORE stays
// gated below — reading the data out is now a convenience, but writing an account's contents
// is not, and the two are not the same risk.
router.get('/backup', ctrl.exportBackup);
// Restore. Preview parses and validates the uploaded archive and writes NOTHING; confirm starts
// the job and returns immediately, with progress polled from /restore/status. All three are
// step-up gated — a restore replaces an entire account's contents.
router.post('/restore/preview', stepUpGate('Restoring from a backup'), ctrl.restorePreview);
router.post('/restore/confirm', stepUpGate('Restoring from a backup'), ctrl.restoreConfirm);
router.get('/restore/status/:jobId', ctrl.restoreStatus);
// R162: where the account stands (normal / emptied, waiting for a restore / restore in progress or
// unfinished), and the two ways out. Both need the password AND an owner-only approval, exactly
// like Empty This Account, and both are enforced in the service.
router.get('/restore-state', ctrl.restoreState);
router.post('/restore-cancel', ctrl.cancelPendingRestore);
router.post('/restore-recovery', ctrl.recoverUnfinishedRestore);

module.exports = router;
