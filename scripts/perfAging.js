// Focused re-measure of the two endpoints the unbounded sweep flagged, with warm-up, so a
// cold-start artifact cannot be mistaken for a real hotspot. Reports only.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const BASE = process.env.PERF_BASE || 'http://127.0.0.1:3001';
const RUNS = 7;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');
  const Customer = require('../models/Customer');
  const Bill = require('../models/Bill');
  const u = await User.findOne().select('_id token_version').lean();
  const token = jwt.sign({ id: String(u._id), tv: u.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '20m' });

  // Sample several customers, not just one — per-customer cost may vary with bill count.
  const busy = await Bill.aggregate([
    { $match: { user_id: u._id, customer_id: { $ne: null } } },
    { $group: { _id: '$customer_id', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 5 }
  ]);
  const names = {};
  for (const b of busy) {
    const c = await Customer.findById(b._id).select('company_name').lean();
    names[String(b._id)] = c ? c.company_name : '?';
  }
  await mongoose.disconnect();

  const hit = async (url) => {
    const t0 = process.hrtime.bigint();
    const r = await fetch(BASE + url, { headers: { Authorization: `Bearer ${token}` } });
    const b = await r.text();
    return { msec: Number(process.hrtime.bigint() - t0) / 1e6, bytes: b.length, status: r.status };
  };

  console.log('per-customer aging  (/api/customers/:id/aging), warmed up\n');
  console.log('customer'.padEnd(32) + 'bills'.padStart(7) + 'cold'.padStart(10) + 'median'.padStart(10) + 'worst'.padStart(10));
  console.log('-'.repeat(69));
  for (const b of busy) {
    const url = `/api/customers/${b._id}/aging`;
    const cold = await hit(url);
    const ts = [];
    for (let i = 0; i < RUNS; i++) ts.push((await hit(url)).msec);
    console.log(names[String(b._id)].slice(0, 30).padEnd(32) + String(b.n).padStart(7) +
      `${cold.msec.toFixed(0)} ms`.padStart(10) + `${median(ts).toFixed(0)} ms`.padStart(10) +
      `${Math.max(...ts).toFixed(0)} ms`.padStart(10));
  }

  console.log('\nin-rotation  (/api/cylinders/in-rotation), warmed up');
  await hit('/api/cylinders/in-rotation');
  const ts = [];
  let last;
  for (let i = 0; i < RUNS; i++) { last = await hit('/api/cylinders/in-rotation'); ts.push(last.msec); }
  console.log(`  median ${median(ts).toFixed(0)} ms, worst ${Math.max(...ts).toFixed(0)} ms, ${(last.bytes / 1024).toFixed(0)} KB per call`);
})().catch(e => { console.error(e); process.exit(1); });
