const asyncHandler = require('../middleware/asyncHandler');
const dashboardService = require('../services/dashboard.service');

exports.getStats = asyncHandler(async (req, res) => {
  res.json(await dashboardService.getStats(req.user.id));
});

exports.getCylinderStock = asyncHandler(async (req, res) => {
  res.json(await dashboardService.getCylinderStock(req.user.id));
});

exports.getOverLimitCustomers = asyncHandler(async (req, res) => {
  res.json(await dashboardService.getOverLimitCustomers(req.user.id));
});
