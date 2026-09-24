const asyncHandler = require('../middleware/asyncHandler');
const profileService = require('../services/profile.service');
const backupService = require('../services/backup.service');
const restoreService = require('../services/restore.service');
const logger = require('../logger');

exports.getAccount = asyncHandler(async (req, res) => {
  res.json(await profileService.getAccount(req.user.id));
});

exports.updateAccount = asyncHandler(async (req, res) => {
  const result = await profileService.updateAccount(req.user.id, req.body);
  // Phase 20: route is step-up-gated; record who approved the account-info save.
  await require('../services/audit.service').record({
    userId: req.user.id, action: 'PROFILE_SAVE', target: 'Account Information', stepUp: req.stepUp
  });
  res.json(result);
});

// Phase 20: one shared save for all three location profiles.
exports.updateLocationProfilesBatch = asyncHandler(async (req, res) => {
  const result = await profileService.updateLocationProfilesBatch(req.user.id, req.body.profiles);
  await require('../services/audit.service').record({
    userId: req.user.id, action: 'PROFILE_SAVE', target: 'Location Profiles (all sites)', stepUp: req.stepUp
  });
  res.json(result);
});

// Phase GEN-B2: add a location. Step-up gated and audit-logged like every other profile mutation.
exports.createLocationProfile = asyncHandler(async (req, res) => {
  const result = await profileService.createLocationProfile(req.user.id, req.body);
  await require('../services/audit.service').record({
    userId: req.user.id, action: 'PROFILE_SAVE',
    target: `Location Profile created — ${result.profile.label} (${result.profile.location})`,
    stepUp: req.stepUp
  });
  res.status(201).json(result);
});

// Phase 26: step 1 — send a code to the new address. Persists nothing.
exports.requestEmailChange = asyncHandler(async (req, res) => {
  res.json(await profileService.requestEmailChange(req.user.id, req.body));
});

// Step 2 — correct code persists the new email and starts the authenticator rotation.
exports.confirmEmailChange = asyncHandler(async (req, res) => {
  res.json(await profileService.confirmEmailChange(req.user.id, req.body));
});

exports.changePassword = asyncHandler(async (req, res) => {
  const result = await profileService.changePassword(req.user.id, req.body);
  // Phase 19: route is step-up-gated; record who approved the password change.
  await require('../services/audit.service').record({
    userId: req.user.id, action: 'PROFILE_SAVE', target: 'Account password', stepUp: req.stepUp
  });
  res.json(result);
});

exports.getBusinessProfile = asyncHandler(async (req, res) => {
  res.json(await profileService.getBusinessProfile(req.user.id));
});

exports.updateBusinessProfile = asyncHandler(async (req, res) => {
  const result = await profileService.updateBusinessProfile(req.user.id, req.body);
  // Phase 18: route is step-up-gated; record who approved the save.
  await require('../services/audit.service').record({
    userId: req.user.id, action: 'PROFILE_SAVE', target: 'Business Information', stepUp: req.stepUp
  });
  res.json(result);
});

exports.getLocationProfiles = asyncHandler(async (req, res) => {
  res.json(await profileService.getLocationProfiles(req.user.id));
});

exports.updateLocationProfile = asyncHandler(async (req, res) => {
  const result = await profileService.updateLocationProfile(req.user.id, req.params.location, req.body);
  await require('../services/audit.service').record({
    userId: req.user.id, action: 'PROFILE_SAVE', target: `Location Profile — ${req.params.location}`, stepUp: req.stepUp
  });
  res.json(result);
});

// Phase 18: recent step-up authorizations (who approved what, when, via which method).
exports.getAuditLog = asyncHandler(async (req, res) => {
  res.json(await require('../services/audit.service').list(req.user.id));
});

exports.setActiveLocation = asyncHandler(async (req, res) => {
  res.json(await profileService.setActiveLocation(req.user.id, req.body.location));
});

exports.verifyPassword = asyncHandler(async (req, res) => {
  res.json(await profileService.verifyPassword(req.user.id, req.body && req.body.password));
});

exports.logoutAll = asyncHandler(async (req, res) => {
  res.json(await profileService.logoutAll(req.user.id));
});

// R161: empty the account so a backup can be restored into it. Password + owner-only step-up, and
// a backup of this account taken within 30 minutes — all enforced in the service.
exports.emptyAccountForRestore = asyncHandler(async (req, res) => {
  res.json(await profileService.emptyAccountForRestore(req.user.id, req.body.password,
    req.headers['x-step-up-token'] || req.body.step_up_token));
});

exports.deleteAccount = asyncHandler(async (req, res) => {
  // Phase 21: password + owner-only step-up approval, both enforced in the service.
  res.json(await profileService.deleteAccount(req.user.id, req.body.password,
    req.headers['x-step-up-token'] || req.body.step_up_token));
});

// ─── Phase GEN-C: restore ───
// The request body IS the .zip (bodyParser is bypassed for this path in server.js), so the
// service consumes `req` as a stream rather than reading req.body.
exports.restorePreview = asyncHandler(async (req, res) => {
  res.json(await restoreService.previewRestore(req.user.id, req));
});

exports.restoreConfirm = asyncHandler(async (req, res) => {
  res.json(await restoreService.confirmRestore(req.user.id, req.body && req.body.restore_token));
});

exports.restoreStatus = asyncHandler(async (req, res) => {
  res.json(await restoreService.getRestoreStatus(req.user.id, req.params.jobId));
});

// R162: the account's restore state, and the two ways back to normal use.
exports.restoreState = asyncHandler(async (req, res) => {
  res.json(await restoreService.getRestoreState(req.user.id));
});

exports.cancelPendingRestore = asyncHandler(async (req, res) => {
  res.json(await profileService.cancelPendingRestore(req.user.id, req.body.password,
    req.headers['x-step-up-token'] || req.body.step_up_token));
});

exports.recoverUnfinishedRestore = asyncHandler(async (req, res) => {
  res.json(await profileService.recoverUnfinishedRestore(req.user.id, req.body.password,
    req.headers['x-step-up-token'] || req.body.step_up_token, req.body.action));
});

// Phase GEN-C: the full-fidelity BACKUP, not the XLSX report export below. Same streaming
// error handling: headers are already sent once the archive starts, so a mid-stream failure
// cannot be turned into a JSON error response.
exports.exportBackup = async (req, res) => {
  try {
    // Recorded BEFORE the stream starts, not after: a backup that fails halfway still means the
    // export was requested and part of the data left the server, which is the thing worth knowing.
    await require('../services/audit.service').record({
      userId: req.user.id, action: 'BACKUP_TAKEN', target: 'Full account backup',
      detail: 'Downloaded without trusted-person approval (session only)',
      stepUp: { via: 'SESSION' }
    });
    await backupService.exportBackup(req.user.id, res);
  } catch (err) {
    logger.error(`exportBackup failed: ${err.stack || err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Could not generate the backup. Please try again.' });
    else res.destroy();
  }
};

// Streams a ZIP directly to res — keeps its own error handling (matching the original
// behavior) since headers may already be sent by the time an error occurs mid-stream.
exports.exportData = async (req, res) => {
  try {
    await profileService.exportData(req.user.id, res);
  } catch (err) {
    // Phase 30: log the real error server-side; return a generic message (no raw error text).
    logger.error(`exportData failed: ${err.stack || err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Could not generate the data export. Please try again.' });
  }
};
