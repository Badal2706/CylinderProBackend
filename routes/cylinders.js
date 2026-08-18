const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const validate = require('../middleware/validate');
const V = require('../validators/schemas');
const ctrl = require('../controllers/cylinders.controller');

router.use(authMiddleware);

// NOTE: '/aging-report' and '/in-rotation' MUST stay declared before '/:id',
// or they would be captured as an :id param.
router.get('/aging-report', ctrl.getAgingReport);
router.get('/', ctrl.listCylinders);
router.get('/in-rotation', ctrl.listInRotation);
router.get('/:id/history', ctrl.getCylinderHistory);
router.get('/:id', ctrl.getCylinder);
router.post('/', validate(V.cylinderCreate), ctrl.createCylinder);
router.post('/import', validate(V.importRows), ctrl.importCylinders);
router.post('/:id/maintenance', ctrl.setMaintenance);
router.put('/:id', validate(V.cylinderUpdate), ctrl.updateCylinder);
router.delete('/:id', ctrl.deleteCylinder);

module.exports = router;
