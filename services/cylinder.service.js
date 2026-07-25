const Cylinder = require('../models/Cylinder');
const Bill = require('../models/Bill');
const HttpError = require('../utils/HttpError');
const { normalizeGasTypeIn, normalizeCapacityIn } = require('../config/gasCapacities');
const { getGasCapacities } = require('./masters.service');
const { LOCATIONS } = require('../config/locations');
const { insertInBatches } = require('../utils/bulkInsert');

// Accept friendly location spellings from forms/imports → canonical enum (or null if invalid).
function normalizeLocation(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (LOCATIONS.includes(s)) return s;
  if (s.includes('CHANDISAR') || s.includes('PLANT')) return 'AT_PLANT_CHANDISAR';
  if (s.includes('PALANPUR')) return 'AT_PALANPUR_OFFICE';
  if (s.includes('CHHAPI')) return 'AT_CHHAPI_OFFICE';
  return null;
}

// Accept friendly stock-state spellings → canonical enum (or null if invalid).
function normalizeStockState(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (s === 'IN_STOCK' || s === 'INSTOCK' || s === 'STOCK') return 'IN_STOCK';
  if (s === 'AT_CUSTOMER' || s === 'CUSTOMER' || s === 'WITH_CUSTOMER') return 'AT_CUSTOMER';
  return null;
}

// Cylinder Aging Report — every at-customer cylinder joined with its latest "Given" record.
// `location` (optional) restricts to cylinders issued from that site — the days-held
// calculation itself is untouched; this only narrows which rows are returned.
async function getAgingReport(uid, { mode, minDays, maxDays, thresholdDays, sortBy, sortOrder, location }) {
  const cylQuery = { user_id: uid, stock_state: 'AT_CUSTOMER' };
  if (location && LOCATIONS.includes(location)) cylQuery.location = location;
  const cylinders = await Cylinder.find(cylQuery).lean();

  const serials = cylinders.map(c => c.rotational_number);
  if (!serials.length) return [];

  const bills = await Bill.find({
    user_id: uid,
    line_items: { $elemMatch: { direction: 'GIVEN', serial_number: { $in: serials } } }
  })
    .populate('customer_id', 'company_name phone_primary address')
    .sort('-bill_date -createdAt')
    .lean();

  const latestGiven = {};
  for (const bill of bills) {
    for (const li of bill.line_items) {
      if (li.direction === 'GIVEN' && !li.returned_via && latestGiven[li.serial_number] === undefined) {
        latestGiven[li.serial_number] = { bill, line: li };
      }
    }
  }

  const now = Date.now();
  const daysBetween = (d) => Math.floor((now - new Date(d).getTime()) / 86400000);

  let rows = cylinders.map(c => {
    const rec = latestGiven[c.rotational_number];
    if (!rec) {
      // Edge case: cylinder is in-rotation but no matching GIVEN transaction was found.
      return {
        rotational_number: c.rotational_number,
        gas_type: c.gas_type,
        capacity: c.capacity,
        location: c.location,
        customer_id: null,
        customer_name: null,
        customer_phone: null,
        customer_address: null,
        date_given: null,
        days_out: null,
        bill_number: null,
        challan_no: null,
        rate: null,
        no_given_record: true
      };
    }
    const cust = rec.bill.customer_id || {};
    return {
      rotational_number: c.rotational_number,
      gas_type: c.gas_type,
      capacity: c.capacity,
      location: c.location,
      customer_id: cust._id ? String(cust._id) : null,
      customer_name: cust.company_name || null,
      customer_phone: cust.phone_primary || null,
      customer_address: cust.address || null,
      date_given: rec.bill.bill_date,
      days_out: daysBetween(rec.bill.bill_date),
      bill_number: rec.bill.bill_number,
      challan_no: rec.bill.challan_no || '',
      rate: rec.line.rate || 0,
      no_given_record: false
    };
  });

  // Day filter (only applied to rows that have a date; anomaly rows are always kept so they surface)
  const min = minDays !== undefined && minDays !== '' ? Number(minDays) : null;
  const max = maxDays !== undefined && maxDays !== '' ? Number(maxDays) : null;
  const threshold = thresholdDays !== undefined && thresholdDays !== '' ? Number(thresholdDays) : null;

  rows = rows.filter(r => {
    if (r.days_out === null) return true; // keep anomalies
    if (mode === 'gte') {
      if (threshold !== null && r.days_out < threshold) return false;
    } else if (mode === 'range') {
      if (min !== null && r.days_out < min) return false;
      if (max !== null && r.days_out > max) return false;
    }
    return true;
  });

  // Sorting (null day values always sort last)
  const order = sortOrder === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    if (sortBy === 'customer') {
      const an = (a.customer_name || '').toLowerCase();
      const bn = (b.customer_name || '').toLowerCase();
      if (an === bn) return 0;
      return an < bn ? -order : order;
    }
    // default: daysOut
    if (a.days_out === null) return 1;
    if (b.days_out === null) return -1;
    return (a.days_out - b.days_out) * order;
  });

  return rows;
}

// Rotational numbers are plain numbers ("1", "2", "100"), so listings must sort numerically
// (1, 2, 6, 10, 100 — not 1, 10, 100, 2). Mongo's numericOrdering collation does this server-side.
const NATURAL = { locale: 'en', numericOrdering: true };

// Filters:
//   location — comma-separated multi-select (e.g. "AT_PLANT_CHANDISAR,AT_CHHAPI_OFFICE")
//   state    — comma-separated multi-select of IN_STOCK | AT_CUSTOMER | UNDER_MAINTENANCE.
//              The three are disjoint views: IN_STOCK excludes maintenance cylinders,
//              UNDER_MAINTENANCE is the independent maintenance flag.
//   stock_state — legacy single-value param, still honored (maps onto `state`).
function stateClause(s) {
  if (s === 'UNDER_MAINTENANCE') return { under_maintenance: true };
  if (s === 'IN_STOCK') return { stock_state: 'IN_STOCK', under_maintenance: { $ne: true } };
  if (s === 'AT_CUSTOMER') return { stock_state: 'AT_CUSTOMER' };
  return null;
}

async function listCylinders(uid, { search, stock_state, location, state, page, limit }) {
  const query = { user_id: uid };
  const and = [];

  const locations = String(location || '').split(',').map(s => s.trim()).filter(Boolean);
  if (locations.length) query.location = { $in: locations };

  const states = String(state || stock_state || '').split(',').map(s => s.trim()).filter(Boolean);
  const clauses = states.map(stateClause).filter(Boolean);
  if (clauses.length === 1) and.push(clauses[0]);
  else if (clauses.length > 1) and.push({ $or: clauses });

  if (search) {
    const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({ $or: [
      { rotational_number: re },
      { physical_number: re },
      { gas_type: re }
    ] });
  }

  if (and.length) query.$and = and;

  const { parsePagination, paginatedResponse } = require('../utils/paginate');
  const pg = parsePagination({ page, limit });

  const [docs, total] = await Promise.all([
    Cylinder.find(query).collation(NATURAL).sort('rotational_number').skip(pg.skip).limit(pg.limit).lean(),
    Cylinder.countDocuments(query)
  ]);

  return paginatedResponse(docs, total, pg);
}

// Toggle maintenance. ON requires the cylinder to be IN_STOCK at Chandisar right now
// (backend-enforced, not just hidden in the UI). OFF returns it to plain IN_STOCK there.
// Never touches location/stock_state — those remain owned by the Bill post-save hook.
async function setMaintenance(uid, id, on) {
  const cylinder = await Cylinder.findOne({ _id: id, user_id: uid });
  if (!cylinder) throw new HttpError(404, 'Cylinder not found');

  if (on) {
    if (cylinder.under_maintenance) throw new HttpError(400, 'Cylinder is already under maintenance');
    if (cylinder.stock_state !== 'IN_STOCK' || cylinder.location !== 'AT_PLANT_CHANDISAR') {
      throw new HttpError(400, 'Only cylinders in stock at Chandisar Plant can be put under maintenance');
    }
    cylinder.under_maintenance = true;
    cylinder.maintenance_since = new Date();
  } else {
    if (!cylinder.under_maintenance) throw new HttpError(400, 'Cylinder is not under maintenance');
    cylinder.under_maintenance = false;
    cylinder.maintenance_since = null;
  }

  await cylinder.save();
  return {
    cylinder_id: cylinder._id,
    under_maintenance: cylinder.under_maintenance,
    maintenance_since: cylinder.maintenance_since,
    message: on ? 'Cylinder moved to maintenance' : 'Cylinder returned to stock'
  };
}

// All cylinders currently AT_CUSTOMER (out with customers), each annotated with its CURRENT holder
// (the customer of its most recent not-yet-returned GIVEN line). Used for the "Received" / swap-return
// dropdown and for client-side cross-customer mismatch detection.
async function listInRotation(uid) {
  const inRotation = await Cylinder.find({ user_id: uid, stock_state: 'AT_CUSTOMER' }).collation(NATURAL).sort('rotational_number').lean();
  if (!inRotation.length) return [];

  const serials = inRotation.map(c => c.rotational_number);
  const bills = await Bill.find({
    user_id: uid,
    line_items: { $elemMatch: { direction: 'GIVEN', serial_number: { $in: serials } } }
  })
    .populate('customer_id', 'company_name')
    .sort('-bill_date -createdAt')
    .lean();

  const holder = {};
  for (const bill of bills) {
    for (const li of bill.line_items) {
      if (li.direction === 'GIVEN' && !li.returned_via && holder[li.serial_number] === undefined) {
        holder[li.serial_number] = bill.customer_id || null;
      }
    }
  }

  return inRotation.map(c => ({
    ...c,
    holder_id: holder[c.rotational_number] ? String(holder[c.rotational_number]._id) : null,
    holder_name: holder[c.rotational_number] ? holder[c.rotational_number].company_name : null
  }));
}

async function getCylinder(uid, id) {
  const cylinder = await Cylinder.findOne({ _id: id, user_id: uid });
  if (!cylinder) throw new HttpError(404, 'Cylinder not found');
  return cylinder;
}

function translateDuplicateKeyError(error) {
  if (error.code === 11000) {
    const field = Object.keys(error.keyPattern || {}).find(k => k !== 'user_id') || 'number';
    const label = field === 'physical_number' ? 'physical number' : 'rotational number';
    return new HttpError(400, `A cylinder with this ${label} already exists`);
  }
  return null;
}

async function createCylinder(uid, { rotational_number, physical_number, gas_type, capacity, location, stock_state }) {
  if (!rotational_number || !gas_type || !capacity) {
    throw new HttpError(400, 'Rotational number, gas type, and capacity are all required');
  }

  const cylinder = new Cylinder({
    user_id: uid,
    rotational_number,
    // physical_number is optional; store undefined when blank so the partial unique index ignores it
    physical_number: (physical_number && physical_number.trim()) ? physical_number.trim() : undefined,
    gas_type,
    capacity,
    location: normalizeLocation(location) || 'AT_PLANT_CHANDISAR',
    stock_state: normalizeStockState(stock_state) || 'IN_STOCK'
  });

  try {
    await cylinder.save();
  } catch (error) {
    throw translateDuplicateKeyError(error) || error;
  }

  return { cylinder_id: cylinder._id, message: 'Cylinder added successfully' };
}

// ─── One-time bulk import (onboarding) ───
// rows: [{ __row, rotational_number, physical_number, gas_type, capacity, location, stock_state }].
// Re-validated server-side: required fields, valid gas_type + capacity-for-gas, in-file uniqueness.
// Inserts scoped to uid; duplicates vs existing records are reported as `skipped`.
async function importCylinders(uid, rows) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new HttpError(400, 'No rows to import');
  }

  const str = (v) => String(v == null ? '' : v).trim();

  // Live user-managed catalog (Phase 10) — not the static config seed.
  const catalog = await getGasCapacities();

  const items = [];
  const failed = [];
  const seenRot = new Set();
  const seenPhy = new Set();

  rows.forEach((r, i) => {
    const row = r.__row || (i + 2);
    const rotational_number = str(r.rotational_number);
    const physical_number = str(r.physical_number);
    if (!rotational_number) { failed.push({ row, reason: 'rotational_number is required' }); return; }

    const gas = normalizeGasTypeIn(catalog, r.gas_type);
    if (!gas) { failed.push({ row, reason: `Invalid gas_type "${str(r.gas_type)}"` }); return; }
    const capacity = normalizeCapacityIn(catalog, gas, r.capacity);
    if (!capacity) { failed.push({ row, reason: `Invalid capacity "${str(r.capacity)}" for ${gas}` }); return; }

    const rotKey = rotational_number.toLowerCase();
    if (seenRot.has(rotKey)) { failed.push({ row, reason: `Duplicate rotational_number "${rotational_number}" within file` }); return; }
    seenRot.add(rotKey);
    if (physical_number) {
      const phyKey = physical_number.toLowerCase();
      if (seenPhy.has(phyKey)) { failed.push({ row, reason: `Duplicate physical_number "${physical_number}" within file` }); return; }
      seenPhy.add(phyKey);
    }

    const loc = normalizeLocation(r.location);
    if (str(r.location) && !loc) { failed.push({ row, reason: `Invalid location "${str(r.location)}"` }); return; }
    const stock = normalizeStockState(r.stock_state);
    if (str(r.stock_state) && !stock) { failed.push({ row, reason: `Invalid stock_state "${str(r.stock_state)}"` }); return; }

    items.push({
      __row: row,
      doc: {
        user_id: uid,
        rotational_number,
        physical_number: physical_number || undefined, // omit so the partial unique index ignores it
        gas_type: gas,
        capacity,
        location: loc || 'AT_PLANT_CHANDISAR',
        stock_state: stock || 'IN_STOCK'
      }
    });
  });

  const result = await insertInBatches(Cylinder, items);
  return {
    created: result.created,
    skipped: result.skipped,
    failed: [...failed, ...result.failed]
  };
}

async function updateCylinder(uid, id, body) {
  const allowed = ['rotational_number', 'physical_number', 'gas_type', 'capacity', 'location', 'stock_state'];
  const updates = {};
  const unset = {};
  allowed.forEach(field => {
    if (body[field] !== undefined) updates[field] = body[field];
  });
  // physical_number is optional: clearing it removes the field so the partial unique index ignores it
  if (updates.physical_number !== undefined && !String(updates.physical_number).trim()) {
    delete updates.physical_number;
    unset.physical_number = '';
  } else if (updates.physical_number !== undefined) {
    updates.physical_number = String(updates.physical_number).trim();
  }
  const mutation = Object.keys(unset).length ? { $set: updates, $unset: unset } : updates;

  // ─── Gas-type / capacity edit gate (Phase 9) ───
  // Same gate as the maintenance toggle: the cylinder must be IN_STOCK at Chandisar Plant.
  // Historical bills are unaffected either way — their line items carry name snapshots.
  if (updates.gas_type !== undefined || updates.capacity !== undefined) {
    const current = await Cylinder.findOne({ _id: id, user_id: uid });
    if (!current) throw new HttpError(404, 'Cylinder not found');
    const changingType = (updates.gas_type !== undefined && updates.gas_type !== current.gas_type) ||
                         (updates.capacity !== undefined && updates.capacity !== current.capacity);
    if (changingType && (current.location !== 'AT_PLANT_CHANDISAR' || current.stock_state !== 'IN_STOCK')) {
      throw new HttpError(400, 'Gas type / capacity can only be changed while the cylinder is In Stock at Chandisar Plant.');
    }
  }

  let cylinder;
  try {
    cylinder = await Cylinder.findOneAndUpdate(
      { _id: id, user_id: uid },
      mutation,
      { new: true, runValidators: true }
    );
  } catch (error) {
    throw translateDuplicateKeyError(error) || error;
  }

  if (!cylinder) throw new HttpError(404, 'Cylinder not found');
  return { cylinder_id: cylinder._id, message: 'Cylinder updated successfully' };
}

async function deleteCylinder(uid, id) {
  const result = await Cylinder.deleteOne({ _id: id, user_id: uid });
  if (result.deletedCount === 0) throw new HttpError(404, 'Cylinder not found');
  return { message: 'Cylinder deleted successfully' };
}

module.exports = {
  getAgingReport,
  listCylinders,
  setMaintenance,
  listInRotation,
  getCylinder,
  createCylinder,
  importCylinders,
  updateCylinder,
  deleteCylinder
};
