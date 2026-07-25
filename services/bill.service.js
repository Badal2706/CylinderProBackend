const Bill = require('../models/Bill');
const Customer = require('../models/Customer');
const Cylinder = require('../models/Cylinder');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const HttpError = require('../utils/HttpError');
const { LOCATIONS, LOCATION_LABELS } = require('../config/locations');
const { computeHoldings } = require('./holdings.service');
const { recomputeLocationPcStock } = require('./pcStock.service');
const audit = require('./audit.service');

// Edit/Delete window (Phase 5): bills are mutable for 3 days from their CREATION timestamp
// (createdAt — not the transaction date typed on the bill). bill_number stays editable forever.
const EDIT_WINDOW_MS = 3 * 86400000;
const isLocked = (bill) => (Date.now() - new Date(bill.createdAt).getTime()) > EDIT_WINDOW_MS;

// ─── Personal cylinders (quantity-only) ───
// personalCylindersIn/Out on each line item are the customer's OWN cylinders (not our inventory).
// Net contribution of a set of line items to "held at plant" = sum(In) − sum(Out).
function billPersonalDelta(lineItems) {
  return (lineItems || []).reduce(
    (s, li) => s + (Number(li.personalCylindersIn) || 0) - (Number(li.personalCylindersOut) || 0), 0);
}
// Total personal cylinders we hold for a customer across ALL their bills (optionally excluding one,
// e.g. the bill currently being edited, whose new value is added separately).
async function totalPersonalForCustomer(owner, customerId, excludeBillId) {
  const bills = await Bill.find({ user_id: owner, customer_id: customerId }, { line_items: 1 });
  let t = 0;
  for (const b of bills) {
    if (excludeBillId && String(b._id) === String(excludeBillId)) continue;
    t += billPersonalDelta(b.line_items);
  }
  return t;
}

// ─── Per gas+size personal-cylinder balances (Phase 11) ───
// PC returns must be validated per gas+size combination — a customer's Nitrogen 6 m3 PC
// balance can never cover a Nitrogen 7 m3 return. Keys use the line-item name snapshots.
const pcComboKey = (li) => `${li.gas_type_name || ''}|${li.size_label || ''}`;
function billPersonalDeltaByCombo(lineItems, map = {}) {
  for (const li of lineItems || []) {
    const d = (Number(li.personalCylindersIn) || 0) - (Number(li.personalCylindersOut) || 0);
    if (!d) continue;
    const key = pcComboKey(li);
    map[key] = (map[key] || 0) + d;
  }
  return map;
}
async function personalByComboForCustomer(owner, customerId, excludeBillId) {
  const bills = await Bill.find({ user_id: owner, customer_id: customerId }, { line_items: 1 });
  const map = {};
  for (const b of bills) {
    if (excludeBillId && String(b._id) === String(excludeBillId)) continue;
    billPersonalDeltaByCombo(b.line_items, map);
  }
  return map;
}
// Recompute a customer's running at-plant PC count from all their bills. Clamped at 0 for
// regular customers; filling vendors keep the raw (possibly negative) value — negative means
// that many personal cylinders are currently WITH the vendor (Phase 11).
async function syncPersonalCount(owner, customerId) {
  const cust = await Customer.findOne({ _id: customerId, user_id: owner });
  if (!cust) return;
  const t = await totalPersonalForCustomer(owner, customerId);
  await Customer.updateOne({ _id: cust._id }, { personalCylindersAtPlant: cust.is_filling_vendor ? t : Math.max(0, t) });
}

// Throws unless every combo's balance stays ≥ 0 (regular customers).
// Filling vendors (Phase 16) get the MIRROR check: their balance may go negative (= PC
// currently with the vendor) but never POSITIVE — "Received Back Filled" cannot exceed the
// PC outstanding with that vendor for the combo (earlier bills + sent on this bill).
async function assertPersonalPerCombo(owner, customerId, newLines, excludeBillId, isVendor) {
  const base = await personalByComboForCustomer(owner, customerId, excludeBillId);
  const delta = billPersonalDeltaByCombo(newLines);
  if (isVendor) {
    // Per-combo pcIn/pcOut of THIS bill, for a precise error message.
    const inMap = {}, outMap = {};
    for (const li of newLines || []) {
      const key = pcComboKey(li);
      inMap[key] = (inMap[key] || 0) + (Number(li.personalCylindersIn) || 0);
      outMap[key] = (outMap[key] || 0) + (Number(li.personalCylindersOut) || 0);
    }
    for (const [key, d] of Object.entries(delta)) {
      const have = base[key] || 0; // ≤ 0 normally; −have = outstanding with the vendor
      if (have + d > 0) {
        const [g, s] = key.split('|');
        const outstanding = Math.max(0, -have);
        const sentNow = outMap[key] || 0;
        throw new HttpError(400,
          `Cannot receive back ${inMap[key] || 0} personal ${g} ${s} cylinder(s) — only ` +
          `${outstanding + sentNow} are with this filling vendor (${outstanding} outstanding from ` +
          `earlier bills + ${sentNow} sent on this bill).`);
      }
    }
    return;
  }
  for (const [key, d] of Object.entries(delta)) {
    const have = base[key] || 0;
    if (have + d < 0) {
      const [g, s] = key.split('|');
      throw new HttpError(400,
        `Cannot return ${-d} personal ${g} ${s} cylinder(s) — this customer only has ${have} of that exact type at the plant.`);
    }
  }
}

// Bill numbers are globally sequential (not per-user). bill_number is user-editable,
// so derive the next sequence from the highest existing BILL-#### value (custom-format
// numbers are ignored) instead of trusting the most recent bill.
async function generateBillNumber() {
  const result = await Bill.aggregate([
    { $match: { bill_number: /^BILL-\d+$/ } },
    { $project: { num: { $toInt: { $arrayElemAt: [{ $split: ['$bill_number', '-'] }, 1] } } } },
    { $group: { _id: null, max: { $max: '$num' } } }
  ]);
  const maxId = (result.length && result[0].max) || 0;
  return `BILL-${String(maxId + 1).padStart(4, '0')}`;
}

// Find the current holder of a cylinder = the most recent GIVEN line for that rotational number
// that has NOT yet been marked returned. Returns { bill, line } (bill.customer_id populated) or null.
// excludeBillId skips the just-created bill (so a swap round-trip's own GIVEN line isn't treated as the holder).
async function findCurrentGiven(userId, serial, excludeBillId) {
  const query = {
    user_id: userId,
    line_items: { $elemMatch: { direction: 'GIVEN', serial_number: serial, returned_via: null } }
  };
  if (excludeBillId) query._id = { $ne: excludeBillId };
  const bills = await Bill.find(query)
    .populate('customer_id', 'company_name _id')
    .sort('-bill_date -createdAt')
    .limit(5);

  for (const b of bills) {
    const line = b.line_items.find(li =>
      li.direction === 'GIVEN' && li.serial_number === serial && !li.returned_via);
    if (line) return { bill: b, line };
  }
  return null;
}

// How many of a new bill's received serials net against THIS customer's own holding.
// A serial currently held by a different customer becomes a cross-customer return
// (returned_on_behalf_of) at save time and reduces the HOLDER's count, not this customer's.
async function countOwnReturns(userId, customerId, received_items) {
  let own = 0;
  for (const item of received_items || []) {
    for (const s of item.serial_numbers || []) {
      const holderRec = await findCurrentGiven(userId, String(s).trim(), null);
      const holder = holderRec && holderRec.bill.customer_id;
      if (!holder || String(holder._id) === String(customerId)) own++;
    }
  }
  return own;
}

// ─── Real-time per-cylinder validation (Edit Bill popup + New Transaction form) ───
// Returns: { valid, warningOnly, message, heldBy?: { customerName, billNo } }
//
// Edit context differs from a brand-new transaction: a cylinder that is already on the bill being
// edited (same direction) is correctly in its current status BECAUSE of this bill, so it is exempt
// from re-validation. Only newly-added cylinders are checked.
async function validateCylinder(uid, { cylinderNo, direction, transactionId, customerId, location }) {
  const rot = String(cylinderNo || '').trim();
  if (!rot) return { valid: true };

  const cyl = await Cylinder.findOne({ user_id: uid, rotational_number: rot });
  if (!cyl) return { valid: true }; // not in inventory → manual/personal cylinder, skip

  // Original-bill exemption: a cylinder already on this bill (same direction) needs no re-check.
  let editingBill = null;
  if (transactionId) {
    editingBill = await Bill.findOne({ _id: transactionId, user_id: uid });
    if (editingBill) {
      const dirUpper = direction === 'received' ? 'RECEIVED' : 'GIVEN';
      const inOriginal = editingBill.line_items.some(li => li.direction === dirUpper && li.serial_number === rot);
      if (inOriginal) return { valid: true };
    }
  }

  const billCustomerId = editingBill ? String(editingBill.customer_id) : (customerId ? String(customerId) : null);
  // Location the transaction happens at: from the bill being edited, else from the request.
  const billLocation = editingBill ? editingBill.location : (LOCATIONS.includes(location) ? location : null);

  if (direction === 'given') {
    if (cyl.stock_state === 'IN_STOCK') {
      if (cyl.under_maintenance) {
        return {
          valid: false,
          warningOnly: false,
          message: `${rot} is under maintenance and cannot be given out until it is returned to stock.`
        };
      }
      // Location-scoped availability: a cylinder can only be given from the site it is at.
      if (billLocation && cyl.location !== billLocation) {
        return {
          valid: false,
          warningOnly: false,
          message: `${rot} is in stock at ${LOCATION_LABELS[cyl.location] || cyl.location} — it cannot be given from ${LOCATION_LABELS[billLocation]}. Transfer it first.`
        };
      }
      return { valid: true }; // will be set AT_CUSTOMER on save
    }
    // AT_CUSTOMER → blocked only if ANOTHER bill currently holds it (excluding the bill being edited).
    const holderRec = await findCurrentGiven(uid, rot, transactionId || null);
    if (holderRec && holderRec.bill && holderRec.bill.customer_id) {
      const h = holderRec.bill.customer_id;
      return {
        valid: false,
        warningOnly: false,
        message: `${rot} is currently held by ${h.company_name} (${holderRec.bill.bill_number}). Cannot add until returned.`,
        heldBy: { customerName: h.company_name, billNo: holderRec.bill.bill_number }
      };
    }
    // AT_CUSTOMER but no other open holder → held by this bill (or orphaned); giving it here is fine.
    return { valid: true };
  }

  // direction === 'received'
  if (cyl.stock_state === 'IN_STOCK') {
    return {
      valid: false,
      warningOnly: false,
      message: `${rot} is currently in stock (${LOCATION_LABELS[cyl.location] || cyl.location}) — it hasn't been given out, so it cannot be received.`
    };
  }
  // AT_CUSTOMER → allowed; if held by a DIFFERENT customer than this bill, it's a cross-customer return (warning).
  const holderRec = await findCurrentGiven(uid, rot, transactionId || null);
  if (holderRec && holderRec.bill && holderRec.bill.customer_id) {
    const h = holderRec.bill.customer_id;
    if (billCustomerId && String(h._id) !== billCustomerId) {
      // Filling-vendor bills have NO cross-customer return path (Phase 15): "Received Back
      // Filled" may only contain cylinders currently with this same vendor — hard block.
      const billCust = await Customer.findOne({ _id: billCustomerId, user_id: uid });
      if (billCust && billCust.is_filling_vendor) {
        return {
          valid: false,
          warningOnly: false,
          message: `${rot} is currently held by ${h.company_name}, not by this filling vendor — only cylinders with this vendor (or sent for filling on this bill) can be received back.`,
          heldBy: { customerName: h.company_name, billNo: holderRec.bill.bill_number }
        };
      }
      return {
        valid: true,
        warningOnly: true,
        message: `${rot} is currently held by ${h.company_name} — this will be recorded as returned on their behalf.`,
        heldBy: { customerName: h.company_name, billNo: holderRec.bill.bill_number }
      };
    }
  }
  return { valid: true };
}

async function listBills(userId, { date, customer_id, page, limit }) {
  const query = { user_id: userId, is_draft: { $ne: true } };

  if (date) {
    const startDate = new Date(date);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);
    query.bill_date = { $gte: startDate, $lte: endDate };
  }

  if (customer_id) {
    query.customer_id = customer_id;
  }

  const { parsePagination, paginatedResponse } = require('../utils/paginate');
  const pg = parsePagination({ page, limit });

  const [bills, total] = await Promise.all([
    Bill.find(query)
      .populate('customer_id', 'company_name phone_primary')
      .sort('-bill_date -createdAt')
      .skip(pg.skip)
      .limit(pg.limit)
      .lean(),
    Bill.countDocuments(query)
  ]);

  const data = bills.map(bill => ({
    ...bill,
    company_name: bill.customer_id ? bill.customer_id.company_name : 'Internal Transfer',
    phone_primary: bill.customer_id ? bill.customer_id.phone_primary : ''
  }));

  return paginatedResponse(data, total, pg);
}

async function getBill(userId, billId) {
  const bill = await Bill.findOne({ _id: billId, user_id: userId })
    .populate('customer_id')
    .populate('line_items.gas_type_id')
    .populate('line_items.cylinder_size_id');

  if (!bill) {
    throw new HttpError(404, 'Bill not found');
  }

  const billData = bill.toObject();
  const cust = bill.customer_id; // null on INTERNAL_TRANSFER bills
  billData.company_name = cust ? cust.company_name : 'Internal Transfer';
  billData.contact_person = cust ? cust.contact_person : '';
  billData.phone_primary = cust ? cust.phone_primary : '';
  billData.phone_alternate = cust ? cust.phone_alternate : '';
  billData.address = cust ? cust.address : '';
  billData.gst_number = cust ? cust.gst_number : '';

  // Snapshot-first (Phase 9): the names stored at transaction time win; populated master
  // docs are only a fallback for pre-migration data (and may be null if a master was deleted).
  billData.line_items = billData.line_items.map(item => ({
    ...item,
    gas_type_name: item.gas_type_name || (item.gas_type_id && item.gas_type_id.gas_type_name) || '',
    size_label: item.size_label || (item.cylinder_size_id && item.cylinder_size_id.size_label) || ''
  }));

  billData.given_items = billData.line_items.filter(item => item.direction === 'GIVEN');
  billData.received_items = billData.line_items.filter(item => item.direction === 'RECEIVED');

  return billData;
}

// Resolve a draft being finalized: returns the draft Bill doc (which keeps its bill_number
// from the real sequence) or null when creating from scratch.
async function resolveDraft(userId, draft_id) {
  if (!draft_id) return null;
  const draft = await Bill.findOne({ _id: draft_id, user_id: userId, is_draft: true });
  if (!draft) throw new HttpError(404, 'Draft not found (it may already have been finalized)');
  return draft;
}

// ─── Internal transfer: move our own IN_STOCK cylinders between sites ───
// Payload: { transaction_category: 'INTERNAL_TRANSFER', bill_date, challan_no,
//            from_location, to_location, serial_numbers: [rotational numbers], remarks }
// No customer, no amounts. The post-save hook moves each cylinder's location; stock_state untouched.
async function createInternalTransfer(userId, body) {
  const { bill_date, challan_no, from_location, to_location, serial_numbers, remarks } = body;

  if (!LOCATIONS.includes(from_location)) throw new HttpError(400, 'A valid From location is required');
  if (!LOCATIONS.includes(to_location)) throw new HttpError(400, 'A valid To location is required');
  if (from_location === to_location) throw new HttpError(400, 'From and To locations must be different');
  if (!challan_no || !String(challan_no).trim()) throw new HttpError(400, 'Challan number is required');

  // PC transfer quantities (Phase 11): [{ gas_type_id, cylinder_size_id, quantity }] —
  // quantity-only, moves the per-location PC stock; no inventory cylinder is touched.
  const personalItems = (body.personal_items || [])
    .map(p => ({ ...p, quantity: Number(p.quantity) || 0 }))
    .filter(p => p.quantity > 0 && p.gas_type_id && p.cylinder_size_id);

  const serials = [...new Set((serial_numbers || []).map(s => String(s).trim()).filter(Boolean))];
  if (!serials.length && !personalItems.length) {
    throw new HttpError(400, 'At least one cylinder (or personal-cylinder quantity) must be selected for the transfer');
  }

  // Every transferred cylinder must exist in inventory, be IN_STOCK, and be at the From location.
  const cylinders = await Cylinder.find({ user_id: userId, rotational_number: { $in: serials } });
  const byRot = {}; cylinders.forEach(c => { byRot[c.rotational_number] = c; });
  for (const s of serials) {
    const cyl = byRot[s];
    if (!cyl) throw new HttpError(400, `Cylinder "${s}" is not in inventory — only inventory cylinders can be transferred.`);
    if (cyl.stock_state !== 'IN_STOCK') throw new HttpError(400, `Cylinder "${s}" is with a customer and cannot be transferred.`);
    if (cyl.under_maintenance) throw new HttpError(400, `Cylinder "${s}" is under maintenance and cannot be transferred.`);
    if (cyl.location !== from_location) {
      throw new HttpError(400, `Cylinder "${s}" is at ${LOCATION_LABELS[cyl.location] || cyl.location}, not ${LOCATION_LABELS[from_location]}.`);
    }
  }

  // Resolve gas/size master ids from each cylinder's gas_type/capacity strings (line items require them).
  const [gasDocs, sizeDocs] = await Promise.all([GasType.find({}), CylinderSize.find({})]);
  const gasIdByName = {}; gasDocs.forEach(g => { gasIdByName[g.gas_type_name] = g._id; });
  const sizeIdByLabel = {}; sizeDocs.forEach(s => { sizeIdByLabel[s.size_label] = s._id; });

  const lineItems = serials.map(s => {
    const cyl = byRot[s];
    const gasId = gasIdByName[cyl.gas_type];
    const sizeId = sizeIdByLabel[cyl.capacity];
    if (!gasId || !sizeId) {
      throw new HttpError(400, `Cylinder "${s}" has gas/size (${cyl.gas_type}/${cyl.capacity}) not present in the master catalogs.`);
    }
    return {
      direction: 'TRANSFER', gas_type_id: gasId, cylinder_size_id: sizeId,
      gas_type_name: cyl.gas_type, size_label: cyl.capacity, // snapshot at transfer time (Phase 9)
      serial_number: s, quantity: 1, rate: 0, amount: 0
    };
  });

  // PC transfer lines (Phase 11): quantity rides in personalCylindersIn; quantity: 0 and a
  // blank serial keep them invisible to holder-detection and the cylinder-sync hook.
  const gasNameById2 = {}; gasDocs.forEach(g => { gasNameById2[String(g._id)] = g.gas_type_name; });
  const sizeLabelById2 = {}; sizeDocs.forEach(s => { sizeLabelById2[String(s._id)] = s.size_label; });
  for (const p of personalItems) {
    const gName = gasNameById2[String(p.gas_type_id)];
    const sLabel = sizeLabelById2[String(p.cylinder_size_id)];
    if (!gName || !sLabel) throw new HttpError(400, 'Each personal-cylinder transfer line needs a valid gas type and size.');
    lineItems.push({
      direction: 'TRANSFER', gas_type_id: p.gas_type_id, cylinder_size_id: p.cylinder_size_id,
      gas_type_name: gName, size_label: sLabel,
      serial_number: '', quantity: 0, rate: 0, amount: 0,
      personalCylindersIn: p.quantity
    });
  }

  // Finalizing a draft reuses the draft document (and its bill_number); otherwise create fresh.
  const draftDoc = await resolveDraft(userId, body.draft_id);
  const bill = draftDoc || new Bill({ user_id: userId, bill_number: await generateBillNumber() });
  Object.assign(bill, {
    is_draft: false,
    draft_payload: null,
    transaction_category: 'INTERNAL_TRANSFER',
    customer_id: null,
    location: undefined,
    from_location,
    to_location,
    bill_date: bill_date || new Date(),
    transaction_type: 'TRANSFER',
    challan_no: String(challan_no).trim(),
    total_given_qty: 0,
    total_received_qty: 0,
    total_bill_amount: 0,
    remarks,
    line_items: lineItems
  });

  await bill.save(); // post-save hook moves cylinder locations

  try { await recomputeLocationPcStock(userId); } catch (e) { /* non-fatal */ }

  return {
    bill_id: bill._id,
    bill_number: bill.bill_number,
    challan_no: bill.challan_no,
    transferred: serials.length,
    pc_transferred: personalItems.reduce((s, p) => s + p.quantity, 0),
    message: 'Internal transfer recorded successfully'
  };
}

async function createBill(userId, body, stepUp = null) {
  if (body.transaction_category === 'INTERNAL_TRANSFER') {
    return createInternalTransfer(userId, body);
  }

  const {
    customer_id,
    customer_type,
    one_time_customer,
    bill_date,
    transaction_type,
    challan_no,
    location,
    remarks,
    given_items,
    received_items
  } = body;

  if (!customer_id && customer_type !== 'ONE_TIME') {
    throw new HttpError(400, 'Customer ID is required for regular customers');
  }

  // Every customer transaction happens at one of our sites.
  if (!LOCATIONS.includes(location)) {
    throw new HttpError(400, 'A valid location is required for the transaction');
  }

  if (customer_type === 'ONE_TIME' && !one_time_customer) {
    throw new HttpError(400, 'One-time customer details are required');
  }

  if (!given_items && !received_items) {
    throw new HttpError(400, 'At least one cylinder must be in the cart');
  }

  // Challan number is mandatory for new transactions (item 4).
  if (!challan_no || !String(challan_no).trim()) {
    throw new HttpError(400, 'Challan number is required');
  }

  const allItems = [...(given_items || []), ...(received_items || [])];
  for (const item of allItems) {
    const nSerials = (item.serial_numbers || []).length;
    const personal = (Number(item.personalCylindersIn) || 0) + (Number(item.personalCylindersOut) || 0);
    // A line is valid if it has inventory cylinders OR a personal-cylinder count.
    if (nSerials === 0 && personal === 0) {
      throw new HttpError(400, 'Each cylinder line needs at least one cylinder number or a personal cylinder count.');
    }
    if (nSerials > 0 && nSerials !== item.quantity) {
      throw new HttpError(400, 'Number of serial numbers must match quantity');
    }
  }

  // ─── Cylinder availability & duplicate re-validation ───
  const givenSerials = (given_items || []).flatMap(i => (i.serial_numbers || []).map(s => String(s).trim()));
  const receivedSerials = (received_items || []).flatMap(i => (i.serial_numbers || []).map(s => String(s).trim()));

  // No duplicates within the same section
  const findDup = (arr) => arr.find((s, idx) => arr.indexOf(s) !== idx);
  const givenDup = findDup(givenSerials);
  if (givenDup) {
    throw new HttpError(400, `Cylinder "${givenDup}" appears more than once in the Given section`);
  }
  const receivedDup = findDup(receivedSerials);
  if (receivedDup) {
    throw new HttpError(400, `Cylinder "${receivedDup}" appears more than once in the Received section`);
  }

  // A rotational number may appear in BOTH given and received ONLY for a SWAP (round-trip)
  if (transaction_type !== 'SWAP') {
    const overlap = givenSerials.find(s => receivedSerials.includes(s));
    if (overlap) {
      throw new HttpError(400, `Cylinder "${overlap}" cannot be both given and received in a non-swap transaction`);
    }
  }

  // Look up the stock state of every referenced cylinder (unmapped numbers are allowed as a fallback)
  const allSerials = [...new Set([...givenSerials, ...receivedSerials])];
  const inventory = await Cylinder.find({ user_id: userId, rotational_number: { $in: allSerials } });
  const stockByRot = {};
  const cylByRot = {};
  inventory.forEach(c => { stockByRot[c.rotational_number] = c.stock_state; cylByRot[c.rotational_number] = c; });
  const receivedSet = new Set(receivedSerials);

  // ─── Per-line gas-type + size consistency re-validation ───
  // Every serial within a single line item must match that line's gas type and size
  // (the frontend locks this per line, but the backend must enforce it independently).
  // Unmapped serials (not in inventory) are skipped — they're a manual-entry fallback.
  const gasIds = [...new Set(allItems.map(i => String(i.gas_type_id)).filter(Boolean))];
  const sizeIds = [...new Set(allItems.map(i => String(i.cylinder_size_id)).filter(Boolean))];
  const [gasDocs, sizeDocs] = await Promise.all([
    GasType.find({ _id: { $in: gasIds } }),
    CylinderSize.find({ _id: { $in: sizeIds } })
  ]);
  const gasNameById = {}; gasDocs.forEach(g => { gasNameById[String(g._id)] = g.gas_type_name; });
  const sizeLabelById = {}; sizeDocs.forEach(s => { sizeLabelById[String(s._id)] = s.size_label; });

  for (const item of allItems) {
    const lineGas = gasNameById[String(item.gas_type_id)];
    const lineSize = sizeLabelById[String(item.cylinder_size_id)];
    if (!lineGas || !lineSize) {
      throw new HttpError(400, 'Each cylinder line must have a valid gas type and size.');
    }
    for (const raw of item.serial_numbers || []) {
      const s = String(raw).trim();
      const cyl = cylByRot[s];
      if (!cyl) continue; // unmapped — allow
      if (cyl.gas_type !== lineGas || cyl.capacity !== lineSize) {
        throw new HttpError(400, `Cylinder "${s}" is ${cyl.gas_type} / ${cyl.capacity} — it doesn't match this line (${lineGas} / ${lineSize}). Put it in its own cylinder line.`);
      }
    }
  }

  for (const s of givenSerials) {
    const stock = stockByRot[s];
    if (stock === undefined) continue; // unmapped — allow with frontend warning
    const isSwapRoundTrip = transaction_type === 'SWAP' && receivedSet.has(s);
    if (stock !== 'IN_STOCK' && !isSwapRoundTrip) {
      throw new HttpError(400, `Cylinder "${s}" is not available to give out (it is with a customer). Only in-stock cylinders can be given.`);
    }
    if (cylByRot[s].under_maintenance) {
      throw new HttpError(400, `Cylinder "${s}" is under maintenance and cannot be given out until it is returned to stock.`);
    }
    // Location-scoped availability: an in-stock cylinder can only be given from the site it is at.
    // (Swap round-trips are exempt — the cylinder arrives at this site within the same bill.)
    if (stock === 'IN_STOCK' && !isSwapRoundTrip && cylByRot[s].location !== location) {
      throw new HttpError(400, `Cylinder "${s}" is in stock at ${LOCATION_LABELS[cylByRot[s].location] || cylByRot[s].location} — it cannot be given from ${LOCATION_LABELS[location]}. Transfer it to ${LOCATION_LABELS[location]} first.`);
    }
  }
  const givenSet = new Set(givenSerials);
  for (const s of receivedSerials) {
    const stock = stockByRot[s];
    if (stock === undefined) continue; // unmapped — allow with frontend warning
    // SWAP round-trip the outbound way (Phase 14, filling-vendor flow): a cylinder GIVEN on
    // this same bill (sent for filling) may be RECEIVED back on the same bill too.
    const isOutboundRoundTrip = transaction_type === 'SWAP' && givenSet.has(s);
    if (stock !== 'AT_CUSTOMER' && !isOutboundRoundTrip) {
      throw new HttpError(400, `Cylinder "${s}" is already in stock and cannot be received.`);
    }
  }

  let finalCustomerId = customer_id;

  if (customer_type === 'ONE_TIME') {
    const newCustomer = new Customer({
      customer_type: 'ONE_TIME',
      user_id: userId,
      ...one_time_customer
    });
    await newCustomer.save();
    finalCustomerId = newCustomer._id;
  }

  // Finalizing a draft reuses the draft document (and its bill_number from the real sequence).
  const draftDoc = await resolveDraft(userId, body.draft_id);
  const billNumber = draftDoc ? draftDoc.bill_number : await generateBillNumber();

  // Recompute totals server-side — never trust client `amount`. Personal cylinders RETURNED
  // (personalCylindersOut) are refilled service items charged at the same line rate:
  //   amount = rate × (inventory cylinders + personalCylindersOut)
  // Personal cylinders TAKEN (personalCylindersIn, Empty section) are never charged.
  const total_given_qty = given_items ? given_items.reduce((sum, item) => sum + (item.serial_numbers || []).length, 0) : 0;
  const total_received_qty = received_items ? received_items.reduce((sum, item) => sum + (item.serial_numbers || []).length, 0) : 0;
  const total_bill_amount = given_items
    ? given_items.reduce((sum, item) =>
        sum + (Number(item.rate) || 0) * ((item.serial_numbers || []).length + (Number(item.personalCylindersOut) || 0)), 0)
    : 0;

  // ─── Over-limit HARD block (Phase 5) — overridable with step-up approval (Phase 18) ───
  // A CUSTOMER bill that would push a REGULAR customer past their holding_limit is rejected
  // outright unless a verified step-up approval accompanies the request. One-time customers
  // have no configured limit, and internal transfers never reach this path.
  let overLimitOverride = null;
  if (customer_type !== 'ONE_TIME') {
    const limitCustomer = await Customer.findOne({ _id: finalCustomerId, user_id: userId });
    if (!limitCustomer) throw new HttpError(404, 'Customer not found');
    // Filling-vendor bills (Phase 15): the cross-customer "returned on behalf of" pathway does
    // not exist — every received serial must either be with THIS vendor or be a same-bill
    // round trip (sent for filling on this bill). Normal customer bills keep the pathway.
    if (limitCustomer.is_filling_vendor) {
      for (const s of receivedSerials) {
        if (givenSet.has(s)) continue; // same-bill round trip
        const holderRec = await findCurrentGiven(userId, s, null);
        const holder = holderRec && holderRec.bill.customer_id;
        if (holder && String(holder._id) !== String(finalCustomerId)) {
          throw new HttpError(400,
            `Cylinder "${s}" is currently held by ${holder.company_name}, not by this filling vendor — ` +
            `only cylinders with this vendor can be received back filled.`);
        }
      }
    }
    if (!limitCustomer.is_filling_vendor) { // filling vendors are fully exempt (Phase 11)
    const customerBills = await Bill.find({ user_id: userId, customer_id: finalCustomerId, is_draft: { $ne: true } });
    const { held } = computeHoldings(customerBills);
    // Only returns of THIS customer's own cylinders reduce their holding (Phase 7). A serial
    // whose current holder is a different customer will be settled on that holder's behalf
    // post-save (returned_on_behalf_of), so it must not net here either — same rule
    // computeHoldings applies to saved bills.
    const ownReceivedQty = await countOwnReturns(userId, finalCustomerId, received_items);
    const newHeld = held + total_given_qty - ownReceivedQty;
    if (newHeld > (limitCustomer.holding_limit || 0)) {
      // Over-limit override (Phase 18): a verified step-up approval lets the save proceed;
      // the authorization is recorded on the bill + audit log below. No approval → the
      // Phase 5 hard block stands (frontend offers Request Authorization / Save for Later).
      if (stepUp) {
        overLimitOverride = {
          detail: `${limitCustomer.company_name}: ${newHeld} held vs limit ${limitCustomer.holding_limit}`
        };
      } else {
        throw new HttpError(400,
          `This bill would put ${limitCustomer.company_name} over their holding limit ` +
          `(${newHeld} held vs limit ${limitCustomer.holding_limit}). Saving is blocked.`);
      }
    }
    }
  }

  const lineItems = [];

  // Personal counts are per gas-type block; attach to the FIRST expanded line of the block
  // (or a single quantity-0 line when the block has personal cylinders but no inventory serials).
  if (given_items) {
    given_items.forEach(item => {
      const serials = item.serial_numbers || [];
      const pOut = Number(item.personalCylindersOut) || 0;
      const rate = Number(item.rate) || 0;
      // Personal-only Filled line: still billable — amount = rate × personal count.
      if (serials.length === 0) {
        lineItems.push({
          direction: 'GIVEN', gas_type_id: item.gas_type_id, cylinder_size_id: item.cylinder_size_id,
          serial_number: '', quantity: 0, rate, amount: rate * pOut, personalCylindersOut: pOut
        });
        return;
      }
      // Per-serial lines; the first line of the block carries the personal count and its charge,
      // so each stored line's amount = rate × (quantity + personalCylindersOut).
      serials.forEach((serialNumber, idx) => {
        const p = idx === 0 ? pOut : 0;
        lineItems.push({
          direction: 'GIVEN', gas_type_id: item.gas_type_id, cylinder_size_id: item.cylinder_size_id,
          serial_number: serialNumber, quantity: 1, rate, amount: rate * (1 + p),
          personalCylindersOut: p
        });
      });
    });
  }

  if (received_items) {
    received_items.forEach(item => {
      const serials = item.serial_numbers || [];
      const pIn = Number(item.personalCylindersIn) || 0;
      if (serials.length === 0) {
        lineItems.push({
          direction: 'RECEIVED', gas_type_id: item.gas_type_id, cylinder_size_id: item.cylinder_size_id,
          serial_number: '', quantity: 0, rate: 0, amount: 0, personalCylindersIn: pIn
        });
        return;
      }
      serials.forEach((serialNumber, idx) => {
        lineItems.push({
          direction: 'RECEIVED', gas_type_id: item.gas_type_id, cylinder_size_id: item.cylinder_size_id,
          serial_number: serialNumber, quantity: 1, rate: 0, amount: 0,
          personalCylindersIn: idx === 0 ? pIn : 0
        });
      });
    });
  }

  // Stamp gas/size snapshot names on every line (Phase 9) — historical display must never
  // depend on the master docs (or the cylinder's current type) after this point.
  lineItems.forEach(li => {
    li.gas_type_name = gasNameById[String(li.gas_type_id)] || '';
    li.size_label = sizeLabelById[String(li.cylinder_size_id)] || '';
  });

  // ─── Personal-cylinder guard (Phase 11): validated PER gas+size combination — never a
  // blended total. Filling vendors are exempt (PC sent to them for filling may drive their
  // balance negative = with the vendor).
  if (finalCustomerId) {
    const pcCustomer = await Customer.findOne({ _id: finalCustomerId, user_id: userId });
    await assertPersonalPerCombo(userId, finalCustomerId, lineItems, null, !!(pcCustomer && pcCustomer.is_filling_vendor));
  }

  const bill = draftDoc || new Bill({ user_id: userId, bill_number: billNumber });
  Object.assign(bill, {
    is_draft: false,
    draft_payload: null,
    bill_number: billNumber,
    transaction_category: 'CUSTOMER',
    customer_id: finalCustomerId,
    location,
    from_location: undefined,
    to_location: undefined,
    bill_date,
    transaction_type,
    challan_no: String(challan_no).trim(),
    total_given_qty,
    total_received_qty,
    total_bill_amount,
    remarks,
    line_items: lineItems
  });

  await bill.save();

  // Record the over-limit authorization (Phase 18): who approved and how, on the bill and
  // in the audit log. updateOne so the cylinder-sync hook doesn't run a second time.
  if (overLimitOverride && stepUp) {
    await Bill.updateOne({ _id: bill._id }, {
      $push: { authorizations: {
        action: 'OVER_LIMIT_OVERRIDE', via: stepUp.via,
        person_id: stepUp.person_id || null, person_name: stepUp.person_name || '', at: new Date()
      } }
    });
    await audit.record({
      userId, action: 'OVER_LIMIT_OVERRIDE', target: bill.bill_number,
      detail: overLimitOverride.detail, stepUp
    });
  }

  // ─── Cross-customer return settlement ───
  // For each received cylinder whose current holder differs from the customer on THIS bill,
  // record it as returned on the holder's (Customer A's) behalf, and mark A's original GIVEN
  // line as returned so A's holding is reduced — exactly as if A had returned it directly.
  const crossReturns = []; // for the response: which cylinders settled / couldn't be settled
  if (received_items && received_items.length) {
    const me = await Customer.findById(finalCustomerId); // Customer B (on this bill)
    let billDirty = false;

    for (const rline of bill.line_items) {
      if (rline.direction !== 'RECEIVED') continue;

      const holderRec = await findCurrentGiven(userId, rline.serial_number, bill._id);
      if (!holderRec) continue; // no original GIVEN found (legacy/unmapped) — cylinder already at-plant

      const holder = holderRec.bill.customer_id; // Customer A
      if (!holder || String(holder._id) === String(finalCustomerId)) continue; // same customer — normal return

      // Cross-customer return on behalf of Customer A
      rline.returned_on_behalf_of = holder._id;
      rline.returned_on_behalf_of_name = holder.company_name;
      billDirty = true;

      // Mark A's original GIVEN line as returned via B
      holderRec.line.returned_via = finalCustomerId;
      holderRec.line.returned_via_name = me ? me.company_name : '';
      holderRec.line.returned_date = bill.bill_date;
      await holderRec.bill.save();

      crossReturns.push({ serial: rline.serial_number, on_behalf_of: holder.company_name });
    }

    if (billDirty) await bill.save();
  }

  // ── Personal cylinders: recompute this customer's running at-plant count from all their bills. ──
  try {
    await syncPersonalCount(userId, finalCustomerId);
  } catch (e) { /* non-fatal */ }
  try { await recomputeLocationPcStock(userId); } catch (e) { /* non-fatal */ }

  return {
    bill_id: bill._id,
    bill_number: billNumber,
    challan_no: bill.challan_no,
    cross_returns: crossReturns,
    message: 'Bill created successfully'
  };
}

// ─── Edit an internal transfer (Phase 13) ───
// Reverts the old transfer's cylinder movements, re-validates the new payload exactly like
// createInternalTransfer, rebuilds the line items (cylinders + PC quantities), and lets the
// post-save hook re-apply the movements. Same 3-day window and audit rules as customer bills:
// bill_number stays editable forever (quiet bill_number_history), other changes respect the
// lock and log to edit_history when logEdit is set.
async function updateInternalTransfer(user, bill, body, stepUp = null) {
  const uid = user.id;
  const { bill_number, bill_date, challan_no, serial_numbers, personal_items, logEdit } = body;

  // bill_number-only edit (nothing else supplied) — allowed even after the 3-day lock.
  const keepLines = serial_numbers === undefined && personal_items === undefined &&
    body.from_location === undefined && body.to_location === undefined &&
    challan_no === undefined && bill_date === undefined;

  const newBillNumber = bill_number !== undefined ? String(bill_number).trim() : undefined;
  if (newBillNumber !== undefined) {
    if (!newBillNumber) throw new HttpError(400, 'Bill number cannot be empty');
    if (newBillNumber !== bill.bill_number) {
      const clash = await Bill.findOne({ bill_number: newBillNumber, _id: { $ne: bill._id } });
      if (clash) throw new HttpError(400, `Bill number "${newBillNumber}" is already used by another bill`);
    }
  }
  if (!keepLines && isLocked(bill)) {
    throw new HttpError(400, 'This transfer is older than 3 days and locked — only the bill number can still be edited.');
  }

  const changes = [];
  if (newBillNumber !== undefined && newBillNumber !== bill.bill_number) {
    bill.bill_number_history.push({ old_value: bill.bill_number, new_value: newBillNumber, changed_at: new Date() });
    bill.bill_number = newBillNumber;
  }

  if (!keepLines) {
    const from_location = body.from_location !== undefined ? body.from_location : bill.from_location;
    const to_location = body.to_location !== undefined ? body.to_location : bill.to_location;
    if (!LOCATIONS.includes(from_location) || !LOCATIONS.includes(to_location)) throw new HttpError(400, 'Valid From and To locations are required');
    if (from_location === to_location) throw new HttpError(400, 'From and To locations must be different');
    const newChallan = challan_no !== undefined ? String(challan_no).trim() : bill.challan_no;
    if (!newChallan) throw new HttpError(400, 'Challan number is required');

    const personalItems = (personal_items || [])
      .map(p => ({ ...p, quantity: Number(p.quantity) || 0 }))
      .filter(p => p.quantity > 0 && p.gas_type_id && p.cylinder_size_id);
    const serials = [...new Set((serial_numbers || []).map(s => String(s).trim()).filter(Boolean))];
    if (!serials.length && !personalItems.length) {
      throw new HttpError(400, 'At least one cylinder (or personal-cylinder quantity) must be selected for the transfer');
    }

    // Revert the OLD movements first so unchanged serials re-validate as in stock at From.
    const oldSerials = [...new Set(bill.line_items.map(l => l.serial_number).filter(Boolean))];
    if (oldSerials.length) {
      await Cylinder.updateMany(
        { user_id: uid, rotational_number: { $in: oldSerials }, stock_state: 'IN_STOCK' },
        { location: bill.from_location }
      );
    }

    // Validate the new payload exactly like a fresh transfer.
    const cylDocs = await Cylinder.find({ user_id: uid, rotational_number: { $in: serials } });
    const byRot = {}; cylDocs.forEach(c => { byRot[c.rotational_number] = c; });
    for (const s of serials) {
      const cyl = byRot[s];
      if (!cyl) throw new HttpError(400, `Cylinder "${s}" is not in inventory — only inventory cylinders can be transferred.`);
      if (cyl.stock_state !== 'IN_STOCK') throw new HttpError(400, `Cylinder "${s}" is with a customer and cannot be transferred.`);
      if (cyl.under_maintenance) throw new HttpError(400, `Cylinder "${s}" is under maintenance and cannot be transferred.`);
      if (cyl.location !== from_location) {
        throw new HttpError(400, `Cylinder "${s}" is at ${LOCATION_LABELS[cyl.location] || cyl.location}, not ${LOCATION_LABELS[from_location]}.`);
      }
    }

    const [gasDocs, sizeDocs] = await Promise.all([GasType.find({}), CylinderSize.find({})]);
    const gasIdByName = {}; gasDocs.forEach(x => { gasIdByName[x.gas_type_name] = x._id; });
    const sizeIdByLabel = {}; sizeDocs.forEach(x => { sizeIdByLabel[x.size_label] = x._id; });
    const gasNameById = {}; gasDocs.forEach(x => { gasNameById[String(x._id)] = x.gas_type_name; });
    const sizeLabelById = {}; sizeDocs.forEach(x => { sizeLabelById[String(x._id)] = x.size_label; });

    const lineItems = serials.map(s => {
      const cyl = byRot[s];
      const gasId = gasIdByName[cyl.gas_type];
      const sizeId = sizeIdByLabel[cyl.capacity];
      if (!gasId || !sizeId) throw new HttpError(400, `Cylinder "${s}" has gas/size (${cyl.gas_type}/${cyl.capacity}) not present in the master catalogs.`);
      return {
        direction: 'TRANSFER', gas_type_id: gasId, cylinder_size_id: sizeId,
        gas_type_name: cyl.gas_type, size_label: cyl.capacity,
        serial_number: s, quantity: 1, rate: 0, amount: 0
      };
    });
    for (const p of personalItems) {
      const gName = gasNameById[String(p.gas_type_id)];
      const sLabel = sizeLabelById[String(p.cylinder_size_id)];
      if (!gName || !sLabel) throw new HttpError(400, 'Each personal-cylinder transfer line needs a valid gas type and size.');
      lineItems.push({
        direction: 'TRANSFER', gas_type_id: p.gas_type_id, cylinder_size_id: p.cylinder_size_id,
        gas_type_name: gName, size_label: sLabel,
        serial_number: '', quantity: 0, rate: 0, amount: 0, personalCylindersIn: p.quantity
      });
    }

    // Human-readable diff for the audit trail.
    const d2 = (d) => new Date(d).toLocaleDateString('en-GB');
    if (bill_date && d2(bill_date) !== d2(bill.bill_date)) changes.push(`Bill Date changed from ${d2(bill.bill_date)} to ${d2(bill_date)}`);
    if (challan_no !== undefined && newChallan !== bill.challan_no) changes.push(`Challan No. changed from ${bill.challan_no || '(none)'} to ${newChallan}`);
    if (from_location !== bill.from_location) changes.push(`From changed to ${LOCATION_LABELS[from_location]}`);
    if (to_location !== bill.to_location) changes.push(`To changed to ${LOCATION_LABELS[to_location]}`);
    const newSet = new Set(serials);
    oldSerials.forEach(s => { if (!newSet.has(s)) changes.push(`Cylinder ${s} removed`); });
    serials.forEach(s => { if (!oldSerials.includes(s)) changes.push(`Cylinder ${s} added`); });
    const oldPc = bill.line_items.reduce((t, l) => t + (Number(l.personalCylindersIn) || 0), 0);
    const newPc = personalItems.reduce((t, p) => t + p.quantity, 0);
    if (oldPc !== newPc) changes.push(`Personal cylinders changed from ${oldPc} to ${newPc}`);

    bill.from_location = from_location;
    bill.to_location = to_location;
    if (bill_date) bill.bill_date = bill_date;
    bill.challan_no = newChallan;
    bill.line_items = lineItems;

    if (logEdit && changes.length) {
      bill.edit_history.push({
        edited_at: new Date(), edited_by: user.name || user.email || 'user', changes,
        authorized_by: stepUp ? (stepUp.person_name || '') : '',
        authorized_via: stepUp ? (stepUp.via || '') : ''
      });
    }
    // Phase 18: record the approval for every step-up-verified transfer edit.
    if (stepUp) {
      bill.authorizations.push({
        action: 'EDIT', via: stepUp.via,
        person_id: stepUp.person_id || null, person_name: stepUp.person_name || '', at: new Date()
      });
      await audit.record({
        userId: uid, action: 'BILL_EDIT', target: bill.bill_number,
        detail: changes.length ? changes.join('; ') : 'Same-session correction (transfer)', stepUp
      });
    }
  }

  await bill.save(); // post-save hook re-applies the (new) cylinder movements
  try { await recomputeLocationPcStock(uid); } catch (e) { /* non-fatal */ }

  return { bill_id: bill._id, changes, audited: !!(logEdit && changes.length), message: 'Transfer updated successfully' };
}

// Edit an existing bill (item 11). Computes a human-readable diff, appends to edit_history
// (unless same_session), re-syncs cylinder statuses for added/removed cylinders.
// `user` = req.user ({ id, name, email, ... }) — name/email are used in the edit_history entry.
async function updateBill(user, billId, body, stepUp = null) {
  const uid = user.id;
  const bill = await Bill.findOne({ _id: billId, user_id: uid });
  if (!bill) throw new HttpError(404, 'Bill not found');

  if (bill.transaction_category === 'INTERNAL_TRANSFER') {
    // Transfers are editable since Phase 13 (same-session Edit Bill on the success screen).
    return updateInternalTransfer(user, bill, body, stepUp);
  }
  if (bill.is_draft) {
    throw new HttpError(400, 'This is a draft — resume it from the New Transaction page instead.');
  }

  // logEdit=true → record an editHistory entry (edits from the Transaction History popup).
  // logEdit=false → silent same-session correction from the success screen (no audit entry).
  // line_items === undefined → keep the existing lines untouched (bill-number-only edits,
  // which stay allowed even after the 3-day lock).
  const { bill_date, bill_number, challan_no, transaction_type, line_items, logEdit } = body;
  const keepLines = line_items === undefined;
  if (!keepLines && (!Array.isArray(line_items) || line_items.length === 0)) {
    throw new HttpError(400, 'At least one cylinder line is required');
  }
  if (!keepLines && (!challan_no || !String(challan_no).trim())) {
    throw new HttpError(400, 'Challan number is required');
  }
  if (challan_no !== undefined && !String(challan_no).trim()) {
    throw new HttpError(400, 'Challan number is required');
  }

  // bill_number is editable ONLY through this edit flow; re-validate uniqueness on every edit.
  const newBillNumber = bill_number !== undefined ? String(bill_number).trim() : undefined;
  if (newBillNumber !== undefined) {
    if (!newBillNumber) throw new HttpError(400, 'Bill number cannot be empty');
    if (newBillNumber !== bill.bill_number) {
      const clash = await Bill.findOne({ bill_number: newBillNumber, _id: { $ne: bill._id } });
      if (clash) throw new HttpError(400, `Bill number "${newBillNumber}" is already used by another bill`);
    }
  }

  // Resolve gas/size names (old + new) for the human-readable diff.
  const reqLines = keepLines ? [] : line_items;
  const allGasIds = [...new Set([...bill.line_items.map(l => String(l.gas_type_id)), ...reqLines.map(l => String(l.gas_type_id))].filter(Boolean))];
  const allSizeIds = [...new Set([...bill.line_items.map(l => String(l.cylinder_size_id)), ...reqLines.map(l => String(l.cylinder_size_id))].filter(Boolean))];
  const [gasDocs, sizeDocs] = await Promise.all([
    GasType.find({ _id: { $in: allGasIds } }),
    CylinderSize.find({ _id: { $in: allSizeIds } })
  ]);
  const gasName = {}; gasDocs.forEach(g => { gasName[String(g._id)] = g.gas_type_name; });
  const sizeName = {}; sizeDocs.forEach(s => { sizeName[String(s._id)] = s.size_label; });

  const d2 = (d) => new Date(d).toLocaleDateString('en-GB');
  const oldSnap = {
    bill_number: bill.bill_number,
    bill_date: bill.bill_date, challan_no: bill.challan_no || '', transaction_type: bill.transaction_type,
    amount: bill.total_bill_amount || 0,
    lines: bill.line_items.map(l => ({ key: l.direction + '|' + l.serial_number, serial: l.serial_number, direction: l.direction, rate: l.rate || 0 }))
  };

  const newLines = keepLines ? bill.line_items : line_items.map(l => {
    const rate = l.direction === 'GIVEN' ? (Number(l.rate) || 0) : 0;
    const serial = String(l.serial_number || '').trim();
    const pOut = Number(l.personalCylindersOut) || 0;
    const quantity = serial ? 1 : 0;
    return {
      direction: l.direction, gas_type_id: l.gas_type_id, cylinder_size_id: l.cylinder_size_id,
      // Snapshot names at edit time (Phase 9) — same rule as bill creation.
      gas_type_name: gasName[String(l.gas_type_id)] || '',
      size_label: sizeName[String(l.cylinder_size_id)] || '',
      serial_number: serial, quantity, rate,
      // Personal cylinders returned are charged at the same rate: rate × (inventory + personal).
      amount: rate * (quantity + pOut),
      // Preserve personal-cylinder counts across edits (Edit Bill has no UI for them yet).
      personalCylindersIn: Number(l.personalCylindersIn) || 0,
      personalCylindersOut: pOut
    };
  });

  // Personal-cylinder guard (exclude THIS bill's old value; add its new value) —
  // per gas+size combination (Phase 11); filling vendors exempt.
  if (!keepLines) {
    const pcCustomer = await Customer.findOne({ _id: bill.customer_id, user_id: uid });
    await assertPersonalPerCombo(uid, bill.customer_id, newLines, bill._id, !!(pcCustomer && pcCustomer.is_filling_vendor));
  }

  // ── Compute diff ──
  const changes = [];
  if (newBillNumber !== undefined && newBillNumber !== oldSnap.bill_number) changes.push(`Bill Number changed from ${oldSnap.bill_number} to ${newBillNumber}`);
  if (bill_date && d2(bill_date) !== d2(oldSnap.bill_date)) changes.push(`Bill Date changed from ${d2(oldSnap.bill_date)} to ${d2(bill_date)}`);
  if (challan_no !== undefined && String(challan_no) !== oldSnap.challan_no) changes.push(`Challan No. changed from ${oldSnap.challan_no || '(none)'} to ${challan_no || '(none)'}`);
  if (transaction_type && transaction_type !== oldSnap.transaction_type) changes.push(`Transaction Type changed from ${oldSnap.transaction_type} to ${transaction_type}`);

  if (!keepLines) {
    const oldByKey = {}; oldSnap.lines.forEach(l => { oldByKey[l.key] = l; });
    const newByKey = {}; newLines.forEach(l => { newByKey[l.direction + '|' + l.serial_number] = l; });
    oldSnap.lines.forEach(l => { if (!newByKey[l.key]) changes.push(`Cylinder ${l.serial} removed`); });
    newLines.forEach(l => {
      const key = l.direction + '|' + l.serial_number;
      const old = oldByKey[key];
      const g = gasName[String(l.gas_type_id)] || 'gas', s = sizeName[String(l.cylinder_size_id)] || 'size';
      if (!old) changes.push(`Cylinder ${l.serial_number} added (${g}, ${s}${l.direction === 'GIVEN' ? `, ₹${l.rate}` : ''})`);
      else if (l.direction === 'GIVEN' && Number(old.rate) !== Number(l.rate)) changes.push(`Rate changed from ₹${old.rate} to ₹${l.rate} for ${g} ${s}`);
    });
  }

  // ─── 3-day edit lock (Phase 5) ───
  // After the window, ONLY the bill number may change — everything else is frozen.
  if (isLocked(bill)) {
    const forbidden = changes.filter(c => !c.startsWith('Bill Number'));
    if (forbidden.length) {
      throw new HttpError(400, 'This bill is older than 3 days and locked — only the bill number can still be edited.');
    }
  }

  // ── Apply ──
  if (newBillNumber !== undefined) bill.bill_number = newBillNumber;
  if (bill_date) bill.bill_date = bill_date;
  if (challan_no !== undefined) bill.challan_no = challan_no;
  if (transaction_type) bill.transaction_type = transaction_type;
  if (!keepLines) {
    bill.line_items = newLines;
    bill.total_given_qty = newLines.filter(l => l.direction === 'GIVEN').reduce((s, l) => s + l.quantity, 0);
    bill.total_received_qty = newLines.filter(l => l.direction === 'RECEIVED').reduce((s, l) => s + l.quantity, 0);
    bill.total_bill_amount = newLines.filter(l => l.direction === 'GIVEN').reduce((s, l) => s + l.amount, 0);
  }

  const amountChanged = !keepLines && (oldSnap.amount || 0) !== bill.total_bill_amount;
  if (amountChanged) changes.push(`Bill amount changed from ₹${oldSnap.amount.toFixed(2)} to ₹${bill.total_bill_amount.toFixed(2)}`);

  // Bill-number renames are tracked quietly in bill_number_history (Phase 8) — they never
  // enter edit_history, so a bill-number-only edit never shows the "Updated" indicator.
  // Every other field change keeps logging exactly as before.
  if (newBillNumber !== undefined && newBillNumber !== oldSnap.bill_number) {
    bill.bill_number_history.push({ old_value: oldSnap.bill_number, new_value: newBillNumber, changed_at: new Date() });
  }
  const loggable = changes.filter(c => !c.startsWith('Bill Number'));
  if (logEdit && loggable.length) {
    bill.edit_history.push({
      edited_at: new Date(), edited_by: user.name || user.email || 'user', changes: loggable,
      // Phase 18: WHO approved this edit and how — alongside (never instead of) the change log.
      authorized_by: stepUp ? (stepUp.person_name || '') : '',
      authorized_via: stepUp ? (stepUp.via || '') : ''
    });
  }
  // Every step-up-approved edit (incl. same-session corrections that skip edit_history)
  // is recorded on the bill and in the audit log (Phase 18).
  if (stepUp && !keepLines) {
    bill.authorizations.push({
      action: 'EDIT', via: stepUp.via,
      person_id: stepUp.person_id || null, person_name: stepUp.person_name || '', at: new Date()
    });
    await audit.record({
      userId: uid, action: 'BILL_EDIT', target: bill.bill_number,
      detail: loggable.length ? loggable.join('; ') : 'Same-session correction', stepUp
    });
  }

  await bill.save(); // post-save hook re-applies statuses for the CURRENT line items

  if (!keepLines) {
    // Re-sync any serials that were on the bill before but are now removed.
    const newSerials = new Set(newLines.map(l => l.serial_number));
    const oldSerials = [...new Set(oldSnap.lines.map(l => l.serial))];
    for (const s of oldSerials) {
      if (newSerials.has(s)) continue;
      const holder = await findCurrentGiven(uid, s, bill._id);
      await Cylinder.updateMany({ user_id: uid, rotational_number: s }, { stock_state: holder ? 'AT_CUSTOMER' : 'IN_STOCK' });
    }

    // Recompute this customer's personal-cylinder at-plant count from all their bills.
    try {
      await syncPersonalCount(uid, bill.customer_id);
    } catch (e) { /* non-fatal */ }
  }
  try { await recomputeLocationPcStock(uid); } catch (e) { /* non-fatal */ }

  return {
    bill_id: bill._id,
    amount_changed: amountChanged,
    old_amount: oldSnap.amount,
    new_amount: bill.total_bill_amount,
    audited: !!(logEdit && loggable.length),
    changes,
    message: 'Bill updated successfully'
  };
}

// ─── DSR per-row remark (Phase 10) ───
// Stamps a free-text note on every line item of the given gas×size combo (a DSR row is one
// bill × gas × size). Written via updateOne so the Bill post-save cylinder-sync hook never
// runs; deliberately outside edit_history and exempt from the 3-day lock — it's a report
// annotation, not a bill edit.
async function setDsrRemark(uid, billId, { gas_type, size, remarks }) {
  const bill = await Bill.findOne({ _id: billId, user_id: uid });
  if (!bill) throw new HttpError(404, 'Bill not found');
  const value = String(remarks == null ? '' : remarks).trim();
  const r = await Bill.updateOne(
    { _id: bill._id, user_id: uid },
    { $set: { 'line_items.$[li].remarks': value } },
    { arrayFilters: [{ 'li.gas_type_name': gas_type, 'li.size_label': size }] }
  );
  if (!r.matchedCount) throw new HttpError(404, 'Bill not found');
  return { message: 'Remark saved', remarks: value };
}

// ─── Delete a bill (Phase 5) ───
// Allowed within 3 days of CREATION (drafts always deletable). Reverts every cylinder the
// bill touched to its pre-bill location/stock_state, undoes cross-customer-return annotations
// this bill created, and leaves any linked Payments as-is (orphaned by design).
async function deleteBill(uid, billId, stepUp = null) {
  const bill = await Bill.findOne({ _id: billId, user_id: uid });
  if (!bill) throw new HttpError(404, 'Bill not found');
  if (!bill.is_draft && isLocked(bill)) {
    throw new HttpError(400, 'Bills can only be deleted within 3 days of creation.');
  }
  // Phase 18: deleting a REAL bill requires step-up approval (drafts stay freely deletable).
  // 403 (not 401) so the frontend's session-expiry handling never fires here.
  if (!bill.is_draft && !stepUp) {
    throw new HttpError(403, 'Deleting a bill requires approval — verify with a trusted person first.');
  }

  // Undo cross-customer return annotations this bill's RECEIVED lines created on the
  // original holder's GIVEN lines (the return never happened once this bill is gone).
  for (const line of bill.line_items) {
    if (line.direction !== 'RECEIVED' || !line.returned_on_behalf_of) continue;
    const holderBills = await Bill.find({
      user_id: uid,
      customer_id: line.returned_on_behalf_of,
      line_items: { $elemMatch: { direction: 'GIVEN', serial_number: line.serial_number, returned_via: bill.customer_id } }
    });
    for (const hb of holderBills) {
      let dirty = false;
      hb.line_items.forEach(l => {
        if (l.direction === 'GIVEN' && l.serial_number === line.serial_number && String(l.returned_via) === String(bill.customer_id)) {
          l.returned_via = null; l.returned_via_name = null; l.returned_date = null; dirty = true;
        }
      });
      if (dirty) await hb.save(); // hook re-marks those cylinders as held again
    }
  }

  const serials = [...new Set(bill.line_items.map(l => l.serial_number).filter(Boolean))];
  const category = bill.transaction_category;
  const fromLoc = bill.from_location;
  const billLoc = bill.location;
  const customerId = bill.customer_id;

  await Bill.deleteOne({ _id: bill._id, user_id: uid });

  // Phase 18: the bill document is gone, so the delete authorization lives in the audit log.
  if (!bill.is_draft && stepUp) {
    await audit.record({
      userId: uid, action: 'BILL_DELETE', target: bill.bill_number,
      detail: `Deleted bill ${bill.bill_number}${bill.customer_id ? '' : ' (internal transfer)'}`, stepUp
    });
  }

  // Revert cylinder state now that this bill no longer exists. Still derived from bills
  // (findCurrentGiven), never trusted from the client — same ownership rule as the save hook.
  for (const s of serials) {
    if (category === 'INTERNAL_TRANSFER') {
      // Transfer undone: the cylinder goes back to the source site; stock_state untouched.
      await Cylinder.updateMany({ user_id: uid, rotational_number: s }, { location: fromLoc });
      continue;
    }
    const holder = await findCurrentGiven(uid, s, null);
    if (holder) {
      const loc = holder.bill.location;
      await Cylinder.updateMany(
        { user_id: uid, rotational_number: s },
        loc ? { stock_state: 'AT_CUSTOMER', location: loc } : { stock_state: 'AT_CUSTOMER' }
      );
    } else {
      // No remaining holder → in stock. A GIVEN required the cylinder to be in stock at this
      // bill's site beforehand, so that site is its pre-bill location.
      await Cylinder.updateMany(
        { user_id: uid, rotational_number: s },
        billLoc ? { stock_state: 'IN_STOCK', location: billLoc } : { stock_state: 'IN_STOCK' }
      );
    }
  }

  // Recompute the customer's personal-cylinder running count without this bill.
  if (customerId) {
    try {
      await syncPersonalCount(uid, customerId);
    } catch (e) { /* non-fatal */ }
  }
  try { await recomputeLocationPcStock(uid); } catch (e) { /* non-fatal */ }

  return { message: `Bill ${bill.bill_number} deleted`, bill_number: bill.bill_number };
}

// ─── Save-for-later drafts (Phase 5) ───
// A draft claims a REAL bill number (same sequence) and stores the raw new-transaction form
// state in draft_payload. Scoped to the location it was created under.
async function saveDraft(userId, { draft_id, location, payload }) {
  if (!LOCATIONS.includes(location)) throw new HttpError(400, 'A valid location is required for a draft');
  if (!payload || typeof payload !== 'object') throw new HttpError(400, 'Draft payload is required');

  let draft;
  if (draft_id) {
    draft = await Bill.findOne({ _id: draft_id, user_id: userId, is_draft: true });
    if (!draft) throw new HttpError(404, 'Draft not found');
    draft.location = location;
    draft.draft_payload = payload;
    draft.markModified('draft_payload');
  } else {
    draft = new Bill({
      user_id: userId,
      bill_number: await generateBillNumber(),
      is_draft: true,
      draft_payload: payload,
      transaction_category: 'CUSTOMER',
      location,
      bill_date: new Date(),
      transaction_type: payload.transactionType === 'RECEIVED' || payload.transactionType === 'SWAP' ? payload.transactionType : 'GIVEN',
      challan_no: String(payload.challanNo || '').trim(),
      line_items: []
    });
  }
  await draft.save(); // hook is a no-op for drafts

  return { draft_id: draft._id, bill_number: draft.bill_number, message: 'Draft saved' };
}

async function listDrafts(userId, location) {
  const query = { user_id: userId, is_draft: true };
  if (LOCATIONS.includes(location)) query.location = location;
  const drafts = await Bill.find(query).sort('-updatedAt');
  return drafts.map(d => ({
    draft_id: d._id,
    bill_number: d.bill_number,
    location: d.location,
    customer_name: (d.draft_payload && (d.draft_payload.customer_name ||
      (d.draft_payload.one_time_customer && d.draft_payload.one_time_customer.company_name))) || '(no customer yet)',
    saved_at: d.updatedAt,
    payload: d.draft_payload || {}
  }));
}

async function getTodayStats(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const count = await Bill.countDocuments({
    user_id: userId,
    is_draft: { $ne: true },
    bill_date: { $gte: startOfDay, $lte: endOfDay }
  });

  return { today_transactions: count };
}

module.exports = {
  billPersonalDelta,
  totalPersonalForCustomer,
  personalByComboForCustomer,
  generateBillNumber,
  findCurrentGiven,
  validateCylinder,
  listBills,
  getBill,
  createBill,
  updateBill,
  deleteBill,
  setDsrRemark,
  saveDraft,
  listDrafts,
  getTodayStats
};
