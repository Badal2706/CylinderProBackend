const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/trusted-people.controller');

router.use(authMiddleware);

// Step-up verification (Phase 17) — reusable approval endpoints for Phase 18's gated actions.
//   OTP : pick a trusted person → code emailed to them → verify that specific request.
//   TOTP: 6-digit authenticator code, checked against EVERY active person's own secret.
// Both return a short-lived step_up_token on success.
router.post('/otp/send', ctrl.stepUpOtpSend);
router.post('/otp/verify', ctrl.stepUpOtpVerify);
router.post('/totp/verify', ctrl.stepUpTotpVerify);

module.exports = router;
