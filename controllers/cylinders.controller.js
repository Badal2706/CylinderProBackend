const asyncHandler = require('../middleware/asyncHandler');
const cylinderService = require('../services/cylinder.service');
const cylinderHistoryService = require('../services/cylinderHistory.service');

exports.getAgingReport = asyncHandler(async (req, res) => {
  // req.query carries the filters plus, when the screen is paging, search/page/limit.
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

exports.getCylinderHistory = asyncHandler(async (req, res) => {
  res.json(await cylinderHistoryService.getHistory(req.user.id, req.params.id));
});

// GEN-C: step-up gated full history, paginated. The gate is the route's middleware, not this
// handler — by the time we get here the approval has already been verified.
exports.getCylinderHistoryPage = asyncHandler(async (req, res) => {
  res.json(await cylinderHistoryService.getHistoryPage(req.user.id, req.params.id, {
    skip: req.query.skip,
    limit: req.query.limit
  }));
});

exports.createCylinder = asyncHandler(async (req, res) => {
  res.json(await cylinderService.createCylinder(req.user.id, req.body));
});

exports.importCylinders = asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  res.json(await cylinderService.importCylinders(req.user.id, rows));
});

exports.setMaintenance = asyncHandler(async (req, res) => {
  // active_location names the site whose manager is recorded as having done this.
  res.json(await cylinderService.setMaintenance(req.user.id, req.params.id, !!req.body.on, req.body.active_location));
});

exports.updateCylinder = asyncHandler(async (req, res) => {
  res.json(await cylinderService.updateCylinder(req.user.id, req.params.id, req.body));
});

exports.deleteCylinder = asyncHandler(async (req, res) => {
  res.json(await cylinderService.deleteCylinder(req.user.id, req.params.id));
});
