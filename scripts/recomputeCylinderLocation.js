// Full-scan recompute of EVERY cylinder's location + stock_state from its bill history, in
// effective-time order (line.added_at when set — Phase 35, else bill_date — Phase 34). This is the
// one-off/maintenance counterpart to the per-serial recompute that runs automatically after every
// bill create/edit/delete (services/cylinderState.service.js). Both share replaySerial, so a full
// scan and the inline recompute can never diverge. Run with DRY=1 to only report (no writes).
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const Bill = require('../models/Bill');
const Cylinder = require('../models/Cylinder');
const { replaySerial } = require('../services/cylinderState.service');
const { LOCATION_LABELS } = require('../config/locations');

const DRY = process.env.DRY === '1';

(async () => {
  await connectDB();

  const cyls = await Cylinder.find({}, { rotational_number: 1, user_id: 1, location: 1, stock_state: 1 }).lean();
  const bills = await Bill.find({ is_draft: { $ne: true } }, { user_id: 1, bill_number: 1, bill_date: 1, createdAt: 1, transaction_category: 1, location: 1, to_location: 1, line_items: 1 }).lean();

  // Index bills by `${user}|${serial}`.
  const key = (u, r) => `${u}|${r}`;
  const bySerial = {};
  for (const b of bills) {
    const seen = new Set();
    for (const li of (b.line_items || [])) {
      const s = (li.serial_number || '').trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      (bySerial[key(b.user_id, s)] || (bySerial[key(b.user_id, s)] = [])).push(b);
    }
  }

  const mismatches = [];
  for (const c of cyls) {
    const sbills = bySerial[key(c.user_id, c.rotational_number)] || [];
    if (!sbills.length) continue; // never on a bill → leave as-is
    const { state: t } = replaySerial(sbills, c.rotational_number, { location: c.location, stock_state: c.stock_state });
    if (c.location !== t.location || c.stock_state !== t.stock_state) {
      mismatches.push({ id: c._id, rot: c.rotational_number,
        from: `${LOCATION_LABELS[c.location] || c.location} / ${c.stock_state}`,
        to: `${LOCATION_LABELS[t.location] || t.location} / ${t.stock_state}`,
        loc: t.location, st: t.stock_state });
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
