const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/trusted-people.controller');

router.use(authMiddleware);

// Trusted People CRUD (Phase 17). Adding sends an email OTP; the person activates on
// verification. Edit/remove will be step-up-gated in Phase 18.
router.get('/', ctrl.list);
router.post('/', ctrl.add);
router.post('/:id/resend-otp', ctrl.resendOtp);
router.post('/:id/verify-email', ctrl.verifyEmail);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);
router.post('/:id/totp/enroll', ctrl.totpEnroll);
router.post('/:id/totp/confirm', ctrl.totpConfirm);
// Phase 25: confirm/cancel an authenticator rotation started by an account email change.
// Deliberately NOT step-up gated — the user has just changed their email and may not have a
// working second approver; requiring step-up here could strand them mid-rotation. Safe because
// confirming needs a valid code from the new QR, and cancelling only discards the pending secret.
router.post('/:id/totp/rotation/begin', ctrl.totpRotationBegin);   // re-scan on demand
router.post('/:id/totp/rotation/confirm', ctrl.totpRotationConfirm);
router.post('/:id/totp/rotation/cancel', ctrl.totpRotationCancel);

module.exports = router;
