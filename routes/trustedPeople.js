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

module.exports = router;
