// Re-baselines API response times against the real production-copy dataset, and checks the
// Payments API contract the converted UI depends on.
//
// Measures over HTTP against a running server (not by calling services directly), because that is
// what the browser actually waits for: routing, auth, serialisation and compression included.
//
// Each endpoint is hit once to warm caches and connections, then N times; the report gives the
// median and the worst case. Cold-start numbers alone are misleading — a first query pays for
// index loading that a real user in a live session has usually already paid.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const BASE = process.env.PERF_BASE || 'http://127.0.0.1:3001';
const RUNS = Number(process.env.PERF_RUNS) || 5;

const ms = (n) => `${n.toFixed(0)} ms`;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function timeIt(url, token) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.text();
  const t1 = process.hrtime.bigint();
  return { msec: Number(t1 - t0) / 1e6, status: res.status, bytes: body.length, body };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');
  const user = await User.findOne().select('_id email token_version').lean();
  // A token with no `sid` is valid while `tv` matches — lets this script skip the OTP flow.
  const token = jwt.sign({ id: String(user._id), tv: user.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '20m' });

  const counts = {
    customers: await require('../models/Customer').countDocuments({}),
    bills: await require('../models/Bill').countDocuments({}),
    cylinders: await require('../models/Cylinder').countDocuments({}),
    payments: await require('../models/Payment').countDocuments({}),
    history: await require('../models/CylinderHistory').countDocuments({})
  };
  await mongoose.disconnect();

  console.log(`account : ${user.email}`);
  console.log(`data    : ${counts.customers} customers, ${counts.bills} bills, ${counts.cylinders} cylinders, ` +
              `${counts.payments} payments, ${counts.history} history rows`);
  console.log(`method  : 1 warm-up + ${RUNS} timed runs per endpoint, over HTTP\n`);

  const ENDPOINTS = [
    ['/api/customers?page=1&limit=50', 'customers, first batch (what the page loads)'],
    ['/api/customers?page=1&limit=200', 'customers, background batch size'],
    ['/api/dashboard/over-limit', 'dashboard: over-limit customers'],
    ['/api/dashboard/cylinder-stock', 'dashboard: cylinder stock'],
    ['/api/payments?page=1&limit=50', 'payments, first batch'],
    ['/api/payments?page=1&limit=50&search=SHREE', 'payments, server-side search'],
    ['/api/cylinders?page=1&limit=50', 'cylinders, first batch'],
    ['/api/bills?page=1&limit=50', 'transactions, first batch']
  ];

  const rows = [];
  for (const [pathname, label] of ENDPOINTS) {
    const url = BASE + pathname;
    const warm = await timeIt(url, token);
    if (warm.status !== 200) {
      console.log(`  SKIP  ${label}  -> HTTP ${warm.status}`);
      continue;
    }
    const times = [];
    for (let i = 0; i < RUNS; i++) times.push((await timeIt(url, token)).msec);
    rows.push({ label, pathname, cold: warm.msec, med: median(times), max: Math.max(...times), bytes: warm.bytes });
  }

  console.log('endpoint'.padEnd(46) + 'cold'.padStart(10) + 'median'.padStart(10) + 'worst'.padStart(10) + 'size'.padStart(11));
  console.log('-'.repeat(87));
  for (const r of rows) {
    console.log(r.label.padEnd(46) + ms(r.cold).padStart(10) + ms(r.med).padStart(10) +
                ms(r.max).padStart(10) + `${(r.bytes / 1024).toFixed(0)} KB`.padStart(11));
  }

  // ── The Payments API contract the converted UI relies on ──
  console.log('\npayments API contract:');
  const checks = [];
  const ck = (l, ok, d) => { checks.push(!!ok); console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${l}${d ? '   -> ' + d : ''}`); };

  const p1 = JSON.parse((await timeIt(`${BASE}/api/payments?page=1&limit=10`, token)).body);
  ck('returns { data, pagination } as useBatchList expects',
    Array.isArray(p1.data) && p1.pagination && typeof p1.pagination.total === 'number',
    `total=${p1.pagination && p1.pagination.total}`);
  ck('honours limit', p1.data.length <= 10, `${p1.data.length} rows`);

  const stamps = p1.data.map(p => new Date(p.createdAt).getTime());
  ck('newest-entered first (-createdAt)', stamps.every((t, i) => i === 0 || stamps[i - 1] >= t),
    p1.data.slice(0, 3).map(p => p.receipt_number).join(', '));

  const p2 = JSON.parse((await timeIt(`${BASE}/api/payments?page=2&limit=10`, token)).body);
  const overlap = p1.data.filter(a => p2.data.some(b => b._id === a._id));
  ck('page 2 does not repeat page 1', overlap.length === 0, `${overlap.length} repeated`);

  const term = (p1.data[0] && p1.data[0].receipt_number) || '';
  const s1 = JSON.parse((await timeIt(`${BASE}/api/payments?page=1&limit=50&search=${encodeURIComponent(term)}`, token)).body);
  ck(`server-side search finds "${term}" across the whole ledger`,
    s1.data.length >= 1 && s1.data.some(p => p.receipt_number === term), `${s1.pagination.total} match`);

  const none = JSON.parse((await timeIt(`${BASE}/api/payments?page=1&limit=50&search=zzz-no-such-receipt`, token)).body);
  ck('a search that matches nothing returns nothing', none.pagination.total === 0, `${none.pagination.total} rows`);

  console.log('\n' + (checks.every(Boolean) ? `payments API: all ${checks.length} checks passed`
                                            : `payments API: ${checks.filter(x => !x).length} FAILED`));
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
