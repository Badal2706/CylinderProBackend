const asyncHandler = require('../middleware/asyncHandler');
const reportService = require('../services/report.service');

exports.getDSR = asyncHandler(async (req, res) => {
  res.json(await reportService.getDSR(req.user.id, req.query));
});

exports.getStockSummary = asyncHandler(async (req, res) => {
  res.json(await reportService.getStockSummary(req.user.id, req.query));
});

exports.getPcStock = asyncHandler(async (req, res) => {
  res.json(await reportService.getPcStock(req.user.id, req.query.location));
});

exports.getLedgerReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getLedgerReport(req.user.id));
});

exports.getOverLimitReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getOverLimitReport(req.user.id));
});

exports.getDailyReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getDailyReport(req.user.id, req.query.date));
});

exports.getCylinderStockReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getCylinderStockReport(req.user.id));
});

exports.getOutstandingReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getOutstandingReport(req.user.id));
});

exports.getDepositsReport = asyncHandler(async (req, res) => {
  res.json(await reportService.getDepositsReport(req.user.id));
});

exports.getCustomerStatement = asyncHandler(async (req, res) => {
  const { start_date, end_date } = req.query;
  res.json(await reportService.getCustomerStatement(req.user.id, req.params.id, start_date, end_date));
});
