const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/cylinders.controller');

router.use(authMiddleware);

// NOTE: '/aging-report' and '/in-rotation' MUST stay declared before '/:id',
// or they would be captured as an :id param.
router.get('/aging-report', ctrl.getAgingReport);
router.get('/', ctrl.listCylinders);
router.get('/in-rotation', ctrl.listInRotation);
router.get('/:id', ctrl.getCylinder);
router.post('/', ctrl.createCylinder);
router.post('/import', ctrl.importCylinders);
router.post('/:id/maintenance', ctrl.setMaintenance);
router.put('/:id', ctrl.updateCylinder);
router.delete('/:id', ctrl.deleteCylinder);

module.exports = router;
