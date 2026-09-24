const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { blockCreateWhileRestoring: noNew, blockChangesWhileRestoring } = require('../middleware/restoreGate');
const ctrl = require('../controllers/fillingLog.controller');

router.use(authMiddleware);
// R162: nothing changes while a restore is writing into this account.
router.use(blockChangesWhileRestoring());

router.get('/', ctrl.listEntries);       // ?date=YYYY-MM-DD
router.post('/', noNew, ctrl.addEntry);
router.put('/', noNew, ctrl.saveDay);           // batch save: { date, entries: [...] } replaces the day
router.delete('/:id', ctrl.deleteEntry);

module.exports = router;
