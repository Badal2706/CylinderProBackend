const asyncHandler = require('../middleware/asyncHandler');
const service = require('../services/purityCertificate.service');

// F-11. There is no update handler here, and there is no route for one — a certificate is
// immutable once issued (models/PurityCertificate.js refuses the write regardless).

exports.listCertificates = asyncHandler(async (req, res) => {
  res.json(await service.listCertificates(req.user.id, { customer_id: req.query.customer_id }));
});

exports.getCertificate = asyncHandler(async (req, res) => {
  res.json(await service.getCertificate(req.user.id, req.params.id));
});

exports.createCertificate = asyncHandler(async (req, res) => {
  res.json(await service.createCertificate(req.user.id, req.body));
});

exports.deleteCertificate = asyncHandler(async (req, res) => {
  res.json(await service.deleteCertificate(req.user.id, req.params.id));
});
