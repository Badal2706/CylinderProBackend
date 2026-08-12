const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const Cylinder = require('../models/Cylinder');
const LocationProfile = require('../models/LocationProfile');
const HttpError = require('../utils/HttpError');
const { computeHoldings } = require('./holdings.service');
const { LOCATIONS, LOCATION_LABELS } = require('../config/locations');
const { getPcStock } = require('./pcStock.service');
const toOid = (id) => new mongoose.Types.ObjectId(id);

async function getCustomerLedgerData(userId) {
  const customers = await Customer.find({
    user_id: userId,
    customer_type: 'REGULAR',
    is_active: true
  }).sort('company_name').lean();

  const customerIds = customers.map(c => c._id);

  const [billsByCustomer, paymentAgg] = await Promise.all([
    Bill.find({ customer_id: { $in: customerIds }, user_id: userId },
      { customer_id: 1, total_bill_amount: 1,
        'line_items.direction': 1, 'line_items.quantity': 1, 'line_items.amount': 1,
        'line_items.returned_via': 1, 'line_items.returned_on_behalf_of': 1 }).lean(),
    Payment.aggregate([
      { $match: { customer_id: { $in: customerIds }, user_id: toOid(userId) } },
      { $group: { _id: '$customer_id', totalPaid: { $sum: { $ifNull: ['$amount_received', 0] } } } }
    ])
  ]);

  const billMap = {};
  for (const b of billsByCustomer) {
    const cid = String(b.customer_id);
    if (!billMap[cid]) billMap[cid] = [];
    billMap[cid].push(b);
  }
  const payMap = {};
  for (const p of paymentAgg) payMap[String(p._id)] = p.totalPaid;

  return customers.map(customer => {
    const cid = String(customer._id);
    const bills = billMap[cid] || [];
    const { held: cylindersHeld } = computeHoldings(bills);
    const totalBilled = bills.reduce((sum, bill) => sum + (bill.total_bill_amount || 0), 0);
    const totalPaid = payMap[cid] || 0;

    return {
      customer_id: customer._id,
      company_name: customer.company_name,
      contact_person: customer.contact_person,
      phone_primary: customer.phone_primary || '',
      gst_number: customer.gst_number || '',
      security_deposit: customer.security_deposit || 0,
      holding_limit: customer.holding_limit || 0,
      is_filling_vendor: !!customer.is_filling_vendor,
      bill_amount: totalBilled - totalPaid,
      cylinder_hold: cylindersHeld,
      status: (!customer.is_filling_vendor && cylindersHeld > (customer.holding_limit || 0)) ? 'OVER LIMIT' : ''
    };
  });
}

async function getLedgerReport(userId) {
  return getCustomerLedgerData(userId);
}

async function getOverLimitReport(userId) {
  const ledgerData = await getCustomerLedgerData(userId);
  const overLimit = ledgerData.filter(c => c.status === 'OVER LIMIT');

  return overLimit.map(c => ({
    customer_id: c.customer_id,
    company_name: c.company_name,
    contact_person: c.contact_person,
    phone_primary: c.phone_primary || '',
    holding_limit: c.holding_limit || 0,
    cylinders_held: c.cylinder_hold || 0
  }));
}

async function getDailyReport(userId, date) {
  if (!date) {
    throw new HttpError(400, 'Date parameter is required');
  }

  const startDate = new Date(date);
  const endDate = new Date(date);
  endDate.setHours(23, 59, 59, 999);

  const bills = await Bill.find({
    user_id: userId,
    bill_date: { $gte: startDate, $lte: endDate }
  })
  .populate('customer_id', 'company_name phone_primary')
  .sort('-createdAt')
  .lean();

  return bills.map(bill => ({
    ...bill,
    company_name: bill.customer_id ? bill.customer_id.company_name : '',
    phone_primary: bill.customer_id ? bill.customer_id.phone_primary : ''
  }));
}

async function getCylinderStockReport(userId) {
  const results = await Bill.aggregate([
    { $match: { user_id: toOid(userId) } },
    { $unwind: '$line_items' },
    { $match: { 'line_items.direction': { $in: ['GIVEN', 'RECEIVED'] } } },
    { $group: {
      _id: {
        gas: { $ifNull: ['$line_items.gas_type_name', ''] },
        size: { $ifNull: ['$line_items.size_label', ''] }
      },
      total_given: { $sum: { $cond: [{ $eq: ['$line_items.direction', 'GIVEN'] }, '$line_items.quantity', 0] } },
      total_received: { $sum: { $cond: [{ $eq: ['$line_items.direction', 'RECEIVED'] }, '$line_items.quantity', 0] } }
    } },
    { $project: {
      _id: 0,
      gas_type_name: '$_id.gas',
      size_label: '$_id.size',
      total_given: 1,
      total_received: 1,
      currently_out: { $subtract: ['$total_given', '$total_received'] }
    } },
    { $sort: { gas_type_name: 1, size_label: 1 } }
  ]);

  return results;
}

async function getOutstandingReport(userId) {
  const customers = await Customer.find({
    user_id: userId,
    is_filling_vendor: { $ne: true }
  }).sort('company_name').lean();

  const customerIds = customers.map(c => c._id);

  const [billAgg, paymentAgg] = await Promise.all([
    Bill.aggregate([
      { $match: { customer_id: { $in: customerIds }, user_id: toOid(userId) } },
      { $group: { _id: '$customer_id', totalBilled: { $sum: { $ifNull: ['$total_bill_amount', 0] } } } }
    ]),
    Payment.aggregate([
      { $match: { customer_id: { $in: customerIds }, user_id: toOid(userId) } },
      { $group: { _id: '$customer_id', totalPaid: { $sum: { $ifNull: ['$amount_received', 0] } } } }
    ])
  ]);

  const billMap = {};
  for (const b of billAgg) billMap[String(b._id)] = b.totalBilled;
  const payMap = {};
  for (const p of paymentAgg) payMap[String(p._id)] = p.totalPaid;

  const outstandingData = [];
  for (const customer of customers) {
    const cid = String(customer._id);
    const totalBilled = billMap[cid] || 0;
    const totalPaid = payMap[cid] || 0;
    const outstanding = totalBilled - totalPaid;

    if (outstanding > 0) {
      outstandingData.push({
        customer_id: customer._id,
        company_name: customer.company_name,
        contact_person: customer.contact_person || '',
        phone_primary: customer.phone_primary || '',
        customer_type: customer.customer_type,
        total_billed: totalBilled,
        total_paid: totalPaid,
        outstanding_amount: outstanding
      });
    }
  }

  outstandingData.sort((a, b) => b.outstanding_amount - a.outstanding_amount);
  return outstandingData;
}

async function getDepositsReport(userId) {
  const customers = await Customer.find(
    { user_id: userId, customer_type: 'REGULAR', security_deposit: { $gt: 0 } },
    { company_name: 1, contact_person: 1, phone_primary: 1, security_deposit: 1 }
  ).sort('company_name').lean();

  return customers.map(c => ({
    customer_id: c._id,
    company_name: c.company_name,
    contact_person: c.contact_person || '',
    phone_primary: c.phone_primary || '',
    security_deposit: c.security_deposit || 0
  }));
}

async function getCustomerStatement(userId, customerId, startDateStr, endDateStr) {
  const billQuery = { customer_id: customerId, user_id: userId };
  const paymentQuery = { customer_id: customerId, user_id: userId };

  if (startDateStr && endDateStr) {
    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    endDate.setHours(23, 59, 59, 999);

    billQuery.bill_date = { $gte: startDate, $lte: endDate };
    paymentQuery.date = { $gte: startDate, $lte: endDate };
  }

  const [bills, payments] = await Promise.all([
    Bill.find(billQuery, { bill_date: 1, bill_number: 1, transaction_type: 1, total_bill_amount: 1, remarks: 1 }).lean(),
    Payment.find(paymentQuery, { date: 1, receipt_number: 1, payment_mode: 1, amount_received: 1, remarks: 1 }).lean()
  ]);

  const statement = [];

  bills.forEach(bill => {
    statement.push({
      date: bill.bill_date,
      bill_number: bill.bill_number,
      transaction_type: bill.transaction_type,
      type: 'BILL',
      debit: bill.total_bill_amount,
      credit: 0,
      remarks: bill.remarks
    });
  });

  payments.forEach(payment => {
    statement.push({
      date: payment.date,
      receipt_number: payment.receipt_number,
      payment_mode: payment.payment_mode,
      type: 'PAYMENT',
      debit: 0,
      // Phase 14: a payment settles its gross amount_received (= net + discount).
      credit: payment.amount_received,
      remarks: payment.remarks
    });
  });

  statement.sort((a, b) => new Date(b.date) - new Date(a.date));

  return statement;
}

// ─── Phase 5: DSR (Daily Sales Report) ───
// One date at a time, auto-populated live from bill data (drafts + internal transfers excluded).
// location omitted / 'ALL' → all sites; otherwise that site's CUSTOMER bills only.
// reporting_person auto-fills from the site's LocationProfile manager.
async function getDSR(uid, { date, location }) {
  const day = date ? new Date(date) : new Date();
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);

  const loc = LOCATIONS.includes(location) ? location : null;

  // Phase 24: a site's DSR must also show stock it sent out to the other sites that day.
  // Internal transfers carry from_location/to_location instead of location, so a plain
  // { location: loc } match never saw them and the blanket $ne excluded them everywhere.
  // With a site selected: that site's customer bills PLUS transfers originating there.
  // With ALL selected: customer bills only, unchanged — a transfer is an internal move, and
  // counting it alongside every site's sales would inflate the combined day's figures.
  const query = {
    user_id: uid,
    is_draft: { $ne: true },
    bill_date: { $gte: start, $lte: end }
  };
  if (loc) {
    // Phase 31: a site's DSR must show EVERY transfer touching it — both outgoing (this site as
    // source) and incoming (this site as destination) — not just outgoing. Categorization below
    // then places each into the correct columns for the physical direction at THIS site.
    query.$or = [
      { transaction_category: { $ne: 'INTERNAL_TRANSFER' }, location: loc },
      { transaction_category: 'INTERNAL_TRANSFER', $or: [{ from_location: loc }, { to_location: loc }] }
    ];
  } else {
    query.transaction_category = { $ne: 'INTERNAL_TRANSFER' };
  }

  const bills = await Bill.find(query)
    .populate('customer_id', 'company_name')
    .sort('createdAt')
    .lean();

  // One row per bill per gas×size, with PC (personal cylinders) as their own columns.
  const rows = [];
  const totals = { filled_qty: 0, empty_qty: 0, pc_in: 0, pc_out: 0, amount: 0 };
  const transferTotals = { filled_qty: 0, empty_qty: 0, pc_in: 0, pc_out: 0, amount: 0 };
  // Phase 32: direct Palanpur↔Chhapi transfers (neither endpoint Chandisar) don't fit the
  // Chandisar-anchored fill/empty rule — collect them so the caller can flag them for a decision.
  const CHANDISAR = 'AT_PLANT_CHANDISAR';
  const flaggedTransfers = [];
  for (const b of bills) {
    const isTransfer = b.transaction_category === 'INTERNAL_TRANSFER';
    // Phase 32 — transfer classification is anchored to Chandisar (the ONLY site that fills),
    // NOT to which DSR is being viewed. A transfer FROM Chandisar is filled stock going out to a
    // sub-office (→ Filled / PC Out); a transfer TO Chandisar is empties coming back for refill
    // (→ Empty / PC In). A direct Palanpur↔Chhapi transfer fits neither and is left unclassified.
    const fromChandisar = isTransfer && b.from_location === CHANDISAR;
    const toChandisar = isTransfer && b.to_location === CHANDISAR;
    const transferUnclassified = isTransfer && !fromChandisar && !toChandisar;
    if (transferUnclassified) {
      flaggedTransfers.push({
        bill_id: String(b._id), bill_number: b.bill_number,
        from_location: b.from_location, to_location: b.to_location, bill_date: b.bill_date
      });
    }
    const byCombo = {};
    for (const li of b.line_items) {
      const gas = li.gas_type_name || '';
      const size = li.size_label || '';
      const key = gas + '|' + size;
      if (!byCombo[key]) {
        byCombo[key] = {
          bill_id: String(b._id),
          bill_number: b.bill_number, challan_no: b.challan_no || '',
          // For a transfer show the site THIS DSR is for; the ALL view never shows transfers.
          location: isTransfer ? (loc || b.from_location) : b.location,
          // Phase 31: name both endpoints explicitly, e.g. "Internal Transfer: Chandisar Plant → Palanpur Office".
          customer_name: isTransfer
            ? `Internal Transfer: ${LOCATION_LABELS[b.from_location] || b.from_location} → ${LOCATION_LABELS[b.to_location] || b.to_location}`
            : (b.customer_id ? b.customer_id.company_name : ''),
          is_transfer: isTransfer,
          from_location: isTransfer ? b.from_location : undefined,
          to_location: isTransfer ? b.to_location : undefined,
          // OUT = filled leaving Chandisar; IN = empties returning to Chandisar; REVIEW = direct sub-office move.
          transfer_direction: isTransfer ? (fromChandisar ? 'OUT' : toChandisar ? 'IN' : 'REVIEW') : undefined,
          needs_review: !!transferUnclassified,
          vehicle_number: b.vehicle_number || '', // Phase 27
          gas_type: gas, size,
          filled_qty: 0, empty_qty: 0, pc_in: 0, pc_out: 0, amount: 0,
          remarks: ''
        };
      }
      const r = byCombo[key];
      if (!r.remarks && li.remarks) r.remarks = li.remarks; // per-row DSR note (Phase 10)
      if (isTransfer) {
        // Phase 32 — Chandisar-anchored (see above). Only Chandisar fills, so its outgoing
        // transfers are always Filled/PC Out and its incoming ones always Empty/PC In.
        const pcMoved = li.personalCylindersIn || 0; // transfer PC lines store qty here
        if (fromChandisar) {
          if (li.serial_number) r.filled_qty += li.quantity || 0;
          r.pc_out += pcMoved;
        } else if (toChandisar) {
          if (li.serial_number) r.empty_qty += li.quantity || 0;
          r.pc_in += pcMoved;
        }
        // Unclassified (Palanpur↔Chhapi): leave Filled/Empty/PC blank; the row is flagged above.
      } else {
        if (li.direction === 'GIVEN') { r.filled_qty += li.quantity || 0; r.amount += li.amount || 0; }
        if (li.direction === 'RECEIVED') r.empty_qty += li.quantity || 0;
        r.pc_in += li.personalCylindersIn || 0;   // PC taken from customer (arrives empty)
        r.pc_out += li.personalCylindersOut || 0; // PC returned (refilled) to customer (leaves filled)
      }
    }
    Object.values(byCombo).forEach(r => {
      rows.push(r);
      // Phase 25: the total row must account for every row shown, transfers included — a total
      // that silently omitted visible rows was the reported bug. transfer_totals is kept as an
      // additional breakdown so the transfer share of the total stays inspectable.
      totals.filled_qty += r.filled_qty; totals.empty_qty += r.empty_qty;
      totals.pc_in += r.pc_in; totals.pc_out += r.pc_out; totals.amount += r.amount;
      if (r.is_transfer) {
        transferTotals.filled_qty += r.filled_qty; transferTotals.empty_qty += r.empty_qty;
        transferTotals.pc_in += r.pc_in; transferTotals.pc_out += r.pc_out;
        transferTotals.amount += r.amount;
      }
    });
  }

  let reporting_person = '';
  if (loc) {
    const profile = await LocationProfile.findOne({ user_id: uid, location: loc });
    reporting_person = (profile && profile.manager_name) || '';
  }

  return {
    date: start,
    location: loc || 'ALL',
    location_label: loc ? LOCATION_LABELS[loc] : 'All Locations',
    reporting_person,
    rows,
    totals,
    transfer_totals: transferTotals,
    // Phase 32: direct Palanpur↔Chhapi transfers that the Chandisar-anchored rule can't classify.
    flagged_transfers: flaggedTransfers
  };
}

// Gas grouping merges O2/MO2/Medical Oxygen into "Oxygen"; blank capacity defaults to 7 m3.
function stockGasKey(name) {
  const n = String(name || '').trim().toUpperCase();
  if (n === 'O2' || n === 'MO2' || n.includes('OXYGEN')) return 'Oxygen';
  return String(name || '').trim() || 'Unknown';
}
const stockCapKey = (cap) => String(cap || '').trim() || '7 m3';

// ─── Stock Summary (Phase 32 rebuild — independent per-location ledger) ───
// Serialized cylinders ONLY (personal cylinders live in their own section, never here).
// Each site keeps two running ledgers (Filled, Empty) where Closing = Opening + In − Out and
// Opening[day] = Closing[day-1]. Both invariants hold BY CONSTRUCTION: we anchor Closing(today)
// to the actual current physical stock, then derive any requested day's Closing by backing out
// the net movements that happened AFTER it, and its Opening by further backing out that day's
// own movements. So the split between days is exact regardless of the absolute anchor.
//
// Movement classification is anchored to Chandisar — the ONLY site that fills cylinders:
//   Chandisar Filled:  In  = filled on-site today + filled cylinders returned from filling vendors
//                      Out = filled given to (non-vendor) customers + filled transferred out to sub-offices
//   Chandisar Empty:   In  = empties returned by customers + empties transferred in from sub-offices
//                      Out = filled on-site today (leaves the empty pool) + empties sent to filling vendors
//   Palanpur/Chhapi Filled: In = filled transferred in from Chandisar; Out = filled given to customers
//   Palanpur/Chhapi Empty:  In = empties returned by customers;       Out = empties transferred to Chandisar
// (Sub-offices never fill, so their Filled "In" is only transfers-in; direct sub-office↔sub-office
//  transfers don't fit the model and are ignored here — the DSR flags them for a decision.)
async function getStockSummary(uid, { date, location }) {
  if (!LOCATIONS.includes(location)) throw new HttpError(400, 'A valid location is required');
  const CHANDISAR = 'AT_PLANT_CHANDISAR';
  const isChandisar = location === CHANDISAR;
  const FillingLogEntry = require('../models/FillingLogEntry');

  const day = date ? new Date(date) : new Date();
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);
  const y = start.getFullYear(), mo = String(start.getMonth() + 1).padStart(2, '0'), d = String(start.getDate()).padStart(2, '0');
  const dayStr = `${y}-${mo}-${d}`; // filling-log dates are 'YYYY-MM-DD' strings

  const [cylinders, bills, vendors, fills] = await Promise.all([
    Cylinder.find({ user_id: uid }, { rotational_number: 1, gas_type: 1, capacity: 1, location: 1, stock_state: 1 }).lean(),
    Bill.find({ user_id: uid, is_draft: { $ne: true } },
      { bill_date: 1, location: 1, from_location: 1, to_location: 1, customer_id: 1,
        transaction_category: 1, 'line_items.serial_number': 1, 'line_items.direction': 1,
        'line_items.gas_type_name': 1, 'line_items.size_label': 1, 'line_items.quantity': 1 }
    ).sort('bill_date createdAt').lean(),
    Customer.find({ user_id: uid, is_filling_vendor: true }, { _id: 1 }).lean(),
    FillingLogEntry.find({ user_id: uid }, { date: 1, gas_type: 1, capacity: 1, rotational_number: 1 }).lean()
  ]);
  const vendorIds = new Set(vendors.map(v => String(v._id)));

  const table = {};
  const rowFor = (gas, cap) => {
    const key = gas + '|' + cap;
    if (!table[key]) {
      table[key] = {
        gas_type: gas, capacity: cap,
        // in/out split into onDay vs afterDay so Opening/Closing back out cleanly from the anchor.
        _f: { anchor: 0, inOn: 0, outOn: 0, inAfter: 0, outAfter: 0 },
        _e: { anchor: 0, inOn: 0, outOn: 0, inAfter: 0, outAfter: 0 }
      };
    }
    return table[key];
  };
  const addF = (gas, cap, field, n) => { rowFor(gas, cap)._f[field] += n; };
  const addE = (gas, cap, field, n) => { rowFor(gas, cap)._e[field] += n; };

  // ── Anchor: current physical stock in-stock AT this location, split filled/empty. ──
  // A cylinder is EMPTY when its most recent event left it empty: a customer RETURN (RECEIVED),
  // or a transfer INTO Chandisar (empties returned by a sub-office, awaiting refill). It is
  // FILLED after an on-site FILL (filling log), a transfer OUT of Chandisar (filled stock sent
  // to a sub-office), or when it has no history (fresh import assumed filled). This is the site's
  // true current stock = Closing(today).
  const lastEvt = {}; // serial -> { t, empty }
  const bump = (serial, t, empty) => {
    const cur = lastEvt[serial];
    if (!cur || new Date(t) >= new Date(cur.t)) lastEvt[serial] = { t, empty };
  };
  for (const b of bills) {
    for (const li of b.line_items) {
      if (!li.serial_number) continue;
      if (b.transaction_category === 'INTERNAL_TRANSFER') {
        if (b.to_location === CHANDISAR) bump(li.serial_number, b.bill_date, true);        // empties back to plant
        else if (b.from_location === CHANDISAR) bump(li.serial_number, b.bill_date, false); // filled sent out
        // sub-office↔sub-office: leave state unchanged
      } else {
        bump(li.serial_number, b.bill_date, li.direction === 'RECEIVED'); // returned empty vs given filled
      }
    }
  }
  // Filling-log fills mark a cylinder filled; dated end-of-day so a same-day fill beats a same-day transfer-in.
  for (const f of fills) {
    if (!f.rotational_number) continue;
    bump(f.rotational_number, new Date(`${f.date}T23:59:59.500`), false);
  }
  for (const c of cylinders) {
    if (c.stock_state !== 'IN_STOCK' || c.location !== location) continue;
    const gas = stockGasKey(c.gas_type), cap = stockCapKey(c.capacity);
    const empty = !!(lastEvt[c.rotational_number] && lastEvt[c.rotational_number].empty);
    if (empty) addE(gas, cap, 'anchor', 1); else addF(gas, cap, 'anchor', 1);
  }

  // ── Movements from bills (serialized lines only). Bucket each into on-day vs after-day. ──
  const bucketOf = (t) => { const dt = new Date(t); if (dt >= start && dt <= end) return 'On'; if (dt > end) return 'After'; return null; };
  for (const b of bills) {
    const bkt = bucketOf(b.bill_date);
    if (!bkt) continue; // before the requested day — already folded into the anchor
    const isTransfer = b.transaction_category === 'INTERNAL_TRANSFER';
    if (isTransfer) {
      const from = b.from_location, to = b.to_location;
      // Only transfers with a Chandisar endpoint are classified (sub-office↔sub-office ignored).
      const touchesHereChandisar = isChandisar && (from === CHANDISAR || to === CHANDISAR);
      const touchesHereSub = !isChandisar && ((from === location && to === CHANDISAR) || (to === location && from === CHANDISAR));
      if (!touchesHereChandisar && !touchesHereSub) continue;
      for (const li of b.line_items) {
        if (!li.serial_number) continue; // serialized only
        const qty = li.quantity || 0; if (!qty) continue;
        const gas = stockGasKey(li.gas_type_name), cap = stockCapKey(li.size_label);
        if (isChandisar) {
          if (from === CHANDISAR) addF(gas, cap, 'out' + bkt, qty);       // filled out to a sub-office
          else if (to === CHANDISAR) addE(gas, cap, 'in' + bkt, qty);     // empties back for refill
        } else {
          if (to === location && from === CHANDISAR) addF(gas, cap, 'in' + bkt, qty);   // filled arrives
          else if (from === location && to === CHANDISAR) addE(gas, cap, 'out' + bkt, qty); // empties sent to Chandisar
        }
      }
    } else {
      if (b.location !== location) continue;
      const isVendor = b.customer_id && vendorIds.has(String(b.customer_id));
      for (const li of b.line_items) {
        if (!li.serial_number) continue; // serialized only
        const qty = li.quantity || 0; if (!qty) continue;
        const gas = stockGasKey(li.gas_type_name), cap = stockCapKey(li.size_label);
        if (li.direction === 'GIVEN') {
          if (isChandisar && isVendor) addE(gas, cap, 'out' + bkt, qty);  // empties sent to filling vendor
          else addF(gas, cap, 'out' + bkt, qty);                          // filled given to customer
        } else if (li.direction === 'RECEIVED') {
          if (isChandisar && isVendor) addF(gas, cap, 'in' + bkt, qty);   // vendor returns filled
          else addE(gas, cap, 'in' + bkt, qty);                           // empty back from customer
        }
      }
    }
  }

  // ── Filling log (Chandisar only): each fill adds to Filled In and removes from Empty (Out). ──
  if (isChandisar) {
    for (const f of fills) {
      const bkt = f.date === dayStr ? 'On' : (f.date > dayStr ? 'After' : null);
      if (!bkt) continue;
      const gas = stockGasKey(f.gas_type), cap = stockCapKey(f.capacity);
      addF(gas, cap, 'in' + bkt, 1);   // filled today → enters filled pool
      addE(gas, cap, 'out' + bkt, 1);  // …and leaves the empty pool
    }
  }

  // ── Resolve each ledger: Closing(today)=anchor; back out after-day and on-day movements. ──
  const rows = Object.values(table).map(r => {
    const resolve = (m) => {
      const closing = m.anchor - (m.inAfter - m.outAfter);
      const opening = closing - (m.inOn - m.outOn);
      return { opening, in: m.inOn, out: m.outOn, closing };
    };
    const f = resolve(r._f), e = resolve(r._e);
    return {
      gas_type: r.gas_type, capacity: r.capacity,
      filled: { opening: f.opening, add: f.in, issue: f.out, closing: f.closing },
      empty: { opening: e.opening, receive: e.in, issue: e.out, closing: e.closing }
    };
  }).filter(r => // drop all-zero rows (no stock and no movement for this combo on/around this day)
    r.filled.opening || r.filled.add || r.filled.issue || r.filled.closing ||
    r.empty.opening || r.empty.receive || r.empty.issue || r.empty.closing
  ).sort((a, b) => a.gas_type === b.gas_type ? a.capacity.localeCompare(b.capacity) : a.gas_type.localeCompare(b.gas_type));

  return {
    date: start,
    location,
    location_label: LOCATION_LABELS[location],
    // Sub-offices never fill — their Filled "In" is purely transfers received from Chandisar.
    filled_add_label: isChandisar ? 'Filled Today' : 'Add (Transfers In from Chandisar)',
    empty_issue_label: isChandisar ? 'Issue (Filled Today + Sent to Vendors)' : 'Issue (Transfers Out to Chandisar)',
    rows
  };
}

module.exports = {
  getDSR,
  getStockSummary,
  getCustomerLedgerData,
  getLedgerReport,
  getOverLimitReport,
  getDailyReport,
  getCylinderStockReport,
  getOutstandingReport,
  getDepositsReport,
  getCustomerStatement,
  getPcStock
};
