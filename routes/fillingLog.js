const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const ctrl = require('../controllers/fillingLog.controller');

router.use(authMiddleware);

router.get('/', ctrl.listEntries);       // ?date=YYYY-MM-DD
router.post('/', ctrl.addEntry);
router.put('/', ctrl.saveDay);           // batch save: { date, entries: [...] } replaces the day
router.delete('/:id', ctrl.deleteEntry);

module.exports = router;
