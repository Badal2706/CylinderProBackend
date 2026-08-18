const Bill = require('../models/Bill');
const Cylinder = require('../models/Cylinder');

// ─── Phase 34: cylinder state derived from bill history (single source of truth) ───
// A cylinder's live location/stock_state must ALWAYS equal the result of replaying its full real
// bill history in transaction date+time order (bill_date, then createdAt as tiebreak), most recent
// event authoritative. The Bill post-save hook only makes an optimistic local guess; recompute
// (below) is what guarantees correctness after every create/edit/delete — including out-of-order
// (backdated) saves, which is what corrupted cylinder 1870 before this phase.

// Apply one bill's movement to a per-serial state map. Faithful to the post-save hook:
//   TRANSFER  → location = to_location (stock_state unchanged)
//   RECEIVED  → IN_STOCK at bill.location   (applied before GIVEN, for swap round-trips)
//   GIVEN     → AT_CUSTOMER at bill.location, EXCEPT a same-bill outbound round-trip
//               (was IN_STOCK, sent for filling + received back on the same bill) stays IN_STOCK.
// `has(rot)` limits work to the serials we are tracking.
function applyBill(b, state, has) {
  const items = (b.line_items || []).filter(li => (li.serial_number || '').trim());
  if (b.transaction_category === 'INTERNAL_TRANSFER') {
    for (const li of items) {
      const rot = li.serial_number.trim();
      if (!has(rot)) continue;
      const st = state[rot] || (state[rot] = { location: '', stock_state: '' });
      st.location = b.to_location;
    }
    return;
  }
  const received = items.filter(li => li.direction === 'RECEIVED').map(li => li.serial_number.trim());
  const given = items.filter(li => li.direction === 'GIVEN').map(li => li.serial_number.trim());
  const receivedSet = new Set(received);
  const outbound = new Set();
  for (const s of given) {
    if (receivedSet.has(s) && has(s)) {
      const pre = state[s] && state[s].stock_state;
      if (pre === 'IN_STOCK') outbound.add(s);
    }
  }
  for (const s of received) {
    if (!has(s)) continue;
    const st = state[s] || (state[s] = { location: '', stock_state: '' });
    st.location = b.location; st.stock_state = 'IN_STOCK';
  }
  for (const s of given) {
    if (!has(s) || outbound.has(s)) continue;
    const st = state[s] || (state[s] = { location: '', stock_state: '' });
    st.location = b.location; st.stock_state = 'AT_CUSTOMER';
  }
}

// Recompute the live location/stock_state of the given serials from their full real bill history,
// and persist any that drifted. Runs synchronously inside every save/edit/delete flow so the
// cylinder's stored state is never stale. under_maintenance is never touched (independent flag).
// Returns the list of corrections made (usually empty for in-order same-day writes).
async function recomputeCylinderState(userId, serials) {
  const rots = [...new Set((serials || []).map(s => String(s).trim()).filter(Boolean))];
  if (!rots.length) return [];

  const cyls = await Cylinder.find({ user_id: userId, rotational_number: { $in: rots } });
  if (!cyls.length) return [];

  // Seed each tracked serial from its current doc: transfer-only cylinders (never given/received)
  // keep their stock_state, since replay of transfers alone never sets it.
  const state = {};
  const rotSet = new Set();
  cyls.forEach(c => { state[c.rotational_number] = { location: c.location, stock_state: c.stock_state }; rotSet.add(c.rotational_number); });

  const bills = await Bill.find({
    user_id: userId, is_draft: { $ne: true },
    'line_items.serial_number': { $in: [...rotSet] }
  }).sort({ bill_date: 1, createdAt: 1 }).lean();

  for (const b of bills) applyBill(b, state, r => rotSet.has(r));

  const changes = [];
  for (const c of cyls) {
    const t = state[c.rotational_number];
    if (!t) continue;
    if (c.location !== t.location || c.stock_state !== t.stock_state) {
      await Cylinder.updateOne({ _id: c._id }, { location: t.location, stock_state: t.stock_state });
      changes.push({ rotational_number: c.rotational_number, from: `${c.location}/${c.stock_state}`, to: `${t.location}/${t.stock_state}` });
    }
  }
  return changes;
}

// As-of state of ONE serial at `asOf` (a bill's date+time), replaying only real bills dated
// on/before asOf (excluding the bill being created/edited). priorRealBills===0 means no genuine
// bill precedes this moment — only the Phase 33 migration placeholder does, which is the sole case
// the pre-software confirmation may fire (item 4). When AT_CUSTOMER, `holder` names who held it.
async function stateAsOf(userId, serial, asOf, excludeBillId) {
  const rot = String(serial || '').trim();
  const q = { user_id: userId, is_draft: { $ne: true }, 'line_items.serial_number': rot, bill_date: { $lte: asOf } };
  if (excludeBillId) q._id = { $ne: excludeBillId };
  const bills = await Bill.find(q).sort({ bill_date: 1, createdAt: 1 }).lean();

  const state = { [rot]: { location: '', stock_state: '' } };
  let holder = null; // most recent unreturned GIVEN's customer, as of asOf
  for (const b of bills) {
    applyBill(b, state, r => r === rot);
    if (b.transaction_category !== 'INTERNAL_TRANSFER') {
      // RECEIVED before GIVEN so a same-bill swap ends held (matches applyBill's ordering).
      const items = (b.line_items || []).filter(li => (li.serial_number || '').trim() === rot);
      const hasRecv = items.some(li => li.direction === 'RECEIVED');
      const hasGiven = items.some(li => li.direction === 'GIVEN');
      if (hasRecv) holder = null;
      if (hasGiven) holder = { customer_id: b.customer_id, bill_number: b.bill_number, bill_date: b.bill_date };
    }
  }
  // If replay ended not-at-customer, there is no holder regardless of the last GIVEN seen.
  if (state[rot].stock_state !== 'AT_CUSTOMER') holder = null;

  return { state: state[rot], holder, priorRealBills: bills.length };
}

module.exports = { applyBill, recomputeCylinderState, stateAsOf };
