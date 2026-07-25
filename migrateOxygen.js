/**
 * One-off migration: merge legacy "Industrial Oxygen" / "Medical Oxygen" into a single "Oxygen".
 * Safe & idempotent. Reports record counts before/after.
 *
 * Run: node migrateOxygen.js
 */
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';
const LEGACY = ['Industrial Oxygen', 'Medical Oxygen'];

(async () => {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to', MONGODB_URI);
  const db = mongoose.connection.db;

  const Cylinder = mongoose.connection.collection('cylinders');
  const GasType  = mongoose.connection.collection('gastypes');
  const Bills    = mongoose.connection.collection('bills');

  // ---- BEFORE counts ----
  const beforeCyl = await Cylinder.countDocuments({ gas_type: { $in: LEGACY } });
  const legacyGasDocs = await GasType.find({ gas_type_name: { $in: LEGACY } }).toArray();
  const legacyIds = legacyGasDocs.map(g => g._id);
  const beforeBillLines = await Bills.countDocuments({ 'line_items.gas_type_id': { $in: legacyIds } });
  console.log('BEFORE → cylinders(legacy gas_type):', beforeCyl,
              '| legacy GasType docs:', legacyGasDocs.length,
              '| bills with legacy line gas_type_id:', beforeBillLines);

  // ---- 1. Cylinder.gas_type (string) rename ----
  const cylRes = await Cylinder.updateMany({ gas_type: { $in: LEGACY } }, { $set: { gas_type: 'Oxygen' } });
  console.log('Renamed cylinder gas_type → "Oxygen":', cylRes.modifiedCount);

  // ---- 2. Ensure canonical "Oxygen" GasType exists ----
  let oxygen = await GasType.findOne({ gas_type_name: 'Oxygen' });
  if (!oxygen) {
    const r = await GasType.insertOne({ gas_type_name: 'Oxygen', is_active: true, createdAt: new Date(), updatedAt: new Date() });
    oxygen = { _id: r.insertedId };
    console.log('Created canonical "Oxygen" GasType.');
  }

  // ---- 3. Repoint bill line items from legacy GasType ids → Oxygen, then delete legacy docs ----
  let repointed = 0;
  if (legacyIds.length) {
    const r = await Bills.updateMany(
      { 'line_items.gas_type_id': { $in: legacyIds } },
      { $set: { 'line_items.$[el].gas_type_id': oxygen._id } },
      { arrayFilters: [{ 'el.gas_type_id': { $in: legacyIds } }] }
    );
    repointed = r.modifiedCount;
    const del = await GasType.deleteMany({ _id: { $in: legacyIds } });
    console.log('Repointed bills:', repointed, '| deleted legacy GasType docs:', del.deletedCount);
  }

  // ---- AFTER counts ----
  const afterCyl = await Cylinder.countDocuments({ gas_type: { $in: LEGACY } });
  const afterGas = await GasType.countDocuments({ gas_type_name: { $in: LEGACY } });
  const afterBillLines = await Bills.countDocuments({ 'line_items.gas_type_id': { $in: legacyIds } });
  console.log('AFTER  → cylinders(legacy gas_type):', afterCyl,
              '| legacy GasType docs:', afterGas,
              '| bills with legacy line gas_type_id:', afterBillLines);
  console.log('Oxygen cylinders now:', await Cylinder.countDocuments({ gas_type: 'Oxygen' }));

  await mongoose.disconnect();
  console.log('Migration complete.');
  process.exit(0);
})().catch(err => { console.error('Migration failed:', err); process.exit(1); });
