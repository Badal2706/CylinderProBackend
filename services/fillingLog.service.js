const FillingLogEntry = require('../models/FillingLogEntry');
const Cylinder = require('../models/Cylinder');
const HttpError = require('../utils/HttpError');
const locationService = require('./location.service');
const { istDayRange } = require('../utils/istDay');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Phase 33: log-only FILLED history. A fill NEVER touches a cylinder's location/stock_state
// (Phase 32 invariant) — this only records the event alongside the filling log. Non-fatal.
// items: [{ cylinderId, rotational_number, date }] for entries that matched a real cylinder.
async function logFillHistory(userId, items) {
  let list = (items || []).filter(it => it && it.cylinderId);
  if (!list.length) return;
  try {
    const cylHistory = require('./cylinderHistory.service');

    // ── ONCE PER SERIAL PER DAY ──
    // saveDay replaces the whole day's log rows, but history is append-only. Without this, every
    // edit re-logged FILLED for every serial still on the list, so a cylinder that survived three
    // corrections read as having been filled three times. It was not: it was filled once and the
    // typing was corrected twice.
    //
    // So a serial already carrying a FILLED event for this date is skipped. Serials REMOVED by an
    // edit were never in `items` to begin with and are untouched either way — and nothing here
    // deletes or rewrites an existing entry, so history already written stays exactly as it is.
    const CylinderHistory = require('../models/CylinderHistory');
    const byDate = new Map();
    for (const it of list) {
      if (!byDate.has(it.date)) byDate.set(it.date, []);
      byDate.get(it.date).push(it.cylinderId);
    }
    const alreadyLogged = new Set();
    for (const [date, ids] of byDate) {
      const { start, end } = istDayRange(date);
      const rows = await CylinderHistory.find({
        user_id: userId, event_type: 'FILLED', cylinder_id: { $in: ids },
        event_at: { $gte: start, $lte: end }
      }).select('cylinder_id').lean();
      rows.forEach(r => alreadyLogged.add(date + '|' + String(r.cylinder_id)));
    }
    list = list.filter(it => !alreadyLogged.has(it.date + '|' + String(it.cylinderId)));
    if (!list.length) return;
    // GEN-B1: a fill happens at the user's filling location, not a hardcoded site. With none
    // configured there is nothing truthful to record, so log nothing rather than stamp every
    // fill with a site that does not fill — a mislabelled history entry is worse than none.
    const { fillingLocationCode, labels } = await locationService.getUserLocations(userId);
    if (!fillingLocationCode) {
      console.error('logFillHistory: no filling location configured for user ' + userId +
                    ' — FILLED history not recorded. Mark one location as the filling location.');
      return;
    }
    const fillingLabel = labels[fillingLocationCode] || fillingLocationCode;
    const mgrMap = await cylHistory.getManagerMap(userId);
    const performer = mgrMap[fillingLocationCode] || '';
    await cylHistory.logEvents(list.map(it => ({
      user_id: userId, cylinder_id: it.cylinderId, rotational_number: it.rotational_number,
      event_type: 'FILLED',
      description: `Filled at ${fillingLabel} on ${it.date}`,
      performed_by: performer, performed_at_location: fillingLocationCode,
      // event_at = the fill's day (the real event time); the entry's createdAt records when it was
      // typed. History shows both (Phase 34 item 5).
      event_at: new Date(it.date)
    })));
  } catch (e) { /* non-fatal */ }
}

// Add one filling entry. If a rotational number is given and matches inventory, gas/size are
// auto-filled from the cylinder; otherwise gas_type + capacity must be supplied explicitly.
// Deliberately NO side effects on Cylinder or Bill records (Phase 11 invariant).
async function addEntry(userId, { date, rotational_number, gas_type, capacity }) {
  if (!DAY_RE.test(String(date || ''))) throw new HttpError(400, 'A valid date (YYYY-MM-DD) is required');
  const rot = String(rotational_number || '').trim();
  let gas = String(gas_type || '').trim();
  let cap = String(capacity || '').trim();
  let matched = null;
  if (rot) {
    const cyl = await Cylinder.findOne({ user_id: userId, rotational_number: rot });
    if (cyl) { gas = cyl.gas_type; cap = cyl.capacity; matched = cyl; }
  }
  if (!gas || !cap) throw new HttpError(400, 'Gas type and capacity are required (or a cylinder number that exists in inventory)');
  const entry = await FillingLogEntry.create({ user_id: userId, date, rotational_number: rot, gas_type: gas, capacity: cap });
  if (matched) await logFillHistory(userId, [{ cylinderId: matched._id, rotational_number: rot, date }]);
  return { entry_id: entry._id, gas_type: gas, capacity: cap, message: 'Filling entry recorded' };
}

async function listEntries(userId, date) {
  if (!DAY_RE.test(String(date || ''))) throw new HttpError(400, 'A valid date (YYYY-MM-DD) is required');
  const entries = await FillingLogEntry.find({ user_id: userId, date }).sort('-createdAt');
  // Same-day repeat tracking (Phase 12): a cylinder may legitimately be filled more than once
  // per day (filled → given → returned → filled again). Never blocking — the UI shows an
  // informational badge on the 2nd+ occurrence. repeat_index counts in CHRONOLOGICAL order.
  const seen = {};
  const chrono = [...entries].reverse();
  const indexById = {};
  for (const e of chrono) {
    const key = String(e.rotational_number || '').trim();
    if (!key) continue;
    seen[key] = (seen[key] || 0) + 1;
    indexById[String(e._id)] = seen[key];
  }
  return entries.map(e => {
    const key = String(e.rotational_number || '').trim();
    return {
      entry_id: e._id, date: e.date, rotational_number: e.rotational_number,
      gas_type: e.gas_type, capacity: e.capacity, recorded_at: e.createdAt,
      repeat_index: key ? indexById[String(e._id)] : 1,
      repeat_count: key ? seen[key] : 1
    };
  });
}

// Batch save (Phase 13): commit the FULL staged entry set for one day atomically — replaces
// whatever was previously saved for that date. Also the batch-edit path: the frontend loads
// the day's saved entries into a staged editor and re-saves the whole set. Every entry is
// validated (and auto-filled from inventory) BEFORE anything is deleted, so a bad row never
// wipes the day. Still zero side effects on Cylinder/Bill records.
async function saveDay(userId, { date, entries }) {
  if (!DAY_RE.test(String(date || ''))) throw new HttpError(400, 'A valid date (YYYY-MM-DD) is required');
  if (!Array.isArray(entries)) throw new HttpError(400, 'entries must be an array');

  const docs = [];
  const fills = []; // Phase 33: entries that matched a real cylinder → FILLED history (log-only)
  const seen = new Map();  // rotational_number -> { location, stock_state } for the location check
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i] || {};
    const rot = String(raw.rotational_number || '').trim();
    let gas = String(raw.gas_type || '').trim();
    let cap = String(raw.capacity || '').trim();
    if (rot) {
      const cyl = await Cylinder.findOne({ user_id: userId, rotational_number: rot });
      if (cyl) {
        gas = cyl.gas_type; cap = cyl.capacity;
        fills.push({ cylinderId: cyl._id, rotational_number: rot, date });
        // One entry per serial for the location check, however many times it appears in the list.
        if (!seen.has(rot)) {
          seen.set(rot, { rotational_number: rot, location: cyl.location, stock_state: cyl.stock_state });
        }
      }
    }
    if (!gas || !cap) {
      throw new HttpError(400, `Entry ${i + 1}: gas type and capacity are required (or a cylinder number that exists in inventory)`);
    }
    docs.push({ user_id: userId, date, rotational_number: rot, gas_type: gas, capacity: cap });
  }

  await FillingLogEntry.deleteMany({ user_id: userId, date });
  if (docs.length) await FillingLogEntry.insertMany(docs);
  await logFillHistory(userId, fills);
  return { entries: await listEntries(userId, date), warnings: await locationWarnings(userId, [...seen.values()]) };
}

// ── Does the list match physical reality? ──
// A cylinder can only be filled if it is standing at the filling site. Nothing checked this, so a
// list naming a cylinder that is out with a customer — or sitting at another branch — saved in
// silence and the day's figures quietly disagreed with the yard.
//
// This is a WARNING, never a block (R33): the filling list is a log of what happened, and the
// software's picture of where a cylinder is can itself be the thing that is out of date. Staff get
// told; they decide.
async function locationWarnings(userId, cylinders) {
  const { fillingLocationCode, labels } = await locationService.getUserLocations(userId);
  if (!fillingLocationCode || !cylinders.length) return [];
  const at = (code) => labels[code] || code || 'an unknown site';

  return cylinders
    .filter(c => c.stock_state !== 'IN_STOCK' || c.location !== fillingLocationCode)
    .map(c => ({
      rotational_number: c.rotational_number,
      location: c.location,
      stock_state: c.stock_state,
      message: c.stock_state === 'AT_CUSTOMER'
        ? `Cylinder ${c.rotational_number} is recorded as out with a customer, not at ${at(fillingLocationCode)}.`
        : `Cylinder ${c.rotational_number} is recorded at ${at(c.location)}, not at ${at(fillingLocationCode)}.`
    }));
}

async function deleteEntry(userId, entryId) {
  const r = await FillingLogEntry.deleteOne({ _id: entryId, user_id: userId });
  if (!r.deletedCount) throw new HttpError(404, 'Filling entry not found');
  return { message: 'Filling entry removed' };
}

// Per gas+size fill counts for a day — feeds the Chandisar stock summary's "Filled Today".
async function countsByCombo(userId, date) {
  const entries = await FillingLogEntry.find({ user_id: userId, date });
  const map = {};
  for (const e of entries) {
    const key = `${e.gas_type}|${e.capacity}`;
    map[key] = (map[key] || 0) + 1;
  }
  return map;
}

module.exports = { addEntry, listEntries, saveDay, deleteEntry, countsByCombo };
