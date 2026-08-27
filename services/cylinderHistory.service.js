const CylinderHistory = require('../models/CylinderHistory');
const Cylinder = require('../models/Cylinder');
const LocationProfile = require('../models/LocationProfile');
const HttpError = require('../utils/HttpError');

// ─── Phase 33: per-cylinder history (log-only) ───
// This service ONLY reads cylinders and writes CylinderHistory. It never mutates a cylinder's
// location/stock_state — those change solely through their existing legitimate flows.
//
// GEN-C: nothing here is ever deleted. Until this phase logEvents() trimmed each cylinder to its
// 15 most recent entries on every write, which had already destroyed history for the 280 busiest
// cylinders. Measured against live data, five years of unpruned history costs ~77 MiB on disk —
// the cap was buying nothing and losing exactly the records that matter most (R95).

// The collapsed view every existing caller expects. NOT a storage limit any more — purely how many
// rows the default popup shows before offering the step-up-gated full view.
const DEFAULT_VIEW = 15;
const PAGE_SIZE = 20;   // full-view page size
const MAX_PAGE = 100;   // ceiling on a caller-supplied limit

// Newest-first. Shared by the default view and the paginated full view so that a row can never
// appear on two pages, or fall between them, as the caller advances.
const SORT = { event_at: -1, seq: -1, createdAt: -1, _id: -1 };

// {location: manager_name} for a user, in a single query. Blank where no manager is set.
// "Performed by" resolves from this map for whichever location's session did the action.
async function getManagerMap(userId) {
  const profiles = await LocationProfile.find({ user_id: userId }).lean();
  const map = {};
  profiles.forEach(p => { map[p.location] = p.manager_name || ''; });
  return map;
}

// Insert history entries. Append-only — GEN-C removed the rolling-cap trim that used to delete
// everything past the newest 15 (R95). Non-fatal on the caller's side: every hook wraps this in
// try/catch so a logging hiccup can never fail a bill save, transfer, fill, or edit.
async function logEvents(entries) {
  const list = (entries || []).filter(Boolean);
  if (!list.length) return;
  await CylinderHistory.insertMany(list, { ordered: false });
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

// document_ref is the bill number as it stood when the event was logged. Resolve each one to its
// bill so the popup shows the CURRENT number (bills can be renumbered afterwards) plus that
// bill's challan number. Old numbers are matched through bill_number_history.
async function resolveBillRefs(userId, rows) {
  const Bill = require('../models/Bill');
  const refs = [...new Set(rows.map(r => r.document_ref).filter(Boolean))];
  const byRef = {};
  if (!refs.length) return byRef;
  const bills = await Bill.find(
    { user_id: userId, $or: [{ bill_number: { $in: refs } }, { 'bill_number_history.old_value': { $in: refs } }] },
    { bill_number: 1, challan_no: 1, bill_number_history: 1 }
  ).lean();
  // Map historical numbers first, then current ones, so a current number always wins a collision.
  for (const b of bills) (b.bill_number_history || []).forEach(h => { if (h.old_value) byRef[h.old_value] = b; });
  for (const b of bills) byRef[b.bill_number] = b;
  return byRef;
}

// One log row as the popup renders it. Shared by the default and full views so the two can never
// drift into showing the same event differently.
const shapeRow = (r, byRef) => ({
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
});

// The DEFAULT view: the 15 most recent entries for one cylinder, plus a small cylinder header.
// Unchanged behaviour for every existing caller — no extra verification, still 15 rows.
//
// total_count is new: it lets the popup say "showing 15 of 47" and offer the full view without
// anyone having to step up merely to learn that a number exists. The COUNT is not sensitive; only
// the content beyond the newest 15 is, and that still requires approval.
async function getHistory(userId, cylinderId) {
  const cyl = await Cylinder.findOne({ _id: cylinderId, user_id: userId }).lean();
  if (!cyl) throw new HttpError(404, 'Cylinder not found');

  const q = { user_id: userId, cylinder_id: cylinderId };
  const [rows, total] = await Promise.all([
    CylinderHistory.find(q).sort(SORT).limit(DEFAULT_VIEW).lean(),
    CylinderHistory.countDocuments(q)
  ]);
  const byRef = await resolveBillRefs(userId, rows);

  return {
    cylinder: {
      rotational_number: cyl.rotational_number,
      gas_type: cyl.gas_type,
      capacity: cyl.capacity,
      location: cyl.location,
      stock_state: cyl.stock_state
    },
    total_count: total,
    history: rows.map(r => shapeRow(r, byRef))
  };
}

// The FULL view, one page at a time. Step-up gated at the route — see routes/cylinders.js.
// Plain skip/limit: realistic per-cylinder history counts (the busiest cylinder in live data has
// had 26 bill line items) never get near the depth where skip becomes expensive, and a cursor
// would cost complexity for no gain. SORT is shared with getHistory, and is total across
// (event_at, seq, createdAt, _id), so paging is stable.
async function getHistoryPage(userId, cylinderId, { skip = 0, limit = PAGE_SIZE } = {}) {
  const cyl = await Cylinder.findOne({ _id: cylinderId, user_id: userId }).select('_id').lean();
  if (!cyl) throw new HttpError(404, 'Cylinder not found');

  // Anything not a positive integer falls back to the default. Note the explicit `> 0` test:
  // `parseInt('-1') || PAGE_SIZE` yields -1 (it is truthy), which a Math.max(1, …) would then
  // clamp to a 1-row page rather than the default 20.
  const ps = parseInt(skip, 10);
  const pl = parseInt(limit, 10);
  const s = ps > 0 ? ps : 0;
  const l = Math.min(MAX_PAGE, pl > 0 ? pl : PAGE_SIZE);

  const q = { user_id: userId, cylinder_id: cylinderId };
  const [rows, total] = await Promise.all([
    CylinderHistory.find(q).sort(SORT).skip(s).limit(l).lean(),
    CylinderHistory.countDocuments(q)
  ]);
  const byRef = await resolveBillRefs(userId, rows);

  return {
    rows: rows.map(r => shapeRow(r, byRef)),
    total,
    skip: s,
    limit: l,
    hasMore: s + rows.length < total
  };
}

module.exports = {
  getManagerMap, logEvents, getHistory, getHistoryPage, syncBillTimes,
  DEFAULT_VIEW, PAGE_SIZE
};
