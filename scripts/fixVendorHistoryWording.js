// One-time wording repair for filling-vendor history lines.
//
// With a filling vendor the flow is inverted: we send cylinders EMPTY to be filled and get them
// back FILLED. The log was written with the normal-customer wording ("Given filled to …" /
// "Received empty from …"), so every vendor line read backwards. New bills are written correctly;
// this rewrites the rows already stored. Only the description text changes — no state, no times.
// Idempotent (rows already reworded are skipped). DRY=1 previews.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const CylinderHistory = require('../models/CylinderHistory');
const Customer = require('../models/Customer');

const DRY = process.env.DRY === '1';

(async () => {
  await connectDB();

  const vendors = await Customer.find({ is_filling_vendor: true }, { company_name: 1, user_id: 1 }).lean();
  if (!vendors.length) { console.log('No filling vendors configured — nothing to do.'); await mongoose.connection.close(); process.exit(0); }
  console.log('Filling vendors:', vendors.map(v => v.company_name).join(', '));

  let fixed = 0;
  const samples = [];
  for (const v of vendors) {
    const rows = await CylinderHistory.find({
      user_id: v.user_id, customer_name: v.company_name, event_type: { $in: ['GIVEN', 'RECEIVED'] }
    }).lean();

    for (const r of rows) {
      const d = r.description || '';
      let next = null;
      if (r.event_type === 'GIVEN' && /^Given filled to /.test(d)) {
        next = d.replace(/^Given filled to /, 'Given empty to ').replace(/ at /, ' for filling at ');
      } else if (r.event_type === 'RECEIVED' && /^Received empty from /.test(d)) {
        next = d.replace(/^Received empty from /, 'Received filled from ');
      }
      if (!next || next === d) continue;
      if (samples.length < 8) samples.push(`${r.rotational_number}: "${d}" -> "${next}"`);
      if (!DRY) await CylinderHistory.updateOne({ _id: r._id }, { $set: { description: next } });
      fixed++;
    }
  }

  console.log(`${DRY ? '[DRY] ' : ''}vendor history lines reworded: ${fixed}`);
  samples.forEach(s => console.log('  ' + s));
  if (DRY) console.log('(DRY run — no changes written.)');

  await mongoose.connection.close();
  process.exit(0);
})().catch(e => { console.error('VENDOR WORDING ERROR', e); process.exit(1); });
