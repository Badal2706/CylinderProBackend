const Bill = require('../models/Bill');
const Cylinder = require('../models/Cylinder');

// ─── Cylinder state derived from bill history (single source of truth) ───
// A cylinder's live location/stock_state must ALWAYS equal the result of replaying its full real
// bill history in EFFECTIVE-time order. Effective time is the line's `added_at` when set (a cylinder
// added to a bill during a later edit — Phase 35), otherwise the bill's bill_date (Phase 34). This
// keeps a transfer that a cylinder was added to during an edit authoritative over receives that were
// entered before that edit — the vehicle-collects-empties-en-route case.

const CH = 'AT_PLANT_CHANDISAR';

// Effective time of one line for ordering: when it physically took effect.
function lineEffTime(bill, line) {
  return line && line.added_at ? new Date(line.added_at) : new Date(bill.bill_date);
}

// Replay ONE serial's events to a final { state, holder } (holder = current customer when
// AT_CUSTOMER). `cutoff` (optional Date) includes only events effective on/before it — used for the
// date-aware "as of" validation. Faithful to the post-save hook:
//   TRANSFER → location = to_location (stock_state unchanged)
//   RECEIVED → IN_STOCK at bill.location
//   GIVEN    → AT_CUSTOMER at bill.location, EXCEPT a same-bill outbound round-trip (was IN_STOCK,
//              sent for filling + received back on the same bill) which stays IN_STOCK.
function replaySerial(bills, rot, initial, cutoff) {
  const evs = [];
  for (const b of bills) {
    const lines = (b.line_items || []).filter(li => (li.serial_number || '').trim() === rot);
    if (!lines.length) continue;
    // A line's own added_at wins; if several lines match (a swap), take the latest added_at present.
    let eff = new Date(b.bill_date), sawAdded = false;
    for (const li of lines) {
      if (li.added_at) { const t = new Date(li.added_at); if (!sawAdded || t > eff) { eff = t; sawAdded = true; } }
    }
    if (cutoff && eff > cutoff) continue; // not yet effective as of the cutoff
    evs.push({
      eff, created: new Date(b.createdAt),
      isTransfer: b.transaction_category === 'INTERNAL_TRANSFER',
      hasR: lines.some(li => li.direction === 'RECEIVED'),
      hasG: lines.some(li => li.direction === 'GIVEN'),
      to: b.to_location, loc: b.location, bill: b
    });
  }
  evs.sort((a, b) => (a.eff - b.eff) || (a.created - b.created));

  const st = { location: initial ? initial.location : '', stock_state: initial ? initial.stock_state : '' };
  let holder = null;
  for (const e of evs) {
    if (e.isTransfer) { st.location = e.to; continue; } // stock_state unchanged by a transfer
    if (e.hasR && e.hasG) {
      const preInStock = st.stock_state === 'IN_STOCK'; // outbound round-trip stays IN_STOCK
      st.location = e.loc; st.stock_state = preInStock ? 'IN_STOCK' : 'AT_CUSTOMER';
      holder = preInStock ? null : { customer_id: e.bill.customer_id, bill_number: e.bill.bill_number };
    } else if (e.hasR) {
      st.location = e.loc; st.stock_state = 'IN_STOCK'; holder = null;
    } else if (e.hasG) {
      st.location = e.loc; st.stock_state = 'AT_CUSTOMER'; holder = { customer_id: e.bill.customer_id, bill_number: e.bill.bill_number };
    }
  }
  if (st.stock_state !== 'AT_CUSTOMER') holder = null;
  return { state: st, holder, count: evs.length };
}

// Recompute the live location/stock_state of the given serials from their full real bill history,
// persisting any that drifted. Runs synchronously inside every save/edit/delete flow. Returns the
// corrections made (usually empty). under_maintenance is never touched (independent flag).
async function recomputeCylinderState(userId, serials) {
  const rots = [...new Set((serials || []).map(s => String(s).trim()).filter(Boolean))];
  if (!rots.length) return [];
  const cyls = await Cylinder.find({ user_id: userId, rotational_number: { $in: rots } });
  if (!cyls.length) return [];

  const bills = await Bill.find({
    user_id: userId, is_draft: { $ne: true },
    'line_items.serial_number': { $in: rots }
  }).lean();
  // Bills per serial (a bill can touch several of the requested serials).
  const bySerial = {};
  rots.forEach(r => { bySerial[r] = []; });
  for (const b of bills) {
    const seen = new Set();
    for (const li of (b.line_items || [])) {
      const s = (li.serial_number || '').trim();
      if (bySerial[s] && !seen.has(s)) { bySerial[s].push(b); seen.add(s); }
    }
  }

  const changes = [];
  for (const c of cyls) {
    const { state: t } = replaySerial(bySerial[c.rotational_number] || [], c.rotational_number, { location: c.location, stock_state: c.stock_state });
    if (c.location !== t.location || c.stock_state !== t.stock_state) {
      await Cylinder.updateOne({ _id: c._id }, { location: t.location, stock_state: t.stock_state });
      changes.push({ rotational_number: c.rotational_number, from: `${c.location}/${c.stock_state}`, to: `${t.location}/${t.stock_state}` });
    }
  }
  return changes;
}

// As-of state of ONE serial at `asOf` (effective-time cutoff), replaying only real bills effective
// on/before it (excluding the bill being created/edited). priorRealBills===0 means only the Phase 33
// migration placeholder precedes it — the sole case the pre-software confirmation may fire.
async function stateAsOf(userId, serial, asOf, excludeBillId) {
  const rot = String(serial || '').trim();
  const q = { user_id: userId, is_draft: { $ne: true }, 'line_items.serial_number': rot };
  if (excludeBillId) q._id = { $ne: excludeBillId };
  const bills = await Bill.find(q).lean();
  const { state, holder, count } = replaySerial(bills, rot, { location: '', stock_state: '' }, new Date(asOf));
  return { state, holder, priorRealBills: count };
}

module.exports = { lineEffTime, replaySerial, recomputeCylinderState, stateAsOf, CH };
