const asyncHandler = require('../middleware/asyncHandler');
const cylinderService = require('../services/cylinder.service');

exports.getAgingReport = asyncHandler(async (req, res) => {
  res.json(await cylinderService.getAgingReport(req.user.id, req.query));
});

exports.listCylinders = asyncHandler(async (req, res) => {
  res.json(await cylinderService.listCylinders(req.user.id, req.query));
});

exports.listInRotation = asyncHandler(async (req, res) => {
  res.json(await cylinderService.listInRotation(req.user.id));
});

exports.getCylinder = asyncHandler(async (req, res) => {
  res.json(await cylinderService.getCylinder(req.user.id, req.params.id));
});

exports.createCylinder = asyncHandler(async (req, res) => {
  res.json(await cylinderService.createCylinder(req.user.id, req.body));
});

exports.importCylinders = asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  res.json(await cylinderService.importCylinders(req.user.id, rows));
});

exports.setMaintenance = asyncHandler(async (req, res) => {
  res.json(await cylinderService.setMaintenance(req.user.id, req.params.id, !!req.body.on));
});

exports.updateCylinder = asyncHandler(async (req, res) => {
  res.json(await cylinderService.updateCylinder(req.user.id, req.params.id, req.body));
});

exports.deleteCylinder = asyncHandler(async (req, res) => {
  res.json(await cylinderService.deleteCylinder(req.user.id, req.params.id));
});
