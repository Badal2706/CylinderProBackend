// Phase 10 migration: per-gas scoped size catalog.
//   1. Seed a GasCapacity doc per config gas type ($setOnInsert — existing docs untouched).
//   2. Ensure every gas in the GasType collection has a GasCapacity doc.
//   3. Union in every distinct (gas_type, capacity) pair present in actual Cylinder data,
//      so all currently valid pairs remain valid after the restructuring.
//
//   node scripts/migratePhase10.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const GasType = require('../models/GasType');
const GasCapacity = require('../models/GasCapacity');
const Cylinder = require('../models/Cylinder');
const { GAS_CAPACITIES } = require('../config/gasCapacities');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to ${MONGODB_URI}`);

  for (const gas of Object.keys(GAS_CAPACITIES)) {
    await GasCapacity.updateOne(
      { gas_type_name: gas },
      { $setOnInsert: { gas_type_name: gas, sizes: GAS_CAPACITIES[gas] } },
      { upsert: true }
    );
  }

  const gases = await GasType.find({});
  for (const g of gases) {
    await GasCapacity.updateOne(
      { gas_type_name: g.gas_type_name },
      { $setOnInsert: { gas_type_name: g.gas_type_name, sizes: [] } },
      { upsert: true }
    );
  }

  // Preserve every pair that exists in inventory (across all tenants).
  const pairs = await Cylinder.aggregate([
    { $group: { _id: { gas: '$gas_type', cap: '$capacity' } } }
  ]);
  let added = 0;
  for (const p of pairs) {
    const { gas, cap } = p._id;
    if (!gas || !cap) continue;
    const r = await GasCapacity.updateOne(
      { gas_type_name: gas },
      { $addToSet: { sizes: cap } },
      { upsert: true }
    );
    if (r.modifiedCount || r.upsertedCount) added++;
  }

  const docs = await GasCapacity.find({}).sort('gas_type_name');
  console.log(`GasCapacity docs: ${docs.length}; inventory pairs merged in: ${added}`);
  docs.forEach(d => console.log(`  ${d.gas_type_name}: [${d.sizes.join(', ')}]`));
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
