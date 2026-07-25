const FillingLogEntry = require('../models/FillingLogEntry');
const Cylinder = require('../models/Cylinder');
const HttpError = require('../utils/HttpError');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Add one filling entry. If a rotational number is given and matches inventory, gas/size are
// auto-filled from the cylinder; otherwise gas_type + capacity must be supplied explicitly.
// Deliberately NO side effects on Cylinder or Bill records (Phase 11 invariant).
async function addEntry(userId, { date, rotational_number, gas_type, capacity }) {
  if (!DAY_RE.test(String(date || ''))) throw new HttpError(400, 'A valid date (YYYY-MM-DD) is required');
  const rot = String(rotational_number || '').trim();
  let gas = String(gas_type || '').trim();
  let cap = String(capacity || '').trim();
  if (rot) {
    const cyl = await Cylinder.findOne({ user_id: userId, rotational_number: rot });
    if (cyl) { gas = cyl.gas_type; cap = cyl.capacity; }
  }
  if (!gas || !cap) throw new HttpError(400, 'Gas type and capacity are required (or a cylinder number that exists in inventory)');
  const entry = await FillingLogEntry.create({ user_id: userId, date, rotational_number: rot, gas_type: gas, capacity: cap });
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
  for (let i = 0; i < entries.length; i++) {
    const raw = entries[i] || {};
    const rot = String(raw.rotational_number || '').trim();
    let gas = String(raw.gas_type || '').trim();
    let cap = String(raw.capacity || '').trim();
    if (rot) {
      const cyl = await Cylinder.findOne({ user_id: userId, rotational_number: rot });
      if (cyl) { gas = cyl.gas_type; cap = cyl.capacity; }
    }
    if (!gas || !cap) {
      throw new HttpError(400, `Entry ${i + 1}: gas type and capacity are required (or a cylinder number that exists in inventory)`);
    }
    docs.push({ user_id: userId, date, rotational_number: rot, gas_type: gas, capacity: cap });
  }

  await FillingLogEntry.deleteMany({ user_id: userId, date });
  if (docs.length) await FillingLogEntry.insertMany(docs);
  return listEntries(userId, date);
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
