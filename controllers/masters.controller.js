const asyncHandler = require('../middleware/asyncHandler');
const mastersService = require('../services/masters.service');
const audit = require('../services/audit.service');

// Every route here is signed-in (routes/masters.js) and works on the caller's own catalog only.
// Mutations are also step-up-gated (Phase 18): req.stepUp is attached by the step-up gate and is
// guaranteed to belong to this same account.
const logChange = (req, detail) => audit.record({
  userId: req.user.id, action: 'MASTERS_CHANGE', target: 'Gas Types & Cylinder Sizes',
  detail, stepUp: req.stepUp
});

exports.listGasTypes = asyncHandler(async (req, res) => {
  res.json(await mastersService.listGasTypes(req.user.id));
});

exports.createGasType = asyncHandler(async (req, res) => {
  const result = await mastersService.createGasType(req.user.id, req.body.gas_type_name);
  await logChange(req, `Added gas type "${req.body.gas_type_name}"`);
  res.json(result);
});

exports.listCylinderSizes = asyncHandler(async (req, res) => {
  res.json(await mastersService.listCylinderSizes(req.user.id));
});

exports.createCylinderSize = asyncHandler(async (req, res) => {
  const result = await mastersService.createCylinderSize(req.user.id, req.body.size_label);
  await logChange(req, `Added cylinder size "${req.body.size_label}"`);
  res.json(result);
});

exports.deleteGasType = asyncHandler(async (req, res) => {
  const result = await mastersService.deleteGasType(req.user.id, req.params.id);
  await logChange(req, `Removed gas type ${req.params.id}`);
  res.json(result);
});

exports.deleteCylinderSize = asyncHandler(async (req, res) => {
  const result = await mastersService.deleteCylinderSize(req.user.id, req.params.id);
  await logChange(req, `Removed cylinder size ${req.params.id}`);
  res.json(result);
});

exports.getGasCapacities = asyncHandler(async (req, res) => {
  res.json(await mastersService.getGasCapacities(req.user.id));
});

exports.addSizeToGas = asyncHandler(async (req, res) => {
  const result = await mastersService.addSizeToGas(req.user.id, req.params.gas, req.body.size_label);
  await logChange(req, `Added size "${req.body.size_label}" to ${req.params.gas}`);
  res.json(result);
});

exports.removeSizeFromGas = asyncHandler(async (req, res) => {
  // Size label arrives as a query param (labels contain spaces/dots, e.g. "7 m3").
  const result = await mastersService.removeSizeFromGas(req.user.id, req.params.gas, req.query.label);
  await logChange(req, `Removed size "${req.query.label}" from ${req.params.gas}`);
  res.json(result);
});
