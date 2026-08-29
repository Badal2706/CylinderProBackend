// Why does the Stock Summary produce negative opening/closing figures?
//
// getStockSummary derives a past day BACKWARDS from today:
//     closing(day) = anchor(today) - (movements after the day)
//     opening(day) = closing(day) - (movements on the day)
//
// The anchor is split filled/empty using each cylinder's LATEST event EVER (`lastEvt`), i.e. its
// state RIGHT NOW — but the movements being wound back are day-specific. If a cylinder's
// filled/empty classification changed after the report date (a refill is the common case), it sits
// in the wrong pool of the anchor, so winding back overdraws that pool and it goes negative.
//
// The signature is unmistakable: filled and empty are wrong by the SAME amount in opposite
// directions. This script measures that directly. Read-only.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const DATE = process.env.DATE || '2026-08-26';

(async () => {
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.PROBE_URI || process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });

  const User = require('../models/User');
  const Cylinder = require('../models/Cylinder');
  const FillingLogEntry = require('../models/FillingLogEntry');
  const reportService = require('../services/report.service');

  const user = await User.findOne({ email: /gurugases/i }).select('_id').lean() || await User.findOne().select('_id').lean();
  const uid = user._id;
  const LOC = 'AT_PLANT_CHANDISAR';

  const rep = await reportService.getStockSummary(uid, { date: DATE, location: LOC });
  const bad = rep.rows.filter(r => [r.filled.opening, r.filled.closing, r.empty.opening, r.empty.closing].some(v => v < 0));

  console.log(`Stock Summary ${DATE} @ ${rep.location_label} — ${bad.length} row(s) with a negative\n`);

  // How many cylinders were REFILLED after the report day? Each such fill flips a cylinder from
  // empty to filled in today's classification, which is exactly what corrupts the anchor split.
  const fillsAfter = await FillingLogEntry.find({ user_id: uid, date: { $gt: DATE } })
    .select('gas_type capacity rotational_number date').lean();
  const byCombo = {};
  for (const f of fillsAfter) {
    const k = `${f.gas_type} / ${f.capacity}`;
    (byCombo[k] = byCombo[k] || new Set()).add(f.rotational_number);
  }

  for (const r of bad) {
    const k = `${r.gas_type} / ${r.capacity}`;
    console.log(`── ${k} ──`);
    console.log(`   filled  opening ${r.filled.opening}   add ${r.filled.add}   issue ${r.filled.issue}   closing ${r.filled.closing}`);
    console.log(`   empty   opening ${r.empty.opening}   recv ${r.empty.receive}   issue ${r.empty.issue}   closing ${r.empty.closing}`);

    // Arithmetic proof that the report is internally consistent — the inputs are what is wrong.
    const fOK = r.filled.opening + r.filled.add - r.filled.issue === r.filled.closing;
    const eOK = r.empty.opening + r.empty.receive - r.empty.issue === r.empty.closing;
    console.log(`   ledger arithmetic balances:  filled ${fOK ? 'yes' : 'NO'}, empty ${eOK ? 'yes' : 'NO'}`);

    const refilled = byCombo[k] ? byCombo[k].size : 0;
    console.log(`   cylinders of this type REFILLED after ${DATE}: ${refilled}`);
    console.log(`   -> each of those is classified FILLED today, so it sits in the filled anchor`);
    console.log(`      even though on ${DATE} it was empty. That is the pool that goes negative.\n`);
  }

  // The combined pool is the honest number: filled+empty together cannot be misclassified.
  console.log('Combined (filled + empty) — misclassification cancels out here:\n');
  console.log('  ' + 'gas / capacity'.padEnd(26) + 'opening'.padStart(9) + 'closing'.padStart(9) + '   negative?');
  let anyCombinedNeg = false;
  for (const r of rep.rows) {
    const o = r.filled.opening + r.empty.opening;
    const c = r.filled.closing + r.empty.closing;
    if (o < 0 || c < 0) anyCombinedNeg = true;
    console.log('  ' + `${r.gas_type} / ${r.capacity}`.padEnd(26) + String(o).padStart(9) + String(c).padStart(9) +
      ((o < 0 || c < 0) ? '   <== still negative' : ''));
  }
  console.log('\n' + (anyCombinedNeg
    ? 'Some combined totals are STILL negative — there is a second cause beyond misclassification.'
    : 'No combined total is negative => the ONLY defect is the filled/empty split of the anchor.'));

  // Total physical stock at the site right now, as a sanity anchor.
  const inStock = await Cylinder.countDocuments({ user_id: uid, location: LOC, stock_state: 'IN_STOCK' });
  const sumClosing = rep.rows.reduce((s, r) => s + r.filled.closing + r.empty.closing, 0);
  console.log(`\nphysical in-stock at ${LOC} right now : ${inStock}`);
  console.log(`sum of all closing figures for ${DATE}  : ${sumClosing}`);

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
