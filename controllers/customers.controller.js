const asyncHandler = require('../middleware/asyncHandler');
const customerService = require('../services/customer.service');

exports.listCustomers = asyncHandler(async (req, res) => {
  res.json(await customerService.listCustomers(req.user.id, req.query));
});

exports.getCustomerDetail = asyncHandler(async (req, res) => {
  res.json(await customerService.getCustomerDetail(req.user.id, req.params.id));
});

exports.createCustomer = asyncHandler(async (req, res) => {
  res.json(await customerService.createCustomer(req.user.id, req.body));
});

exports.importCustomers = asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  res.json(await customerService.importCustomers(req.user.id, rows));
});

exports.updateCustomer = asyncHandler(async (req, res) => {
  res.json(await customerService.updateCustomer(req.user.id, req.params.id, req.body));
});

exports.getGivenTransactions = asyncHandler(async (req, res) => {
  res.json(await customerService.getGivenTransactions(req.user.id, req.params.id, req.query));
});

exports.getReceivedTransactions = asyncHandler(async (req, res) => {
  res.json(await customerService.getReceivedTransactions(req.user.id, req.params.id, req.query));
});

exports.getPersonalCylinderHistory = asyncHandler(async (req, res) => {
  res.json(await customerService.getPersonalCylinderHistory(req.user.id, req.params.id));
});

exports.getCustomerPayments = asyncHandler(async (req, res) => {
  res.json(await customerService.getCustomerPayments(req.user.id, req.params.id, req.query));
});

// Soft delete / restore (Phase 24). Body: { hidden: true|false }.
exports.setCustomerHidden = asyncHandler(async (req, res) => {
  res.json(await customerService.setCustomerHidden(req.user.id, req.params.id, req.body.hidden !== false));
});

// Hard delete with cascade (Phase 24). Requires ?confirm=DELETE so a stray DELETE to this
// route can never wipe a customer's history by accident.
exports.deleteCustomer = asyncHandler(async (req, res) => {
  if (req.query.confirm !== 'DELETE') {
    const HttpError = require('../utils/HttpError');
    throw new HttpError(400, 'Permanent delete requires confirm=DELETE.');
  }
  res.json(await customerService.deleteCustomerCascade(req.user.id, req.params.id));
});

// Per gas+size personal-cylinder balances (Phase 11) — feeds the New Transaction form's
// per-combo PC return caps. Keys: "GasName|SizeLabel" → net count at plant.
exports.getPcBalances = asyncHandler(async (req, res) => {
  const { personalByComboForCustomer } = require('../services/bill.service');
  res.json(await personalByComboForCustomer(req.user.id, req.params.id));
});
