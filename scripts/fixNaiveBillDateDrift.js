// Targeted repair for bills stored +5:30 ahead of their real moment.
//
// Cause: the browser built the Bill Date + time with `new Date('YYYY-MM-DDTHH:MM')`, which some
// browsers (Safari) refuse to parse. The old code then fell back to sending that NAIVE local string,
// and the server stored the IST wall-clock verbatim as UTC — so the bill landed +5:30 in the future.
// Because cylinder state is replayed in bill-date order, those bills sorted after later events and
// parked cylinders at the wrong site.
//
// Repair: shift the drifted bills back by exactly 5:30, which restores the wall-clock the operator
// actually typed (better than clamping to createdAt, which would lose their chosen minute).
// Only bills whose bill_date sits 4.5h-6.5h AFTER their creation instant are touched — a bill can
// never legitimately be recorded hours before it happens, and correct rows (drift ~0), genuinely
// backdated rows (negative drift) and date-only rows (midnight) are all left alone.
// Idempotent: after the shift a row no longer matches the window. DRY=1 previews.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const Bill = require('../models/Bill');

const DRY = process.env.DRY === '1';
const IST_MS = 330 * 60 * 1000;
const LO = 4.5 * 3600000, HI = 6.5 * 3600000;

(async () => {
  await connectDB();
  const bills = await Bill.find({ is_draft: { $ne: true } })
    .select('bill_number bill_date createdAt').lean();

  let fixed = 0, dateOnly = 0, ok = 0, backdated = 0;
  const samples = [];
  for (const b of bills) {
    const bd = new Date(b.bill_date);
    if (bd.getUTCHours() === 0 && bd.getUTCMinutes() === 0 && bd.getUTCSeconds() === 0) { dateOnly++; continue; }
    const drift = bd.getTime() - new Date(b.createdAt).getTime();
    if (drift < LO || drift > HI) { (drift < 0 ? backdated++ : ok++); continue; }
    const corrected = new Date(bd.getTime() - IST_MS);
    if (samples.length < 12) samples.push(`${b.bill_number}: ${bd.toISOString().slice(0, 16)} -> ${corrected.toISOString().slice(0, 16)}  (created ${new Date(b.createdAt).toISOString().slice(0, 16)})`);
    if (!DRY) await Bill.updateOne({ _id: b._id }, { bill_date: corrected });
    fixed++;
  }

  console.log(`${DRY ? '[DRY] ' : ''}repaired=${fixed}  left alone: date-only=${dateOnly} correct=${ok} backdated=${backdated}`);
  samples.forEach(s => console.log('  ' + s));
  console.log(DRY ? '(DRY run — no changes written.)'
    : 'Now run: node scripts/resyncHistoryEventAt.js && node scripts/recomputeCylinderLocation.js');

  await mongoose.connection.close();
  process.exit(0);
})().catch(e => { console.error('DRIFT REPAIR ERROR', e); process.exit(1); });
