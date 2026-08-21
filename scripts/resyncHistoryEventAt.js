// One-time repair: re-sync each per-cylinder history event's `event_at` to the EFFECTIVE time of its
// source bill line — added_at when the cylinder was added to a transfer during an edit (Phase 35),
// else the bill's bill_date. Pre-timezone-fix, some history events were stored with a drifted
// event_at (IST value labelled UTC) that was never corrected when bill_date was repaired, so a
// receive could sort ABOVE the transfer that actually moved the cylinder — contradicting the
// recomputed state. This aligns the history ordering with the state replay. Only RECEIVED/GIVEN/
// TRANSFER events that resolve to a bill are touched; FILLED/MANUAL_EDIT/MIGRATED are left alone.
// Idempotent (skips events already within 1s of the effective time). DRY=1 previews.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const Bill = require('../models/Bill');
const CylinderHistory = require('../models/CylinderHistory');
const { lineEffTime } = require('../services/cylinderState.service');

const DRY = process.env.DRY === '1';
const key = (u, ref) => `${u}|${ref}`;

(async () => {
  await connectDB();

  const bills = await Bill.find({ is_draft: { $ne: true } },
    { user_id: 1, bill_number: 1, bill_date: 1, finalized_at: 1, 'line_items.serial_number': 1, 'line_items.added_at': 1 }).lean();
  const billMap = {};
  for (const b of bills) {
    const addedByRot = {};
    for (const li of (b.line_items || [])) {
      const s = (li.serial_number || '').trim();
      if (s && li.added_at && !addedByRot[s]) addedByRot[s] = li.added_at;
    }
    billMap[key(b.user_id, b.bill_number)] = { bill_date: b.bill_date, addedByRot, billDoc: b };
  }

  const rows = await CylinderHistory.find(
    { event_type: { $in: ['RECEIVED', 'GIVEN', 'TRANSFER'] }, document_ref: { $ne: '' } },
    { user_id: 1, rotational_number: 1, event_type: 1, document_ref: 1, event_at: 1 }
  ).lean();

  let updated = 0, unresolved = 0;
  const samples = [];
  for (const r of rows) {
    const bm = billMap[key(r.user_id, r.document_ref)];
    if (!bm) { unresolved++; continue; }
    const added = bm.addedByRot[(r.rotational_number || '').trim()];
    const eff = added ? new Date(added) : lineEffTime(bm.billDoc, null);
    if (Math.abs(new Date(r.event_at).getTime() - eff.getTime()) <= 1000) continue; // already aligned
    if (samples.length < 12) samples.push(
      `${r.document_ref} cyl ${r.rotational_number} ${r.event_type}: ${new Date(r.event_at).toISOString()} -> ${eff.toISOString()}`);
    if (!DRY) await CylinderHistory.updateOne({ _id: r._id }, { $set: { event_at: eff } });
    updated++;
  }

  console.log(`${DRY ? '[DRY] ' : ''}history events scanned=${rows.length}  re-synced=${updated}  unresolved(no bill)=${unresolved}`);
  samples.forEach(s => console.log('  ' + s));
  if (DRY) console.log('(DRY run — no changes written.)');

  await mongoose.connection.close();
  process.exit(0);
})().catch(e => { console.error('RESYNC event_at ERROR', e); process.exit(1); });
