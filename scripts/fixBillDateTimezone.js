// One-time repair for the Phase 34 Bill-Date timezone bug.
//
// Bug: the frontend combined the Bill Date + time into a NAIVE local string ("YYYY-MM-DDTHH:MM",
// no zone). The browser is IST (+5:30) but the droplet runs UTC, so `new Date(naive)` on the server
// stored the IST wall-clock AS UTC — every timed bill ended up +5:30 ahead of its real moment, and
// each Transaction-History edit added another +5:30 (billTimeFrom read it back in IST and re-saved).
// Because the replay orders cylinders by bill_date, drifted/edited bills sorted out of order and
// parked cylinders at the wrong site. The frontend now sends a proper UTC instant (combinedBillDate
// / combineDT → .toISOString()), so this only repairs the already-corrupted rows.
//
// Repair: every timed (non-midnight) bill is NON-BACKDATED (verified: its picked date == its
// creation date in IST), so its true moment is its creation instant → set bill_date = createdAt.
// Date-only pre-Phase-34 bills (midnight UTC) and any genuinely backdated bill (picked date != IST
// creation date) are left untouched. Run recomputeCylinderLocation.js afterwards. DRY=1 to preview.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const Bill = require('../models/Bill');

const DRY = process.env.DRY === '1';
const istDay = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10);

(async () => {
  await connectDB();
  const bills = await Bill.find({ is_draft: { $ne: true } }).select('bill_number bill_date createdAt').lean();
  let fixed = 0, skippedDateOnly = 0, skippedBackdated = 0;
  const samples = [];
  for (const b of bills) {
    const bd = new Date(b.bill_date);
    if (bd.getUTCHours() === 0 && bd.getUTCMinutes() === 0 && bd.getUTCSeconds() === 0) { skippedDateOnly++; continue; }
    const pickedDay = bd.toISOString().slice(0, 10);      // the calendar date the user picked
    if (pickedDay !== istDay(b.createdAt)) { skippedBackdated++; continue; } // genuinely backdated — leave it
    if (samples.length < 6) samples.push(`${b.bill_number}: ${bd.toISOString()} -> ${new Date(b.createdAt).toISOString()}`);
    if (!DRY) await Bill.updateOne({ _id: b._id }, { bill_date: new Date(b.createdAt) });
    fixed++;
  }
  console.log(`${DRY ? '[DRY] ' : ''}repaired=${fixed}  skipped(date-only pre-P34)=${skippedDateOnly}  skipped(backdated)=${skippedBackdated}`);
  samples.forEach(s => console.log('  ' + s));
  if (DRY) console.log('(DRY run — no changes written.)');
  await mongoose.connection.close();
  process.exit(0);
})().catch(e => { console.error('REPAIR ERROR', e); process.exit(1); });
