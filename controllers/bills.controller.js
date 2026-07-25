const asyncHandler = require('../middleware/asyncHandler');
const billService = require('../services/bill.service');
const { tryStepUp, requireStepUp } = require('../services/stepup.service');

// Step-up token travels in the x-step-up-token header (or step_up_token in the body).
// tryStepUp: null when absent, 403 when present-but-invalid.
const stepUpOf = (req) =>
  tryStepUp(req.user.id, req.headers['x-step-up-token'] || (req.body && req.body.step_up_token));

exports.validateCylinder = asyncHandler(async (req, res) => {
  res.json(await billService.validateCylinder(req.user.id, req.body));
});

exports.listBills = asyncHandler(async (req, res) => {
  res.json(await billService.listBills(req.user.id, req.query));
});

exports.getBill = asyncHandler(async (req, res) => {
  res.json(await billService.getBill(req.user.id, req.params.id));
});

exports.createBill = asyncHandler(async (req, res) => {
  // Over-limit override (Phase 18): a valid step-up approval lets the save proceed past the
  // holding-limit hard block; without one the block behaves exactly as before.
  res.json(await billService.createBill(req.user.id, req.body, stepUpOf(req)));
});

exports.updateBill = asyncHandler(async (req, res) => {
  // Bill-number-only edits stay ungated (the quiet Phase 8 path). Everything else — line
  // items, dates, challan, transfer edits — requires a verified step-up approval (Phase 18).
  const quietKeys = new Set(['bill_number', 'logEdit', 'step_up_token']);
  const isBillNumberOnly = Object.keys(req.body || {}).every(k => quietKeys.has(k));
  let stepUp = stepUpOf(req);
  if (!isBillNumberOnly && !stepUp) {
    stepUp = requireStepUp(req.user.id, null, 'Editing a bill'); // throws 403
  }
  res.json(await billService.updateBill(req.user, req.params.id, req.body, stepUp));
});

exports.deleteBill = asyncHandler(async (req, res) => {
  // Drafts stay freely deletable; real bills require step-up (enforced in the service,
  // which knows whether the target is a draft).
  res.json(await billService.deleteBill(req.user.id, req.params.id, stepUpOf(req)));
});

exports.setDsrRemark = asyncHandler(async (req, res) => {
  res.json(await billService.setDsrRemark(req.user.id, req.params.id, req.body));
});

exports.saveDraft = asyncHandler(async (req, res) => {
  res.json(await billService.saveDraft(req.user.id, req.body));
});

exports.listDrafts = asyncHandler(async (req, res) => {
  res.json(await billService.listDrafts(req.user.id, req.query.location));
});

exports.getTodayStats = asyncHandler(async (req, res) => {
  res.json(await billService.getTodayStats(req.user.id));
});
