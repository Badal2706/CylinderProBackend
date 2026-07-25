const Bill = require('../models/Bill');
const LocationPcStock = require('../models/LocationPcStock');
const { LOCATIONS } = require('../config/locations');

// ─── Per-location PC stock (Phase 11) ───
// Rebuilt from scratch on every bill mutation (createBill / createInternalTransfer /
// updateBill / deleteBill call recompute). Full recompute keeps it correct through bill
// edits, deletes and draft finalization without incremental bookkeeping.
async function recomputeLocationPcStock(userId) {
  const bills = await Bill.find(
    { user_id: userId, is_draft: { $ne: true } },
    { transaction_category: 1, location: 1, from_location: 1, to_location: 1, line_items: 1 }
  );

  // key = location|gas|capacity → qty
  const map = {};
  const bump = (location, li, delta) => {
    if (!delta || !LOCATIONS.includes(location)) return;
    const key = `${location}|${li.gas_type_name || ''}|${li.size_label || ''}`;
    map[key] = (map[key] || 0) + delta;
  };

  for (const b of bills) {
    for (const li of b.line_items) {
      const pcIn = Number(li.personalCylindersIn) || 0;
      const pcOut = Number(li.personalCylindersOut) || 0;
      if (!pcIn && !pcOut) continue;
      if (b.transaction_category === 'INTERNAL_TRANSFER') {
        // PC transfer lines carry the moved quantity in personalCylindersIn.
        bump(b.from_location, li, -pcIn);
        bump(b.to_location, li, pcIn);
      } else {
        // Customer bill at its site: PC received in, PC given/sent out.
        bump(b.location, li, pcIn - pcOut);
      }
    }
  }

  await LocationPcStock.deleteMany({ user_id: userId });
  const docs = Object.entries(map)
    .filter(([, qty]) => qty !== 0)
    .map(([key, qty]) => {
      const [location, gas_type, capacity] = key.split('|');
      return { user_id: userId, location, gas_type, capacity, qty };
    });
  if (docs.length) await LocationPcStock.insertMany(docs);
}

// Rows for display: [{ location, gas_type, capacity, qty }], optionally one location only.
async function getPcStock(userId, location) {
  const q = { user_id: userId };
  if (location && LOCATIONS.includes(location)) q.location = location;
  const rows = await LocationPcStock.find(q).sort('location gas_type capacity');
  return rows.map(r => ({ location: r.location, gas_type: r.gas_type, capacity: r.capacity, qty: r.qty }));
}

module.exports = { recomputeLocationPcStock, getPcStock };
