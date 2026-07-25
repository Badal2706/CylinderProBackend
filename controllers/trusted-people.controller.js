const asyncHandler = require('../middleware/asyncHandler');
const svc = require('../services/trustedPeople.service');
const stepup = require('../services/stepup.service');

// Phase 18: list management (add/edit/remove) requires step-up approval once at least one
// active trusted person exists — enforced in the service (which knows the active count).
const stepUpOf = (req) =>
  stepup.tryStepUp(req.user.id, req.headers['x-step-up-token'] || (req.body && req.body.step_up_token));

exports.list = asyncHandler(async (req, res) => {
  res.json(await svc.list(req.user.id));
});

exports.add = asyncHandler(async (req, res) => {
  res.json(await svc.add(req.user.id, req.body, stepUpOf(req)));
});

exports.resendOtp = asyncHandler(async (req, res) => {
  res.json(await svc.resendOtp(req.user.id, req.params.id));
});

exports.verifyEmail = asyncHandler(async (req, res) => {
  res.json(await svc.verifyEmail(req.user.id, req.params.id, req.body.code));
});

exports.update = asyncHandler(async (req, res) => {
  res.json(await svc.update(req.user.id, req.params.id, req.body, stepUpOf(req)));
});

exports.remove = asyncHandler(async (req, res) => {
  res.json(await svc.remove(req.user.id, req.params.id, stepUpOf(req)));
});

exports.totpEnroll = asyncHandler(async (req, res) => {
  res.json(await svc.totpEnroll(req.user.id, req.params.id));
});

exports.totpConfirm = asyncHandler(async (req, res) => {
  res.json(await svc.totpConfirm(req.user.id, req.params.id, req.body.code));
});

// ─── Step-up verification (consumed by Phase 18's gated actions) ───
// Phase 21: `context` = human-readable description of what is being authorized (included in
// the OTP email); `owner_only` = restrict the approval to the bootstrap account owner
// (enforced in the service, and again when the token is consumed).
exports.stepUpOtpSend = asyncHandler(async (req, res) => {
  res.json(await stepup.sendStepUpOtp(req.user.id, req.body.person_id, {
    context: req.body.context, ownerOnly: !!req.body.owner_only
  }));
});

exports.stepUpOtpVerify = asyncHandler(async (req, res) => {
  res.json(await stepup.verifyStepUpOtp(req.user.id, req.body.person_id, req.body.code, {
    ownerOnly: !!req.body.owner_only
  }));
});

exports.stepUpTotpVerify = asyncHandler(async (req, res) => {
  res.json(await stepup.verifyStepUpTotp(req.user.id, req.body.code, {
    ownerOnly: !!req.body.owner_only
  }));
});
