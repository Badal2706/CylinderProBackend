const CylinderHistory = require('../models/CylinderHistory');
const Cylinder = require('../models/Cylinder');
const LocationProfile = require('../models/LocationProfile');
const HttpError = require('../utils/HttpError');

// ─── Phase 33: per-cylinder history (log-only) ───
// This service ONLY reads cylinders and writes CylinderHistory. It never mutates a cylinder's
// location/stock_state — those change solely through their existing legitimate flows.

const CAP = 15; // rolling window: at most 15 entries per cylinder, at all times.

// {location: manager_name} for a user, in a single query. Blank where no manager is set.
// "Performed by" resolves from this map for whichever location's session did the action.
async function getManagerMap(userId) {
  const profiles = await LocationProfile.find({ user_id: userId }).lean();
  const map = {};
  profiles.forEach(p => { map[p.location] = p.manager_name || ''; });
  return map;
}

// Insert history entries, then enforce the rolling 15-entry cap per cylinder (delete the oldest
// beyond the newest 15). Non-fatal on the caller's side — every hook wraps this in try/catch so a
// logging hiccup can never fail a bill save, transfer, fill, or edit.
async function logEvents(entries) {
  const list = (entries || []).filter(Boolean);
  if (!list.length) return;
  await CylinderHistory.insertMany(list, { ordered: false });

  const pairs = [...new Set(list.map(e => `${e.user_id}|${e.cylinder_id}`))];
  for (const pair of pairs) {
    const [userId, cylinderId] = pair.split('|');
    const overflow = await CylinderHistory.find({ user_id: userId, cylinder_id: cylinderId })
      .sort({ event_at: -1, createdAt: -1, _id: -1 })
      .skip(CAP)
      .select('_id')
      .lean();
    if (overflow.length) {
      await CylinderHistory.deleteMany({ _id: { $in: overflow.map(o => o._id) } });
    }
  }
}

// Re-point a bill's history rows at its CURRENT effective time. A bill's date is editable, and the
// per-cylinder log is written once at save — so without this an edited bill kept its original time
// in every cylinder's history, disagreeing with the transaction list and with the replay order that
// decides where the cylinder actually is. Called after every bill edit. Touches only timestamps.
async function syncBillTimes(userId, bill) {
  const refs = [bill.bill_number, ...((bill.bill_number_history || []).map(h => h.old_value))].filter(Boolean);
  if (!refs.length) return 0;
  const rows = await CylinderHistory.find({ user_id: userId, document_ref: { $in: refs } }).lean();
  let touched = 0;
  for (const r of rows) {
    const line = (bill.line_items || []).find(li => (li.serial_number || '').trim() === (r.rotational_number || '').trim());
    // Same effective time the state replay uses: the line's added_at when set, else the bill date.
    const eff = line && line.added_at ? new Date(line.added_at) : new Date(bill.bill_date);
    if (Math.abs(new Date(r.event_at).getTime() - eff.getTime()) <= 1000) continue;
    await CylinderHistory.updateOne({ _id: r._id }, { $set: { event_at: eff } });
    touched++;
  }
  return touched;
}

// The 15 most recent entries for one cylinder (most recent first), plus a small cylinder header.
async function getHistory(userId, cylinderId) {
  const cyl = await Cylinder.findOne({ _id: cylinderId, user_id: userId }).lean();
  if (!cyl) throw new HttpError(404, 'Cylinder not found');

  const rows = await CylinderHistory.find({ user_id: userId, cylinder_id: cylinderId })
    .sort({ event_at: -1, createdAt: -1, _id: -1 })
    .limit(CAP)
    .lean();

  // document_ref is the bill number as it stood when the event was logged. Resolve each one to its
  // bill so the popup shows the CURRENT number (bills can be renumbered afterwards) plus that
  // bill's challan number. Old numbers are matched through bill_number_history.
  const Bill = require('../models/Bill');
  const refs = [...new Set(rows.map(r => r.document_ref).filter(Boolean))];
  const byRef = {};
  if (refs.length) {
    const bills = await Bill.find(
      { user_id: userId, $or: [{ bill_number: { $in: refs } }, { 'bill_number_history.old_value': { $in: refs } }] },
      { bill_number: 1, challan_no: 1, bill_number_history: 1 }
    ).lean();
    // Map historical numbers first, then current ones, so a current number always wins a collision.
    for (const b of bills) (b.bill_number_history || []).forEach(h => { if (h.old_value) byRef[h.old_value] = b; });
    for (const b of bills) byRef[b.bill_number] = b;
  }

  return {
    cylinder: {
      rotational_number: cyl.rotational_number,
      gas_type: cyl.gas_type,
      capacity: cyl.capacity,
      location: cyl.location,
      stock_state: cyl.stock_state
    },
    history: rows.map(r => ({
      id: String(r._id),
      event_type: r.event_type,
      description: r.description,
      // event_at = real-world transaction time (may be backdated); entered_at = when it was typed
      // into the software (the doc's creation time). Phase 34 item 5 shows both, distinctly.
      event_at: r.event_at,
      entered_at: r.createdAt,
      performed_by: r.performed_by || '',
      performed_at_location: r.performed_at_location || '',
      from_location: r.from_location || '',
      to_location: r.to_location || '',
      from_state: r.from_state || '',
      to_state: r.to_state || '',
      customer_name: r.customer_name || '',
      // When this log line was last touched — an edit to the bill's date re-points event_at and
      // bumps this, so the popup can show "entered" vs "last changed".
      changed_at: r.updatedAt || r.createdAt,
      // Current bill number (falls back to the logged snapshot if the bill is gone) + its challan.
      document_ref: (byRef[r.document_ref] && byRef[r.document_ref].bill_number) || r.document_ref || '',
      challan_no: (byRef[r.document_ref] && byRef[r.document_ref].challan_no) || ''
    }))
  };
}

module.exports = { getManagerMap, logEvents, getHistory, syncBillTimes, CAP };
