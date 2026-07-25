const asyncHandler = require('../middleware/asyncHandler');
const fillingLogService = require('../services/fillingLog.service');

exports.addEntry = asyncHandler(async (req, res) => {
  res.json(await fillingLogService.addEntry(req.user.id, req.body));
});

exports.listEntries = asyncHandler(async (req, res) => {
  res.json(await fillingLogService.listEntries(req.user.id, req.query.date));
});

exports.deleteEntry = asyncHandler(async (req, res) => {
  res.json(await fillingLogService.deleteEntry(req.user.id, req.params.id));
});

exports.saveDay = asyncHandler(async (req, res) => {
  res.json(await fillingLogService.saveDay(req.user.id, req.body));
});
