const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/auth.controller');

router.post('/signup', ctrl.signup);
router.post('/signin', ctrl.signin);
router.post('/refresh', authMiddleware, ctrl.refresh);
router.post('/clear-data', authMiddleware, ctrl.clearData);

// Sessions & devices (Phase 17)
router.get('/sessions', authMiddleware, ctrl.listSessions);
router.delete('/sessions/:sid', authMiddleware, ctrl.revokeSession);

// Login-email verification + reminder banner status (Phase 17)
router.post('/verify-email/send', authMiddleware, ctrl.sendEmailVerification);
router.post('/verify-email/confirm', authMiddleware, ctrl.confirmEmailVerification);
router.get('/security-status', authMiddleware, ctrl.securityStatus);

module.exports = router;
