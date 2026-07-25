// One-time migration (Change 5, Step 1):
//   - Drop the legacy PersonalCylinder collection
//   - Remove any legacy `personalCylinders` array from Customer docs
//   - Delete ALL Bill and Payment records (fresh start for transactions)
//   - Reset every customer's quantity-only `personalCylindersAtPlant` to 0
//   - Keep users, customers, and cylinder inventory intact
// Run inside the backend container:  node scripts/cleanup-personal-and-transactions.js
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://mongo:27017/cylinder_management';
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const Bill = require('../models/Bill');
  const Payment = require('../models/Payment');
  const Customer = require('../models/Customer');

  // Drop legacy PersonalCylinder collection if present.
  const existing = await db.listCollections({ name: 'personalcylinders' }).toArray();
  if (existing.length) { await db.collection('personalcylinders').drop(); console.log('• Dropped personalcylinders collection'); }
  else console.log('• personalcylinders collection not present (nothing to drop)');

  // Remove any legacy embedded personalCylinders array from customers.
  const unset = await Customer.updateMany({}, { $unset: { personalCylinders: '' } });
  console.log('• Removed legacy personalCylinders array from', unset.modifiedCount, 'customer(s)');

  // Fresh start for transactions: delete all bills + payments.
  const b = await Bill.deleteMany({});
  const p = await Payment.deleteMany({});
  console.log('• Deleted bills:', b.deletedCount, '| payments:', p.deletedCount);

  // Reset the quantity-only running count.
  const r = await Customer.updateMany({}, { $set: { personalCylindersAtPlant: 0 } });
  console.log('• Reset personalCylindersAtPlant = 0 on', r.matchedCount, 'customer(s)');

  // Verify: no negative counts (should be impossible after reset).
  const neg = await Customer.countDocuments({ personalCylindersAtPlant: { $lt: 0 } });
  console.log(neg === 0 ? '✓ No customers with negative personalCylindersAtPlant' : `⚠ ${neg} customer(s) NEGATIVE — investigate`);

  // Confirm preserved data.
  const custCount = await Customer.countDocuments({});
  const cylCount = await db.collection('cylinders').countDocuments({});
  const userCount = await db.collection('users').countDocuments({});
  console.log(`✓ Preserved — users: ${userCount}, customers: ${custCount}, cylinders: ${cylCount}`);

  await mongoose.disconnect();
  console.log('Cleanup complete.');
})().catch(e => { console.error('Cleanup failed:', e); process.exit(1); });
