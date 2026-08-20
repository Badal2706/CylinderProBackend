// One-time Phase 35 backfill: stamp `added_at` on internal-transfer line items whose cylinder was
// ADDED during a later edit (before added_at existed), AND log the per-cylinder history event for
// that add (before updateInternalTransfer logged one). Reads each transfer's edit_history for
// "Cylinder <n> added" entries and (1) sets that line's added_at to the edit's timestamp, so the
// state replay orders the transfer as of when the cylinder was actually put on it — fixing cylinders
// that bounced back to the source because a receive entered before the edit sorted after the
// transfer; (2) ensures a TRANSFER history event exists for that cylinder+bill (marked "added later
// in an update"), so the transfer shows up in the cylinder's history. Then recomputes the affected
// cylinders. Idempotent (only stamps lines with no added_at; only logs history that's missing).
// DRY=1 previews.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const Bill = require('../models/Bill');
const Cylinder = require('../models/Cylinder');
const CylinderHistory = require('../models/CylinderHistory');
const cylHistory = require('../services/cylinderHistory.service');
const { recomputeCylinderState } = require('../services/cylinderState.service');
const { LOCATION_LABELS } = require('../config/locations');

const DRY = process.env.DRY === '1';

(async () => {
  await connectDB();
  const bills = await Bill.find({ transaction_category: 'INTERNAL_TRANSFER', 'edit_history.0': { $exists: true } }).lean();
  const affectedByUser = {};
  const mgrMaps = {};
  let billsTouched = 0, stamped = 0, historyLogged = 0;
  const samples = [];

  for (const b of bills) {
    // Latest edit that "added" each serial (chronological, so a re-add wins).
    const addedAt = {};
    const edits = [...(b.edit_history || [])].sort((x, y) => new Date(x.edited_at) - new Date(y.edited_at));
    for (const e of edits) for (const ch of (e.changes || [])) {
      const m = /^Cylinder (\S+) added/.exec(ch);
      if (m) addedAt[m[1]] = e.edited_at;
    }
    // Serials that were added via an edit AND are still on the bill's lines.
    const present = [...new Set((b.line_items || [])
      .map(li => (li.serial_number || '').trim())
      .filter(s => s && addedAt[s]))];
    if (!present.length) continue;
    billsTouched++;

    // (1) Stamp added_at where it's still missing (drives the state replay).
    const toSet = present.filter(s => {
      const li = (b.line_items || []).find(l => (l.serial_number || '').trim() === s);
      return li && !li.added_at;
    });
    for (const s of toSet) {
      if (samples.length < 8) samples.push(`${b.bill_number} cyl ${s} -> added_at ${new Date(addedAt[s]).toISOString()}`);
      if (!DRY) await Bill.updateOne(
        { _id: b._id },
        { $set: { 'line_items.$[li].added_at': new Date(addedAt[s]) } },
        { arrayFilters: [{ 'li.serial_number': s, 'li.added_at': null }] }
      );
      (affectedByUser[b.user_id] || (affectedByUser[b.user_id] = new Set())).add(s);
      stamped++;
    }

    // (2) Ensure a TRANSFER history event exists for each added serial on this bill.
    if (!mgrMaps[b.user_id]) mgrMaps[b.user_id] = await cylHistory.getManagerMap(b.user_id);
    const fromLabel = LOCATION_LABELS[b.from_location] || b.from_location;
    const toLabel = LOCATION_LABELS[b.to_location] || b.to_location;
    const cyls = await Cylinder.find({ user_id: b.user_id, rotational_number: { $in: present } }, { _id: 1, rotational_number: 1 }).lean();
    const idByRot = {}; cyls.forEach(c => { idByRot[c.rotational_number] = c._id; });
    const missing = [];
    for (const s of present) {
      const cid = idByRot[s];
      if (!cid) continue;
      const exists = await CylinderHistory.findOne({
        user_id: b.user_id, cylinder_id: cid, event_type: 'TRANSFER', document_ref: b.bill_number
      }).lean();
      if (exists) continue;
      missing.push({
        user_id: b.user_id, cylinder_id: cid, rotational_number: s,
        event_type: 'TRANSFER',
        description: `Transferred from ${fromLabel} to ${toLabel} (added later in an update)`,
        from_location: b.from_location, to_location: b.to_location, from_state: 'IN_STOCK', to_state: 'IN_STOCK',
        document_ref: b.bill_number,
        performed_by: mgrMaps[b.user_id][b.from_location] || '', performed_at_location: b.from_location,
        event_at: new Date(addedAt[s])
      });
    }
    if (missing.length) {
      if (samples.length < 16) missing.forEach(m => samples.push(`  history: ${b.bill_number} cyl ${m.rotational_number} @ ${m.event_at.toISOString()}`));
      if (!DRY) await cylHistory.logEvents(missing);
      historyLogged += missing.length;
    }
  }

  console.log(`${DRY ? '[DRY] ' : ''}transfer bills touched=${billsTouched}  added_at stamped=${stamped}  history events logged=${historyLogged}`);
  samples.forEach(s => console.log('  ' + s));
  if (!DRY) {
    let corrected = 0;
    for (const [u, set] of Object.entries(affectedByUser)) {
      const ch = await recomputeCylinderState(u, [...set]);
      corrected += ch.length;
    }
    console.log('cylinders corrected by recompute:', corrected);
  } else {
    console.log('(DRY run — no changes written.)');
  }
  await mongoose.connection.close();
  process.exit(0);
})().catch(e => { console.error('BACKFILL added_at ERROR', e); process.exit(1); });
