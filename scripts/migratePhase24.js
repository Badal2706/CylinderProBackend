/**
 * Phase 24 migration — backfill Customer.is_hidden.
 *
 * Adds is_hidden: false to every existing customer so the soft-delete filter
 * ({ is_hidden: { $ne: true } }) behaves identically before and after deploy.
 * Idempotent: only touches documents where the field is missing.
 *
 *   node scripts/migratePhase24.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management';

(async () => {
  await mongoose.connect(MONGODB_URI);
  const host = mongoose.connection.host;
  console.log(`Connected to ${mongoose.connection.name} @ ${host}`);

  const Customer = require('../models/Customer');

  const missing = await Customer.countDocuments({ is_hidden: { $exists: false } });
  console.log(`Customers missing is_hidden: ${missing}`);

  if (missing) {
    const res = await Customer.updateMany(
      { is_hidden: { $exists: false } },
      { $set: { is_hidden: false } }
    );
    console.log(`Backfilled is_hidden: false on ${res.modifiedCount} customer(s).`);
  } else {
    console.log('Nothing to backfill.');
  }

  const total = await Customer.countDocuments();
  const hidden = await Customer.countDocuments({ is_hidden: true });
  console.log(`Done. ${total} customers total, ${hidden} currently hidden.`);

  await mongoose.disconnect();
})().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
