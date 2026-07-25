const asyncHandler = require('../middleware/asyncHandler');
const mastersService = require('../services/masters.service');
const audit = require('../services/audit.service');

// Mutations are step-up-gated (Phase 18) — req.stepUp is attached by requireStepUpAny and
// carries the approving user's id in stepUp.id (masters routes have no session auth).
const logChange = (req, detail) => audit.record({
  userId: req.stepUp.id, action: 'MASTERS_CHANGE', target: 'Gas Types & Cylinder Sizes',
  detail, stepUp: req.stepUp
});

exports.listGasTypes = asyncHandler(async (req, res) => {
  res.json(await mastersService.listGasTypes());
});

exports.createGasType = asyncHandler(async (req, res) => {
  const result = await mastersService.createGasType(req.body.gas_type_name);
  await logChange(req, `Added gas type "${req.body.gas_type_name}"`);
  res.json(result);
});

exports.listCylinderSizes = asyncHandler(async (req, res) => {
  res.json(await mastersService.listCylinderSizes());
});

exports.createCylinderSize = asyncHandler(async (req, res) => {
  const result = await mastersService.createCylinderSize(req.body.size_label);
  await logChange(req, `Added cylinder size "${req.body.size_label}"`);
  res.json(result);
});

exports.deleteGasType = asyncHandler(async (req, res) => {
  const result = await mastersService.deleteGasType(req.params.id);
  await logChange(req, `Removed gas type ${req.params.id}`);
  res.json(result);
});

exports.deleteCylinderSize = asyncHandler(async (req, res) => {
  const result = await mastersService.deleteCylinderSize(req.params.id);
  await logChange(req, `Removed cylinder size ${req.params.id}`);
  res.json(result);
});

exports.getGasCapacities = asyncHandler(async (req, res) => {
  res.json(await mastersService.getGasCapacities());
});

exports.addSizeToGas = asyncHandler(async (req, res) => {
  const result = await mastersService.addSizeToGas(req.params.gas, req.body.size_label);
  await logChange(req, `Added size "${req.body.size_label}" to ${req.params.gas}`);
  res.json(result);
});

exports.removeSizeFromGas = asyncHandler(async (req, res) => {
  // Size label arrives as a query param (labels contain spaces/dots, e.g. "7 m3").
  const result = await mastersService.removeSizeFromGas(req.params.gas, req.query.label);
  await logChange(req, `Removed size "${req.query.label}" from ${req.params.gas}`);
  res.json(result);
});
