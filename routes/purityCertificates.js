const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const validate = require('../middleware/validate');
const V = require('../validators/schemas');
const ctrl = require('../controllers/purityCertificates.controller');

router.use(authMiddleware);

router.get('/', ctrl.listCertificates);                                        // ?customer_id=…
router.get('/:id', ctrl.getCertificate);
router.post('/', validate(V.purityCertificateCreate), ctrl.createCertificate);
router.delete('/:id', ctrl.deleteCertificate);

// F-11: no PUT and no PATCH. A certificate is immutable once issued — the correction path is
// delete and reissue, exactly as it is for a bill number that was printed wrong.

module.exports = router;
