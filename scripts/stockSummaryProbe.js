// Runs getStockSummary for a date at every location and reports impossible values.
//
// Works against whatever MONGODB_URI is set — so the SAME script can be pointed at the local
// Docker copy and at a read-only production connection, and the two outputs diffed.
//
// Read-only. Never writes.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const DATE = process.env.DATE || '2026-08-26';
const TAG = process.env.TAG || 'local';
const OUT = process.env.OUT || '';

(async () => {
  const uri = process.env.PROBE_URI || process.env.MONGODB_URI;

  // MUST come before connect(). Mongoose builds every model's declared indexes on connection by
  // default — against production that is a WRITE, and the local models carry GEN-C indexes that
  // production has never had. Both are disabled so this script can only ever read.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });

  const User = require('../models/User');
  const reportService = require('../services/report.service');
  const locationService = require('../services/location.service');

  const user = await User.findOne({ email: /gurugases/i }).select('_id email').lean()
            || await User.findOne().select('_id email').lean();
  const { codes, labels } = await locationService.getUserLocations(user._id);

  console.log(`[${TAG}]  db=${mongoose.connection.name}  account=${user.email}  date=${DATE}`);
  console.log(`[${TAG}]  locations: ${codes.join(', ')}\n`);

  const dump = { tag: TAG, date: DATE, account: user.email, locations: {} };
  let negatives = 0;

  for (const loc of codes) {
    const rep = await reportService.getStockSummary(user._id, { date: DATE, location: loc });
    dump.locations[loc] = rep.rows;

    console.log(`── ${labels[loc] || loc} (${loc}) ──`);
    console.log('  ' + 'gas / capacity'.padEnd(26) +
      'F-open'.padStart(8) + 'F-add'.padStart(8) + 'F-iss'.padStart(8) + 'F-close'.padStart(9) +
      'E-open'.padStart(8) + 'E-recv'.padStart(8) + 'E-iss'.padStart(8) + 'E-close'.padStart(9));

    let anyNeg = false;
    for (const r of rep.rows) {
      const f = r.filled, e = r.empty;
      const vals = [f.opening, f.add, f.issue, f.closing, e.opening, e.receive, e.issue, e.closing];
      const neg = vals.some(v => v < 0);
      if (neg) { negatives++; anyNeg = true; }
      console.log('  ' + `${r.gas_type} / ${r.capacity}`.padEnd(26) +
        String(f.opening).padStart(8) + String(f.add).padStart(8) + String(f.issue).padStart(8) + String(f.closing).padStart(9) +
        String(e.opening).padStart(8) + String(e.receive).padStart(8) + String(e.issue).padStart(8) + String(e.closing).padStart(9) +
        (neg ? '   <== NEGATIVE' : ''));
    }
    if (!rep.rows.length) console.log('  (no rows)');
    if (!anyNeg) console.log('  (no negatives here)');
    console.log('');
  }

  console.log(`[${TAG}] TOTAL ROWS WITH A NEGATIVE VALUE: ${negatives}`);
  if (OUT) {
    require('fs').writeFileSync(OUT, JSON.stringify(dump, null, 2));
    console.log(`[${TAG}] written to ${OUT}`);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
