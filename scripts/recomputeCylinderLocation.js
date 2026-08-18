// Full-scan recompute of EVERY cylinder's location + stock_state from its bill history, in
// transaction date+time order. This is the one-off/maintenance counterpart to the per-serial
// recompute that now runs automatically after every bill create/edit/delete (Phase 34,
// services/cylinderState.service.js). Both share the exact same replay semantics (applyBill),
// so a full scan and the inline recompute can never diverge.
//
// Run with DRY=1 to only report mismatches (no writes).
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const Bill = require('../models/Bill');
const Cylinder = require('../models/Cylinder');
const { applyBill } = require('../services/cylinderState.service');
const { LOCATION_LABELS } = require('../config/locations');

const DRY = process.env.DRY === '1';

(async () => {
  await connectDB();

  const cyls = await Cylinder.find({}, { rotational_number: 1, user_id: 1, location: 1, stock_state: 1 }).lean();
  // Per user: rot -> { state, cyl }. Seed state from the current doc (transfer-only cylinders keep it).
  const byUser = {};
  cyls.forEach(c => {
    const u = String(c.user_id);
    (byUser[u] || (byUser[u] = { state: {}, has: new Set(), cyl: {} }));
    byUser[u].state[c.rotational_number] = { location: c.location, stock_state: c.stock_state };
    byUser[u].has.add(c.rotational_number);
    byUser[u].cyl[c.rotational_number] = c;
  });

  const bills = await Bill.find({ is_draft: { $ne: true } }).sort({ bill_date: 1, createdAt: 1 }).lean();
  for (const b of bills) {
    const u = byUser[String(b.user_id)];
    if (!u) continue;
    applyBill(b, u.state, r => u.has.has(r));
  }

  const mismatches = [];
  for (const u of Object.keys(byUser)) {
    const { state, cyl } = byUser[u];
    for (const rot of Object.keys(cyl)) {
      const c = cyl[rot], t = state[rot];
      if (t && (c.location !== t.location || c.stock_state !== t.stock_state)) {
        mismatches.push({ id: c._id, rot,
          from: `${LOCATION_LABELS[c.location] || c.location} / ${c.stock_state}`,
          to: `${LOCATION_LABELS[t.location] || t.location} / ${t.stock_state}`,
          loc: t.location, st: t.stock_state });
      }
    }
  }
  mismatches.sort((a, b) => String(a.rot).localeCompare(String(b.rot), undefined, { numeric: true }));

  console.log(`Cylinders: ${cyls.length}   Mismatches vs stored inventory: ${mismatches.length}\n`);
  mismatches.forEach(m => console.log(`  ${String(m.rot).padEnd(8)} stored: ${m.from.padEnd(34)} ->  correct: ${m.to}`));

  if (!DRY && mismatches.length) {
    for (const m of mismatches) await Cylinder.updateOne({ _id: m.id }, { location: m.loc, stock_state: m.st });
    console.log(`\nApplied ${mismatches.length} correction(s).`);
  } else if (DRY) {
    console.log('\n(DRY run — no changes written.)');
  } else {
    console.log('\nNothing to correct.');
  }

  await mongoose.connection.close();
  process.exit(0);
})().catch(e => { console.error('RECOMPUTE ERROR', e); process.exit(1); });
