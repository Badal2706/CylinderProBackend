const Bill = require('../models/Bill');
const LocationPcStock = require('../models/LocationPcStock');
const { LOCATIONS } = require('../config/locations');

// ─── Per-location PC stock (Phase 11, physical-custody model Phase 31) ───
// Rebuilt from scratch on every bill mutation (createBill / createInternalTransfer /
// updateBill / deleteBill call recompute). Full recompute keeps it correct through bill
// edits, deletes and draft finalization without incremental bookkeeping.
//
// Phase 31 — chronological, source-clamped replay so a per-location count reflects true
// physical custody and is NEVER negative:
//   • Events are replayed in date order (bill_date, then createdAt).
//   • Customer bill at site L: personal cylinders COLLECTED (personalCylindersIn) arrive at L;
//     personal cylinders RETURNED (personalCylindersOut) leave L — clamped at 0 (a return can't
//     take a site below what it physically holds; the shortfall means the matching collection
//     was recorded elsewhere/not at all). Arrivals are applied before departures within a bill.
//   • Internal transfer: moves only min(qty, what the source actually holds) from source to
//     destination — a transfer of cylinders never collected at the source can't drive it
//     negative. For clean, balanced data this is identical to the exact net; only internally
//     inconsistent historical data (transfers with no matching collection) differs, and there
//     the customer's own per-combo balance remains the authoritative "total held" figure.
async function recomputeLocationPcStock(userId) {
  const bills = await Bill.find(
    { user_id: userId, is_draft: { $ne: true } },
    { transaction_category: 1, location: 1, from_location: 1, to_location: 1, line_items: 1 }
  ).sort({ bill_date: 1, createdAt: 1 }).lean();

  // state[gas|capacity][location] = qty (always ≥ 0)
  const state = {};
  const cell = (combo, loc) => {
    if (!state[combo]) state[combo] = {};
    if (!(loc in state[combo])) state[combo][loc] = 0;
    return state[combo][loc];
  };
  const setCell = (combo, loc, qty) => { state[combo][loc] = qty; };
  const comboOf = (li) => `${li.gas_type_name || ''}|${li.size_label || ''}`;

  for (const b of bills) {
    if (b.transaction_category === 'INTERNAL_TRANSFER') {
      if (!LOCATIONS.includes(b.from_location) || !LOCATIONS.includes(b.to_location)) continue;
      for (const li of b.line_items) {
        const qty = Number(li.personalCylindersIn) || 0; // transfer PC qty rides here
        if (qty <= 0) continue;
        const combo = comboOf(li);
        const avail = Math.max(0, cell(combo, b.from_location));
        const move = Math.min(qty, avail);
        if (!move) { cell(combo, b.to_location); continue; } // nothing to move (source empty)
        setCell(combo, b.from_location, cell(combo, b.from_location) - move);
        setCell(combo, b.to_location, cell(combo, b.to_location) + move);
      }
    } else {
      if (!LOCATIONS.includes(b.location)) continue;
      // Aggregate this bill's PC in/out per combo, then apply arrivals before departures so a
      // same-bill collect+return nets correctly and departures clamp at 0.
      const inBy = {}, outBy = {};
      for (const li of b.line_items) {
        const pin = Number(li.personalCylindersIn) || 0;
        const pout = Number(li.personalCylindersOut) || 0;
        if (!pin && !pout) continue;
        const combo = comboOf(li);
        inBy[combo] = (inBy[combo] || 0) + pin;
        outBy[combo] = (outBy[combo] || 0) + pout;
      }
      for (const combo of new Set([...Object.keys(inBy), ...Object.keys(outBy)])) {
        const arrived = cell(combo, b.location) + (inBy[combo] || 0);
        setCell(combo, b.location, Math.max(0, arrived - (outBy[combo] || 0)));
      }
    }
  }

  await LocationPcStock.deleteMany({ user_id: userId });
  const docs = [];
  for (const [combo, locs] of Object.entries(state)) {
    const [gas_type, capacity] = combo.split('|');
    for (const [location, qty] of Object.entries(locs)) {
      if (qty > 0) docs.push({ user_id: userId, location, gas_type, capacity, qty });
    }
  }
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
