const asyncHandler = require('../middleware/asyncHandler');
const authService = require('../services/auth.service');

// Device metadata captured at login for the sessions list (Phase 17).
const deviceMeta = (req) => ({
  device: req.headers['user-agent'] || '',
  ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || ''
});

exports.signup = asyncHandler(async (req, res) => {
  res.json(await authService.signup({ ...req.body, ...deviceMeta(req) }));
});

exports.signin = asyncHandler(async (req, res) => {
  res.json(await authService.signin({ ...req.body, ...deviceMeta(req) }));
});

exports.refresh = asyncHandler(async (req, res) => {
  res.json(await authService.refresh(req.user.id, req.user.sid || null));
});

exports.clearData = asyncHandler(async (req, res) => {
  // Phase 21: owner-only step-up token required alongside the password (checked in the service).
  res.json(await authService.clearData(req.user.id, req.body.password,
    req.headers['x-step-up-token'] || req.body.step_up_token));
});

// ─── Sessions & devices (Phase 17) ───
exports.listSessions = asyncHandler(async (req, res) => {
  res.json(await authService.listSessions(req.user.id, req.user.sid || null));
});

exports.revokeSession = asyncHandler(async (req, res) => {
  res.json(await authService.revokeSession(req.user.id, req.params.sid));
});

// ─── Login-email verification + reminder status (Phase 17) ───
exports.sendEmailVerification = asyncHandler(async (req, res) => {
  res.json(await authService.sendEmailVerification(req.user.id));
});

exports.confirmEmailVerification = asyncHandler(async (req, res) => {
  res.json(await authService.confirmEmailVerification(req.user.id, req.body.code));
});

exports.securityStatus = asyncHandler(async (req, res) => {
  res.json(await authService.securityStatus(req.user.id));
});
