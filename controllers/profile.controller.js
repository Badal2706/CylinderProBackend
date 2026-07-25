const asyncHandler = require('../middleware/asyncHandler');
const profileService = require('../services/profile.service');

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

exports.logoutAll = asyncHandler(async (req, res) => {
  res.json(await profileService.logoutAll(req.user.id));
});

exports.deleteAccount = asyncHandler(async (req, res) => {
  // Phase 21: password + owner-only step-up approval, both enforced in the service.
  res.json(await profileService.deleteAccount(req.user.id, req.body.password,
    req.headers['x-step-up-token'] || req.body.step_up_token));
});

// Streams a ZIP directly to res — keeps its own error handling (matching the original
// behavior) since headers may already be sent by the time an error occurs mid-stream.
exports.exportData = async (req, res) => {
  try {
    await profileService.exportData(req.user.id, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};
