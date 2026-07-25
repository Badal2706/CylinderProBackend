const asyncHandler = require('../middleware/asyncHandler');
const rentalService = require('../services/rental.service');

// GET /api/customers/:id/aging — cylinders this customer currently holds, with days-held.
exports.getCustomerAging = asyncHandler(async (req, res) => {
  res.json(await rentalService.getCustomerAging(req.user.id, req.params.id));
});

// POST /api/customers/:id/rental-summary — generate + persist a rental charge.
exports.generateRentalCharge = asyncHandler(async (req, res) => {
  res.json(await rentalService.generateRentalCharge(req.user.id, req.params.id, req.body));
});

// GET /api/rental-charges/:id — saved charge with customer details (for print).
exports.getRentalCharge = asyncHandler(async (req, res) => {
  res.json(await rentalService.getRentalCharge(req.user.id, req.params.id));
});
