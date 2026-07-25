// Phase 9 migration: backfill gas_type_name / size_label snapshots on every existing bill
// line item, resolved from the current GasType / CylinderSize master docs. Additive only —
// no line item is otherwise modified, and lines that already carry snapshots are skipped.
//
//   node scripts/migratePhase9.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Bill = require('../models/Bill');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to ${MONGODB_URI}`);

  const [gasDocs, sizeDocs] = await Promise.all([GasType.find({}), CylinderSize.find({})]);
  const gasName = {}; gasDocs.forEach(g => { gasName[String(g._id)] = g.gas_type_name; });
  const sizeLabel = {}; sizeDocs.forEach(s => { sizeLabel[String(s._id)] = s.size_label; });

  const bills = await Bill.find({});
  let billsTouched = 0, linesFilled = 0, unresolved = 0;
  for (const b of bills) {
    let dirty = false;
    for (const li of b.line_items) {
      if (!li.gas_type_name) {
        const n = gasName[String(li.gas_type_id)];
        if (n) { li.gas_type_name = n; linesFilled++; dirty = true; } else if (li.gas_type_id) unresolved++;
      }
      if (!li.size_label) {
        const n = sizeLabel[String(li.cylinder_size_id)];
        if (n) { li.size_label = n; dirty = true; } else if (li.cylinder_size_id) unresolved++;
      }
    }
    if (dirty) {
      // updateOne (not save) so the Bill post-save cylinder-sync hook is never triggered.
      await Bill.updateOne({ _id: b._id }, { $set: { line_items: b.line_items } });
      billsTouched++;
    }
  }

  console.log(`Bills touched: ${billsTouched}; line gas names filled: ${linesFilled}; unresolved refs: ${unresolved}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
