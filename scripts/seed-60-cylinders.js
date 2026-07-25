// Change 6: add exactly 60 new cylinders to the existing inventory (never delete/modify existing).
//   20 × Oxygen 7 m3, 20 × Nitrogen 7 m3, 20 × CO2 45 KG — all status at-plant.
// Rotational numbers start at ROT-051, or the next available if the highest is different.
// Physical numbers follow 202600 + <n> (so ROT-051 → 202651), matching the requested ranges.
// Run inside the backend container:  node scripts/seed-60-cylinders.js
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://mongo:27017/cylinder_management';
  await mongoose.connect(uri);
  const Cylinder = require('../models/Cylinder');
  const User = require('../models/User');

  const before = await Cylinder.countDocuments({});

  // Owner: the account that owns the real ROT-numbered inventory (the account with the MOST
  // ROT-<n> cylinders). Falls back to the account with the most cylinders, then the first user.
  let userId;
  const byUser = await Cylinder.aggregate([
    { $group: {
        _id: '$user_id',
        total: { $sum: 1 },
        rot: { $sum: { $cond: [{ $regexMatch: { input: '$rotational_number', regex: /^ROT-\d+$/ } }, 1, 0] } }
    } },
    { $sort: { rot: -1, total: -1 } }
  ]);
  if (byUser.length) userId = byUser[0]._id;
  else { const u = await User.findOne({}); userId = u && u._id; }
  if (!userId) throw new Error('No user found to own the seeded cylinders.');
  console.log('Seeding onto owner:', String(userId), '(existing ROT cylinders:', (byUser[0] && byUser[0].rot) || 0, ')');

  // Detect the highest existing ROT-<n> for this owner; start at max(next, 51).
  const existing = await Cylinder.find({ user_id: userId }, { rotational_number: 1 });
  let maxN = 0;
  existing.forEach(c => { const m = /^ROT-(\d+)$/.exec(c.rotational_number || ''); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); });
  const startN = Math.max(maxN + 1, 51);

  const batches = [
    { gas: 'Oxygen',   cap: '7 m3',  count: 20 },
    { gas: 'Nitrogen', cap: '7 m3',  count: 20 },
    { gas: 'CO2',      cap: '45 KG', count: 20 }
  ];

  const docs = [];
  const perGas = {};
  let n = startN;
  for (const bt of batches) {
    for (let i = 0; i < bt.count; i++) {
      docs.push({
        user_id: userId,
        rotational_number: 'ROT-' + String(n).padStart(3, '0'),
        physical_number: String(202600 + n),
        gas_type: bt.gas,
        capacity: bt.cap,
        status: 'at-plant'
      });
      perGas[bt.gas] = (perGas[bt.gas] || 0) + 1;
      n++;
    }
  }

  const inserted = await Cylinder.insertMany(docs, { ordered: false });
  const after = await Cylinder.countDocuments({});

  console.log('─── Seed 60 cylinders ───');
  console.log('Total before :', before);
  console.log('Total added  :', inserted.length);
  console.log('Total after  :', after);
  console.log('Breakdown    :', JSON.stringify(perGas));
  console.log('ROT range    :', docs[0].rotational_number, '→', docs[docs.length - 1].rotational_number);
  console.log('Physical rng :', docs[0].physical_number, '→', docs[docs.length - 1].physical_number);

  await mongoose.disconnect();
})().catch(e => { console.error('Seed failed:', e); process.exit(1); });
