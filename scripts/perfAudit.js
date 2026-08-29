// Part 2 audit: what is actually slow NOW, on production-scale data.
//
// Reports only — changes nothing. Three questions:
//   1. Do the hot queries use an index, or scan the collection?
//   2. Which endpoints pull an unbounded result set (no pagination, no cap)?
//   3. Which in-app loops re-read data Mongo could have aggregated?
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const pad = (s, n) => String(s).padEnd(n);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');
  const uid = (await User.findOne().select('_id').lean())._id;

  console.log('=== 1. INDEXES PRESENT ===\n');
  const models = ['Customer', 'Bill', 'Payment', 'Cylinder', 'CylinderHistory'];
  for (const m of models) {
    const Model = require(`../models/${m}`);
    const idx = await Model.collection.indexes();
    const n = await Model.countDocuments({});
    console.log(`${m}  (${n.toLocaleString()} docs)`);
    for (const i of idx) console.log(`    ${pad(i.name, 46)} ${JSON.stringify(i.key)}`);
    console.log('');
  }

  console.log('=== 2. DO THE HOT QUERIES USE AN INDEX? ===\n');
  const Customer = require('../models/Customer');
  const Bill = require('../models/Bill');
  const Payment = require('../models/Payment');
  const Cylinder = require('../models/Cylinder');

  const custIds = (await Customer.find({ user_id: uid }).select('_id').limit(500).lean()).map(c => c._id);

  const probes = [
    ['customer list filter', Customer.find({ customer_type: 'REGULAR', user_id: uid })],
    ['over-limit customer filter', Customer.find({ user_id: uid, customer_type: 'REGULAR', is_active: true, is_filling_vendor: { $ne: true } })],
    ['bills for a batch of customers', Bill.find({ customer_id: { $in: custIds }, user_id: uid })],
    ['payments list (sorted)', Payment.find({ user_id: uid }).sort('-createdAt')],
    ['payments by customer', Payment.find({ customer_id: custIds[0], user_id: uid })],
    ['cylinder list', Cylinder.find({ user_id: uid })]
  ];

  for (const [label, q] of probes) {
    const ex = await q.explain('executionStats');
    const st = ex.executionStats;
    const stage = JSON.stringify(ex.queryPlanner.winningPlan).match(/"stage":"(COLLSCAN|IXSCAN|FETCH)"/g) || [];
    const scan = /COLLSCAN/.test(JSON.stringify(ex.queryPlanner.winningPlan)) ? 'COLLSCAN' : 'index';
    const ratio = st.totalDocsExamined && st.nReturned ? (st.totalDocsExamined / st.nReturned).toFixed(1) : '-';
    console.log(`${pad(label, 34)} ${pad(scan, 10)} examined ${pad(st.totalDocsExamined, 8)} returned ${pad(st.nReturned, 8)} ratio ${pad(ratio, 6)} ${st.executionTimeMillis} ms`);
  }

  console.log('\n=== 3. SORT STAGES DONE IN MEMORY (no index to satisfy them) ===\n');
  const sorts = [
    ['payments -createdAt', Payment.find({ user_id: uid }).sort('-createdAt').limit(50)],
    ['bills -bill_date', Bill.find({ user_id: uid }).sort('-bill_date').limit(50)]
  ];
  for (const [label, q] of sorts) {
    const ex = await q.explain('executionStats');
    const plan = JSON.stringify(ex.queryPlanner.winningPlan);
    const inMemory = /"stage":"SORT"/.test(plan);
    console.log(`${pad(label, 26)} ${inMemory ? 'IN-MEMORY SORT' : 'index-ordered'}   examined ${ex.executionStats.totalDocsExamined}, ${ex.executionStats.executionTimeMillis} ms`);
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
