const Cylinder = require('../models/Cylinder');
const Bill = require('../models/Bill');
const HttpError = require('../utils/HttpError');
const { normalizeGasTypeIn, normalizeCapacityIn } = require('../config/gasCapacities');
const { getGasCapacities } = require('./masters.service');
const locationService = require('./location.service');
const { insertInBatches } = require('../utils/bulkInsert');

// Human labels for the manual-edit history description.
const STATE_LABEL = { IN_STOCK: 'In Stock', AT_CUSTOMER: 'At Customer' };

// Accept friendly location spellings from forms/imports → one of THIS user's location codes
// (or null if it matches none). GEN-B1: async and registry-driven — the old version hardcoded
// three substring checks, so a CSV naming a fourth site could never resolve.
// Order: exact code, then the location's own label, then a loose contains-match on either. The
// loose pass is what lets a CSV say "chandisar plant" or just "palanpur".
const normKey = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/[\s-]+/g, '_');

// Sync core: matches against an ALREADY-LOADED registry. Bulk callers (CSV import, up to 20k
// rows) must load the registry once and use this, never the async wrapper per row — location
// lookups are deliberately uncached, so one call per row would be one query per row.
function matchLocation(registry, v) {
  const s = normKey(v);
  if (!s) return null;
  const codes = (registry && registry.codes) || [];
  const labels = (registry && registry.labels) || {};

  if (codes.includes(s)) return s;                                  // exact code

  for (const code of codes) {                                       // exact label
    if (normKey(labels[code]) === s) return code;
  }
  for (const code of codes) {                                       // loose contains
    const lab = normKey(labels[code]);
    if (lab && (s.includes(lab) || lab.includes(s))) return code;
    // Also match the distinctive words of the code, e.g. AT_PLANT_CHANDISAR -> PLANT, CHANDISAR.
    const words = code.replace(/^AT_/, '').split('_').filter(w => w.length > 2);
    if (words.some(w => s.includes(w))) return code;
  }
  return null;
}

// Single-row convenience wrapper — loads the registry itself.
async function normalizeLocation(userId, v) {
  return matchLocation(await locationService.getUserLocations(userId), v);
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
async function getAgingReport(uid, { mode, minDays, maxDays, thresholdDays, sortBy, sortOrder, location, search, page, limit, offset }) {
  const cylQuery = { user_id: uid, stock_state: 'AT_CUSTOMER' };
  if (location && (await locationService.isValidLocation(uid, location))) cylQuery.location = location;
  const cylinders = await Cylinder.find(cylQuery).lean();

  const serials = cylinders.map(c => c.rotational_number);
  if (!serials.length) return [];

  // Only the fields the loop and the rows below read (R71 — leaving one out gives wrong numbers,
  // not an error). Whole bills cost about 4.8 MB per run of this report (20 Sep 2026).
  const bills = await Bill.find({
    user_id: uid,
    line_items: { $elemMatch: { direction: 'GIVEN', serial_number: { $in: serials } } }
  }, {
    customer_id: 1, bill_date: 1, createdAt: 1, bill_number: 1, challan_no: 1,
    'line_items.direction': 1, 'line_items.serial_number': 1,
    'line_items.returned_via': 1, 'line_items.rate': 1
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

  // Search across the WHOLE report, not the page on screen: serial, gas, size, site, customer,
  // bill and challan. Applied after the rows are built (the customer name only exists here) and
  // before paging, so a search always looks at every row.
  const q = String(search == null ? '' : search).trim().toLowerCase();
  if (q) {
    rows = rows.filter(r => [r.rotational_number, r.gas_type, r.capacity, r.location,
      r.customer_name, r.bill_number, r.challan_no]
      .some(v => String(v == null ? '' : v).toLowerCase().includes(q)));
  }

  // No page/limit (Excel export, printing) still returns the plain array.
  return require('../utils/paginate').pageComputed(rows, { page, limit, offset });
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

async function listCylinders(uid, { search, stock_state, location, state, page, limit, offset }) {
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
      { gas_type: re },
      { capacity: re }
    ] });
  }

  if (and.length) query.$and = and;

  const { parsePagination, paginatedResponse } = require('../utils/paginate');
  const pg = parsePagination({ page, limit, offset });

  const [docs, total] = await Promise.all([
    Cylinder.find(query).collation(NATURAL).sort('rotational_number').skip(pg.skip).limit(pg.limit).lean(),
    Cylinder.countDocuments(query)
  ]);

  return paginatedResponse(docs, total, pg);
}

// Toggle maintenance. ON requires the cylinder to be IN_STOCK at Chandisar right now
// (backend-enforced, not just hidden in the UI). OFF returns it to plain IN_STOCK there.
// Never touches location/stock_state — those remain owned by the Bill post-save hook.
// ─── Manual-edit history ───
// One place that turns a list of field changes into history rows, shared by the inventory edit
// form and the maintenance endpoint so both read identically in a cylinder's log:
//   "Raju bhai at Chandisar Plant changed Gas Type from Oxygen to Nitrogen"
// "Performed by" is the acting site's Manager Name; when a site has no manager recorded the
// sentence falls back to the site's own label, so the line always names someone or somewhere.
async function logManualEdits(uid, cylinder, diffs, activeLocation) {
  if (!diffs || !diffs.length) return;
  const cylHistory = require('./cylinderHistory.service');
  const { codes, labels } = await locationService.getUserLocations(uid);
  const activeLoc = codes.includes(activeLocation) ? activeLocation : (codes[0] || '');
  const mgrMap = await cylHistory.getManagerMap(uid);
  const performer = mgrMap[activeLoc] || '';
  const who = performer || (labels[activeLoc] || activeLoc);
  const locLabel = labels[activeLoc] || activeLoc;
  const now = new Date();
  await cylHistory.logEvents(diffs.map(d => ({
    user_id: uid, cylinder_id: cylinder._id, rotational_number: cylinder.rotational_number,
    event_type: 'MANUAL_EDIT',
    description: `${who} at ${locLabel} changed ${d.field} from ${d.from} to ${d.to}`,
    from_location: d.from_location || '', to_location: d.to_location || '',
    from_state: d.from_state || '', to_state: d.to_state || '',
    performed_by: performer, performed_at_location: activeLoc, event_at: now
  })));
}

// Servicing happens at ONE designated site — the workshop — chosen per account exactly like the
// filling site (LocationProfile.is_maintenance_location) and independent of it. Two conditions,
// each for its own reason:
//
//   IN_STOCK      a cylinder out with a customer is not in our hands to service, and flagging it
//                 would drop it from that customer's holding with nothing recording a return.
//   at the workshop  the flag must never MOVE a cylinder. Under-maintenance cylinders are still
//                 IN_STOCK, so they sit in their site's Stock Summary anchor; relocating one on
//                 flag would move stock between two sites with no movement in either ledger —
//                 the exact shape of the negative-balance bugs fixed as R136/R137. Requiring the
//                 cylinder to already BE there means the transfer is a real, documented transfer
//                 the reports can see, and maintenance itself stays outside the ledgers entirely.
async function assertMaintainable(uid, cylinder) {
  if (cylinder.stock_state !== 'IN_STOCK') {
    throw new HttpError(400,
      'Only cylinders in stock can be put under maintenance — this one is out with a customer. ' +
      'Receive it back first.');
  }
  const { maintenanceLocationCode, labels } = await locationService.getUserLocations(uid);
  if (!maintenanceLocationCode) {
    throw new HttpError(400,
      'No maintenance location is set for this account. Choose one in Settings → Locations first.');
  }
  if (cylinder.location !== maintenanceLocationCode) {
    const here = labels[cylinder.location] || cylinder.location;
    const shop = labels[maintenanceLocationCode] || maintenanceLocationCode;
    throw new HttpError(400,
      `Cylinders are serviced at ${shop}. "${cylinder.rotational_number}" is at ${here} — ` +
      `transfer it to ${shop} first.`);
  }
}

async function setMaintenance(uid, id, on, activeLocation = '') {
  const cylinder = await Cylinder.findOne({ _id: id, user_id: uid });
  if (!cylinder) throw new HttpError(404, 'Cylinder not found');

  if (on) {
    if (cylinder.under_maintenance) throw new HttpError(400, 'Cylinder is already under maintenance');
    await assertMaintainable(uid, cylinder);
    cylinder.under_maintenance = true;
    cylinder.maintenance_since = new Date();
  } else {
    if (!cylinder.under_maintenance) throw new HttpError(400, 'Cylinder is not under maintenance');
    cylinder.under_maintenance = false;
    cylinder.maintenance_since = null;
  }

  await cylinder.save();

  // The dedicated maintenance endpoint logged nothing at all, so a cylinder could go in and out of
  // maintenance with no trace. Same wording as an edit made through the inventory form.
  try {
    await logManualEdits(uid, cylinder, [{
      field: 'Maintenance',
      from: on ? 'In service' : 'Under maintenance',
      to: on ? 'Under maintenance' : 'In service'
    }], activeLocation);
  } catch (e) { /* non-fatal */ }

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
  // Only the fields the loop below reads. It used to pull every matching bill whole — rates,
  // amounts, challan text, edit history — about 4 MB per call on a real account, for the one
  // question "who holds this serial". The filter, the sort and so the answer are unchanged.
  const bills = await Bill.find({
    user_id: uid,
    line_items: { $elemMatch: { direction: 'GIVEN', serial_number: { $in: serials } } }
  }, {
    customer_id: 1, bill_date: 1, createdAt: 1,
    'line_items.direction': 1, 'line_items.serial_number': 1, 'line_items.returned_via': 1
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

async function createCylinder(uid, { rotational_number, physical_number, gas_type, capacity, location, stock_state, under_maintenance }) {
  if (!rotational_number || !gas_type || !capacity) {
    throw new HttpError(400, 'Rotational number, gas type, and capacity are all required');
  }

  // A location that was supplied but resolves to nothing is an error, not a silent fall back to
  // the default — same rule the CSV import already applied.
  const resolvedLocation = await normalizeLocation(uid, location);
  if (location && String(location).trim() && !resolvedLocation) {
    throw new HttpError(400, `Unknown location "${location}"`);
  }

  const cylinder = new Cylinder({
    user_id: uid,
    rotational_number,
    physical_number: (physical_number && physical_number.trim()) ? physical_number.trim() : undefined,
    gas_type,
    capacity,
    // Blank column → this account's own first site, never a compiled-in plant name.
    location: resolvedLocation || await locationService.defaultLocationCode(uid),
    stock_state: normalizeStockState(stock_state) || 'IN_STOCK',
    under_maintenance: !!under_maintenance,
    maintenance_since: under_maintenance ? new Date() : null
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
  // Loaded ONCE for the whole file — see matchLocation.
  const locRegistry = await locationService.getUserLocations(uid);
  // Rows that leave the location column blank land at this account's own first site.
  const defaultLoc = locRegistry.codes[0] || '';

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

    const loc = matchLocation(locRegistry, r.location);
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
        location: loc || defaultLoc,
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
  const allowed = ['rotational_number', 'physical_number', 'gas_type', 'capacity', 'location', 'stock_state', 'under_maintenance'];
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
  if (updates.under_maintenance !== undefined) {
    updates.under_maintenance = !!updates.under_maintenance;
    updates.maintenance_since = updates.under_maintenance ? new Date() : null;
  }
  const mutation = Object.keys(unset).length ? { $set: updates, $unset: unset } : updates;

  // Read the pre-edit doc once — used both by the type-edit gate (Phase 9) and by the
  // manual-edit history log (Phase 33), which needs the old location/stock_state values.
  const before = await Cylinder.findOne({ _id: id, user_id: uid });
  if (!before) throw new HttpError(404, 'Cylinder not found');

  // ─── Location validity (GEN-B1) ───
  // Until GEN-B1 the schema enum was the ONLY thing rejecting a bogus location here — this
  // function passes `location` straight through to the update. With the enum gone, the check has
  // to live here, or any string at all would be written to a cylinder.
  if (updates.location !== undefined) {
    if (!(await locationService.isValidLocation(uid, updates.location))) {
      throw new HttpError(400, `Unknown location "${updates.location}"`);
    }
  }

  // ─── Maintenance gate ───
  // updateCylinder accepted `under_maintenance` as a plain field, so the edit form could flag a
  // cylinder anywhere while the dedicated endpoint refused — the same rule enforced in one place
  // and not the other. Turning it OFF stays ungated: a cylinder already flagged must always be
  // returnable to service, including one flagged before the workshop moved.
  if (updates.under_maintenance === true && !before.under_maintenance) {
    await assertMaintainable(uid, before);
  }

  // ─── Gas-type / capacity edit gate (Phase 9) ───
  // Same gate as the maintenance toggle: the cylinder must be IN_STOCK at the filling location.
  // Historical bills are unaffected either way — their line items carry name snapshots.
  if (updates.gas_type !== undefined || updates.capacity !== undefined) {
    const changingType = (updates.gas_type !== undefined && updates.gas_type !== before.gas_type) ||
                         (updates.capacity !== undefined && updates.capacity !== before.capacity);
    if (changingType) {
      const { fillingLocationCode, labels } = await locationService.getUserLocations(uid);
      const where = fillingLocationCode ? (labels[fillingLocationCode] || fillingLocationCode) : 'the filling location';
      if (!fillingLocationCode || before.location !== fillingLocationCode || before.stock_state !== 'IN_STOCK') {
        throw new HttpError(400, `Gas type / capacity can only be changed while the cylinder is In Stock at ${where}.`);
      }
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

  // ─── Log manual edits (never via a transaction) ───
  // Phase 33 logged Location and Stock State. Those are unchanged; Gas Type, Size and Maintenance
  // are logged too, so a cylinder's history explains every deliberate change made to it and not
  // just the ones that moved it. Purely additive; a logging failure never fails the edit.
  try {
    const { labels } = await locationService.getUserLocations(uid);
    const diffs = [];
    if (updates.location !== undefined && cylinder.location !== before.location) {
      diffs.push({
        field: 'Location',
        from: labels[before.location] || before.location,
        to: labels[cylinder.location] || cylinder.location,
        from_location: before.location, to_location: cylinder.location
      });
    }
    if (updates.stock_state !== undefined && cylinder.stock_state !== before.stock_state) {
      diffs.push({
        field: 'Stock State',
        from: STATE_LABEL[before.stock_state] || before.stock_state,
        to: STATE_LABEL[cylinder.stock_state] || cylinder.stock_state,
        from_state: before.stock_state, to_state: cylinder.stock_state
      });
    }
    // Gas Type and Size are gated to In Stock at the filling site (above), so a change here is
    // always a deliberate re-designation of the cylinder — exactly the thing that must be on record.
    if (updates.gas_type !== undefined && cylinder.gas_type !== before.gas_type) {
      diffs.push({ field: 'Gas Type', from: before.gas_type || '(none)', to: cylinder.gas_type || '(none)' });
    }
    if (updates.capacity !== undefined && cylinder.capacity !== before.capacity) {
      diffs.push({ field: 'Size', from: before.capacity || '(none)', to: cylinder.capacity || '(none)' });
    }
    if (updates.under_maintenance !== undefined && !!cylinder.under_maintenance !== !!before.under_maintenance) {
      diffs.push({
        field: 'Maintenance',
        from: before.under_maintenance ? 'Under maintenance' : 'In service',
        to: cylinder.under_maintenance ? 'Under maintenance' : 'In service'
      });
    }

    await logManualEdits(uid, cylinder, diffs, body.active_location);
  } catch (e) { /* non-fatal */ }

  return { cylinder_id: cylinder._id, message: 'Cylinder updated successfully' };
}

async function deleteCylinder(uid, id) {
  const result = await Cylinder.deleteOne({ _id: id, user_id: uid });
  if (result.deletedCount === 0) throw new HttpError(404, 'Cylinder not found');
  return { message: 'Cylinder deleted successfully' };
}

module.exports = {
  // Exported for tests and for bulk callers that resolve many rows against one loaded registry.
  matchLocation,
  normalizeLocation,
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
