const Bill = require('../models/Bill');
const Cylinder = require('../models/Cylinder');
const Customer = require('../models/Customer');

// Filling-vendor customer ids for a user, as a Set of strings. Both the live recompute and the
// as-of validation pass this into replaySerial so a same-bill round trip resolves identically
// everywhere (see replaySerial).
async function fillingVendorIds(userId) {
  const vendors = await Customer.find({ user_id: userId, is_filling_vendor: true }, { _id: 1 }).lean();
  return new Set(vendors.map(v => String(v._id)));
}

// ─── Cylinder state derived from bill history (single source of truth) ───
// A cylinder's live location/stock_state must ALWAYS equal the result of replaying its full real
// bill history in EFFECTIVE-time order. Effective time is the line's `added_at` when set (a cylinder
// added to a bill during a later edit — Phase 35), otherwise the bill's bill_date (Phase 34). This
// keeps a transfer that a cylinder was added to during an edit authoritative over receives that were
// entered before that edit — the vehicle-collects-empties-en-route case.

const CH = 'AT_PLANT_CHANDISAR';

// IST calendar day of an instant — the business day an entry belongs to.
const istDay = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10);

// Effective time of one line for ordering: when it physically took effect.
//   1. The line's own added_at — it was put on this bill during a later edit (Phase 35).
//   2. The bill's finalized_at — a save-for-later draft is written up front but COMMITTED later,
//      often after other entries have already been made. The vehicle case: Palanpur starts the
//      transfer as a draft, cylinders collected en route are entered as customer receives, then
//      Chandisar opens the draft, adds those cylinders and commits it. The commit is a correction
//      and must outrank the receives made in between. Only honoured when the commit falls on the
//      SAME IST day as the bill's date, so a deliberately backdated draft keeps its chosen date.
//   3. Otherwise the bill's own date.
function lineEffTime(bill, line) {
  if (line && line.added_at) return new Date(line.added_at);
  const bd = new Date(bill.bill_date);
  if (bill.finalized_at) {
    const fin = new Date(bill.finalized_at);
    if (fin > bd && istDay(fin) === istDay(bd)) return fin;
  }
  return bd;
}

// Replay ONE serial's events to a final { state, holder } (holder = current customer when
// AT_CUSTOMER). `cutoff` (optional Date) includes only events effective on/before it — used for the
// date-aware "as of" validation. `vendorIds` = Set of filling-vendor customer ids (as strings).
//   TRANSFER → location = to_location (stock_state unchanged)
//   RECEIVED → IN_STOCK at bill.location
//   GIVEN    → AT_CUSTOMER at bill.location
//   GIVEN+RECEIVED on the SAME bill (a round trip) → decided by who the other party is:
//     · filling vendor  — we sent it empty and got it back filled → it ends in OUR stock
//     · normal customer — they returned one and took one → it ends WITH THEM
// That party test replaced an older guess based on the cylinder's previous stock_state, which was
// unreliable: transfers never set stock_state, so a cylinder whose prior history was only transfers
// looked "not in stock" and a vendor round-trip was misread as still being with the customer. Live
// inventory happened to seed from the real state and got it right, while the as-of validation seeded
// from an empty state and got it wrong — so the same cylinder passed in inventory but was rejected
// at entry time. Deciding by the party makes both paths agree by construction.
function replaySerial(bills, rot, initial, cutoff, vendorIds) {
  const evs = [];
  for (const b of bills) {
    const lines = (b.line_items || []).filter(li => (li.serial_number || '').trim() === rot);
    if (!lines.length) continue;
    // Base = the bill's effective time (finalize-aware); a line's own added_at wins over it, and
    // if several lines match (a swap) the latest added_at present is used.
    let eff = lineEffTime(b, null), sawAdded = false;
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
      const cid = e.bill.customer_id ? String(e.bill.customer_id._id || e.bill.customer_id) : '';
      // Known vendor → ours. Known customer → theirs. Without the vendor list (legacy callers),
      // fall back to the old previous-state guess rather than changing behaviour blindly.
      const ours = vendorIds ? vendorIds.has(cid) : st.stock_state === 'IN_STOCK';
      st.location = e.loc; st.stock_state = ours ? 'IN_STOCK' : 'AT_CUSTOMER';
      holder = ours ? null : { customer_id: e.bill.customer_id, bill_number: e.bill.bill_number };
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
  const vendorIds = await fillingVendorIds(userId);
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
    const { state: t } = replaySerial(bySerial[c.rotational_number] || [], c.rotational_number, { location: c.location, stock_state: c.stock_state }, null, vendorIds);
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
  const vendorIds = await fillingVendorIds(userId);
  const { state, holder, count } = replaySerial(bills, rot, { location: '', stock_state: '' }, new Date(asOf), vendorIds);
  return { state, holder, priorRealBills: count };
}

module.exports = { lineEffTime, replaySerial, recomputeCylinderState, stateAsOf, fillingVendorIds, CH };
