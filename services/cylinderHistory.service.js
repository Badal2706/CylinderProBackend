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

// The 15 most recent entries for one cylinder (most recent first), plus a small cylinder header.
async function getHistory(userId, cylinderId) {
  const cyl = await Cylinder.findOne({ _id: cylinderId, user_id: userId }).lean();
  if (!cyl) throw new HttpError(404, 'Cylinder not found');

  const rows = await CylinderHistory.find({ user_id: userId, cylinder_id: cylinderId })
    .sort({ event_at: -1, createdAt: -1, _id: -1 })
    .limit(CAP)
    .lean();

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
      document_ref: r.document_ref || ''
    }))
  };
}

module.exports = { getManagerMap, logEvents, getHistory, CAP };
