// Backfill `finalized_at` for save-for-later bills that were COMMITTED after their bill date.
//
// A draft is written up front and completed later — often after other entries have already been
// made — and that commit is when it really takes effect. Nothing recorded which bills were drafts
// (draft_payload is cleared on commit), so they are identified by their timestamps:
//
//   · bill_date carries a real time-of-day  — date-only bills (midnight UTC) are NOT drafts, they
//     are pre-Phase-34 entries whose date was never given a time; shifting them would re-order
//     nearly every old bill.
//   · bill_date is at least a minute BEFORE createdAt — the document already existed when its own
//     stated time passed, which is exactly what saving for later looks like. A bill saved outright
//     has bill_date == createdAt.
//   · updatedAt is at least a minute after createdAt — it was finished later.
//   · no edit_history — an edited bill's updatedAt is its edit, not its commit.
//   · same IST day — a deliberately backdated draft keeps its chosen date.
//
// Bills touched by a migration script (which bumps updatedAt) are excluded by the bill_date test.
// Only sets the field; run recomputeCylinderLocation.js afterwards to apply the new order. DRY=1.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const Bill = require('../models/Bill');

const DRY = process.env.DRY === '1';
const istDay = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10);
const MIN = 60 * 1000;

(async () => {
  await connectDB();
  const bills = await Bill.find({ is_draft: { $ne: true }, finalized_at: null },
    { bill_number: 1, bill_date: 1, createdAt: 1, updatedAt: 1, edit_history: 1, transaction_category: 1, line_items: 1 }).lean();

  let set = 0;
  const samples = [];
  for (const b of bills) {
    const bd = new Date(b.bill_date), cr = new Date(b.createdAt), up = new Date(b.updatedAt);
    const dateOnly = bd.getUTCHours() === 0 && bd.getUTCMinutes() === 0 && bd.getUTCSeconds() === 0;
    if (dateOnly) continue;
    if ((b.edit_history || []).length) continue;
    if (cr - bd < MIN) continue;          // saved outright, not a draft
    if (up - cr < MIN) continue;          // never committed later
    if (istDay(up) !== istDay(bd)) continue; // deliberately backdated — keep its date

    const cyl = (b.line_items || []).filter(l => l.serial_number).length;
    samples.push(`${String(b.bill_number).padEnd(9)}${(b.transaction_category || 'CUSTOMER').padEnd(18)} bill ${bd.toISOString().slice(11, 16)} → committed ${up.toISOString().slice(11, 16)} UTC  (${cyl} cyl)`);
    if (!DRY) await Bill.updateOne({ _id: b._id }, { $set: { finalized_at: up } });
    set++;
  }

  console.log(`${DRY ? '[DRY] ' : ''}bills stamped finalized_at: ${set}`);
  samples.forEach(s => console.log('  ' + s));
  console.log(DRY ? '(DRY run — no changes written.)'
    : 'Now run: node scripts/recomputeCylinderLocation.js && node scripts/resyncHistoryEventAt.js');

  await mongoose.connection.close();
  process.exit(0);
})().catch(e => { console.error('FINALIZED_AT BACKFILL ERROR', e); process.exit(1); });
