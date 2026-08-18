// Phase 33 migration: seed exactly ONE "Initial record — migrated to CylinderPro" history
// entry for every existing cylinder, reflecting its CURRENT location/stock_state at migration
// time. No fabricated prior movement — cylinders were imported from an Excel system and have no
// real CylinderPro history before this. Idempotent: a cylinder that already has any history entry
// is skipped, so re-running never double-seeds. All later history accumulates via the app hooks.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const Cylinder = require('../models/Cylinder');
const CylinderHistory = require('../models/CylinderHistory');

(async () => {
  await connectDB();
  const now = new Date();
  let seeded = 0, skipped = 0, total = 0;

  const cursor = Cylinder.find({}, { _id: 1, user_id: 1, rotational_number: 1, location: 1, stock_state: 1 }).lean().cursor();
  for (let c = await cursor.next(); c != null; c = await cursor.next()) {
    total++;
    const exists = await CylinderHistory.exists({ cylinder_id: c._id });
    if (exists) { skipped++; continue; }
    await CylinderHistory.create({
      user_id: c.user_id,
      cylinder_id: c._id,
      rotational_number: c.rotational_number || '',
      event_type: 'MIGRATED',
      description: 'Initial record — migrated to CylinderPro',
      to_location: c.location || '',
      to_state: c.stock_state || '',
      performed_at_location: c.location || '',
      event_at: now
    });
    seeded++;
  }

  console.log(`Phase 33 migration complete. cylinders=${total} seeded=${seeded} skipped(existing history)=${skipped}`);
  await mongoose.connection.close();
  process.exit(0);
})().catch(e => { console.error('Phase 33 migration ERROR', e); process.exit(1); });
