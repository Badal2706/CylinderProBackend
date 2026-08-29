// Times the endpoints that return an UNBOUNDED result set — no page, no limit, no cap.
// These are fine at today's volume; the question is which ones grow without a ceiling.
// Reports only.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const BASE = process.env.PERF_BASE || 'http://127.0.0.1:3001';

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');
  const Customer = require('../models/Customer');
  const u = await User.findOne().select('_id token_version').lean();
  const token = jwt.sign({ id: String(u._id), tv: u.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '20m' });

  // The customer with the most bills — the worst realistic case for per-customer endpoints.
  const Bill = require('../models/Bill');
  const top = await Bill.aggregate([
    { $match: { user_id: u._id, customer_id: { $ne: null } } },
    { $group: { _id: '$customer_id', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 1 }
  ]);
  const busiest = top[0] ? top[0]._id : (await Customer.findOne({ user_id: u._id }).select('_id').lean())._id;
  const busiestName = (await Customer.findById(busiest).select('company_name').lean() || {}).company_name;
  const today = new Date().toISOString().slice(0, 10);
  await mongoose.disconnect();

  console.log(`busiest customer: ${busiestName} (${top[0] ? top[0].n : '?'} bills)\n`);

  const URLS = [
    ['/api/cylinders/in-rotation', 'cylinders currently out'],
    ['/api/reports/outstanding', 'outstanding report (all customers)'],
    ['/api/reports/aging-report', 'cylinder aging report'],
    ['/api/reports/stock-summary', 'stock summary'],
    ['/api/reports/ledger', 'ledger'],
    [`/api/reports/dsr?date=${today}`, 'DSR (today)'],
    [`/api/reports/customer-statement/${busiest}`, 'customer statement (busiest)'],
    [`/api/customers/${busiest}/transactions/given`, 'given transactions (busiest)'],
    [`/api/customers/${busiest}/transactions/received`, 'received transactions (busiest)'],
    [`/api/customers/${busiest}/aging`, 'per-customer aging'],
    ['/api/bills/drafts', 'draft bills'],
    ['/api/profile/audit-log', 'audit log']
  ];

  console.log(pad('endpoint', 44) + 'status'.padStart(8) + 'time'.padStart(10) + 'size'.padStart(12) + '  rows');
  console.log('-'.repeat(88));
  for (const [url, label] of URLS) {
    const t0 = process.hrtime.bigint();
    let res, body;
    try {
      res = await fetch(BASE + url, { headers: { Authorization: `Bearer ${token}` } });
      body = await res.text();
    } catch (e) {
      console.log(pad(label, 44) + 'ERR'.padStart(8) + `  ${e.message}`);
      continue;
    }
    const msec = Number(process.hrtime.bigint() - t0) / 1e6;
    let rows = '-';
    try {
      const j = JSON.parse(body);
      rows = Array.isArray(j) ? j.length : (Array.isArray(j.data) ? j.data.length : '-');
    } catch { /* not json */ }
    console.log(pad(label, 44) + String(res.status).padStart(8) + `${msec.toFixed(0)} ms`.padStart(10) +
                `${(body.length / 1024).toFixed(0)} KB`.padStart(12) + `  ${rows}`);
  }
})().catch(e => { console.error(e); process.exit(1); });

function pad(s, n) { return String(s).padEnd(n); }
