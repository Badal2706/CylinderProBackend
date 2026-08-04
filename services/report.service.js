const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const Cylinder = require('../models/Cylinder');
const LocationProfile = require('../models/LocationProfile');
const HttpError = require('../utils/HttpError');
const { computeHoldings } = require('./holdings.service');
const { LOCATIONS, LOCATION_LABELS } = require('../config/locations');
const { countsByCombo } = require('./fillingLog.service');
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
    query.$or = [
      { transaction_category: { $ne: 'INTERNAL_TRANSFER' }, location: loc },
      { transaction_category: 'INTERNAL_TRANSFER', from_location: loc }
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
  for (const b of bills) {
    const isTransfer = b.transaction_category === 'INTERNAL_TRANSFER';
    const byCombo = {};
    for (const li of b.line_items) {
      const gas = li.gas_type_name || '';
      const size = li.size_label || '';
      const key = gas + '|' + size;
      if (!byCombo[key]) {
        byCombo[key] = {
          bill_id: String(b._id),
          bill_number: b.bill_number, challan_no: b.challan_no || '',
          // A transfer has no `location` and no customer — show where it went instead, so the
          // row reads as "stock sent to Palanpur Office" rather than a blank customer line.
          location: isTransfer ? b.from_location : b.location,
          customer_name: isTransfer
            ? `→ ${LOCATION_LABELS[b.to_location] || b.to_location} (Internal Transfer)`
            : (b.customer_id ? b.customer_id.company_name : ''),
          is_transfer: isTransfer,
          to_location: isTransfer ? b.to_location : undefined,
          gas_type: gas, size,
          filled_qty: 0, empty_qty: 0, pc_in: 0, pc_out: 0, amount: 0,
          remarks: ''
        };
      }
      const r = byCombo[key];
      if (!r.remarks && li.remarks) r.remarks = li.remarks; // per-row DSR note (Phase 10)
      if (li.direction === 'GIVEN') { r.filled_qty += li.quantity || 0; r.amount += li.amount || 0; }
      if (li.direction === 'RECEIVED') r.empty_qty += li.quantity || 0;
      // Internal-transfer items carry direction 'TRANSFER' — neither given nor received. Count
      // them as the quantity moved out so the row shows a number instead of a blank 0, and note
      // that this only ever lands in transfer_totals, never in the sales totals.
      if (li.direction === 'TRANSFER') r.filled_qty += li.quantity || 0;
      r.pc_in += li.personalCylindersIn || 0;   // PC taken from customer
      r.pc_out += li.personalCylindersOut || 0; // PC returned (refilled) to customer
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
    transfer_totals: transferTotals
  };
}

// ─── Phase 5: Stock Summary (Filled + Empty tables per location per day) ───
// Best-effort model (revisit after use):
//   • Every cylinder movement comes from bills (customer GIVEN/RECEIVED, internal TRANSFER).
//   • A cylinder counts as EMPTY while its most recent event is a customer return (RECEIVED);
//     otherwise FILLED (fresh imports and transfer-dispatched cylinders are assumed filled;
//     Chandisar refills happen implicitly at give-out since no fill event exists in the data).
//   • Opening/Closing are replayed states at the day's boundaries; Add/Issue-Receive are the
//     day's actual movements at that site.
// Gas grouping merges O2/MO2/Medical Oxygen into "Oxygen"; blank capacity defaults to 7 m3.
function stockGasKey(name) {
  const n = String(name || '').trim().toUpperCase();
  if (n === 'O2' || n === 'MO2' || n.includes('OXYGEN')) return 'Oxygen';
  return String(name || '').trim() || 'Unknown';
}
const stockCapKey = (cap) => String(cap || '').trim() || '7 m3';

async function getStockSummary(uid, { date, location }) {
  if (!LOCATIONS.includes(location)) throw new HttpError(400, 'A valid location is required');
  const day = date ? new Date(date) : new Date();
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setHours(23, 59, 59, 999);

  const [cylinders, bills] = await Promise.all([
    Cylinder.find({ user_id: uid }, { rotational_number: 1, gas_type: 1, capacity: 1, location: 1, stock_state: 1 }).lean(),
    Bill.find({ user_id: uid, is_draft: { $ne: true } },
      { bill_date: 1, location: 1, from_location: 1, to_location: 1, customer_id: 1,
        transaction_category: 1, 'line_items.serial_number': 1, 'line_items.direction': 1,
        'line_items.gas_type_name': 1, 'line_items.size_label': 1, 'line_items.quantity': 1 }
    ).sort('bill_date createdAt').lean()
  ]);

  // Chronological event list per rotational number.
  const events = {}; // serial -> [{ t, type, loc, from, to }]
  for (const b of bills) {
    for (const li of b.line_items) {
      if (!li.serial_number) continue;
      const list = events[li.serial_number] || (events[li.serial_number] = []);
      if (li.direction === 'TRANSFER') list.push({ t: b.bill_date, type: 'TRANSFER', from: b.from_location, to: b.to_location });
      else list.push({ t: b.bill_date, type: li.direction, loc: b.location });
    }
  }

  // State of one cylinder at time T: undo every event after T starting from its current doc.
  const stateAt = (c, T) => {
    const evts = events[c.rotational_number] || [];
    let loc = c.location;
    let inStock = c.stock_state === 'IN_STOCK';
    for (let i = evts.length - 1; i >= 0; i--) {
      const e = evts[i];
      if (new Date(e.t) <= T) break;
      if (e.type === 'TRANSFER') loc = e.from;
      else if (e.type === 'GIVEN') { inStock = true; if (e.loc) loc = e.loc; }
      else if (e.type === 'RECEIVED') { inStock = false; }
    }
    // Empty while the last event ≤ T is a customer return.
    let last = null;
    for (const e of evts) { if (new Date(e.t) <= T) last = e; else break; }
    const empty = !!last && last.type === 'RECEIVED';
    return { loc, inStock, empty };
  };

  const table = {}; // gas|cap -> { gas, capacity, filled:{opening,add,issue,closing}, empty:{opening,receive,issue,closing} }
  const rowFor = (gas, cap) => {
    const key = gas + '|' + cap;
    if (!table[key]) {
      table[key] = {
        gas_type: gas, capacity: cap,
        filled: { opening: 0, add: 0, issue: 0, closing: 0 },
        empty: { opening: 0, receive: 0, issue: 0, closing: 0 }
      };
    }
    return table[key];
  };

  const openingT = new Date(start.getTime() - 1);
  for (const c of cylinders) {
    const gas = stockGasKey(c.gas_type), cap = stockCapKey(c.capacity);
    const open = stateAt(c, openingT);
    const close = stateAt(c, end);
    if (open.inStock && open.loc === location) rowFor(gas, cap)[open.empty ? 'empty' : 'filled'].opening++;
    if (close.inStock && close.loc === location) rowFor(gas, cap)[close.empty ? 'empty' : 'filled'].closing++;

    // Day movements at this site for this cylinder.
    const evts = events[c.rotational_number] || [];
    for (const e of evts) {
      const t = new Date(e.t);
      if (t < start || t > end) continue;
      const r = rowFor(gas, cap);
      if (e.type === 'GIVEN' && e.loc === location) r.filled.issue++;           // issued (filled) to customer
      else if (e.type === 'RECEIVED' && e.loc === location) r.empty.receive++;  // came back empty
      else if (e.type === 'TRANSFER') {
        // Classify the transferred cylinder by its state just before the transfer.
        const before = stateAt(c, new Date(t.getTime() - 1));
        if (e.to === location) r[before.empty ? 'empty' : 'filled'][before.empty ? 'receive' : 'add']++;
        if (e.from === location) r[before.empty ? 'empty' : 'filled'].issue++;
      }
    }
  }

  // Chandisar's Filled "Add" is "Filled Today" from the daily filling log (Phase 11) —
  // Chandisar never receives filled stock from elsewhere, it fills on-site. Other locations
  // keep transfers-in as their Add figure.
  const isChandisar = location === 'AT_PLANT_CHANDISAR';
  if (isChandisar) {
    const y = start.getFullYear(), m = String(start.getMonth() + 1).padStart(2, '0'), d = String(start.getDate()).padStart(2, '0');
    const fillCounts = await countsByCombo(uid, `${y}-${m}-${d}`);
    Object.values(table).forEach(r => { r.filled.add = 0; });
    for (const [key, n] of Object.entries(fillCounts)) {
      const [g, cap] = key.split('|');
      rowFor(stockGasKey(g), stockCapKey(cap)).filled.add = n;
    }

    // Empty Stock "Issue" (Phase 12) = empties leaving the empty pool that day:
    //   (a) cylinders sent to filling-vendor customers (GIVEN quantities on vendor bills), plus
    //   (b) the day's Filling List entries (filled on-site — same data as "Filled Today" above,
    //       so the two rows stay in sync by construction).
    const vendors = await Customer.find({ user_id: uid, is_filling_vendor: true }, { _id: 1 });
    const vendorIds = new Set(vendors.map(v => String(v._id)));
    Object.values(table).forEach(r => { r.empty.issue = 0; });
    for (const [key, n] of Object.entries(fillCounts)) {
      const [g, cap] = key.split('|');
      rowFor(stockGasKey(g), stockCapKey(cap)).empty.issue += n;
    }
    if (vendorIds.size) {
      for (const b of bills) {
        if (b.transaction_category === 'INTERNAL_TRANSFER') continue;
        if (b.location !== location) continue;
        const t = new Date(b.bill_date);
        if (t < start || t > end) continue;
        if (!b.customer_id || !vendorIds.has(String(b.customer_id))) continue;
        for (const li of b.line_items) {
          if (li.direction !== 'GIVEN' || !(li.quantity > 0)) continue;
          rowFor(stockGasKey(li.gas_type_name), stockCapKey(li.size_label)).empty.issue += li.quantity;
        }
      }
    }
  }

  const rows = Object.values(table).sort((a, b) =>
    a.gas_type === b.gas_type ? a.capacity.localeCompare(b.capacity) : a.gas_type.localeCompare(b.gas_type));

  return {
    date: start,
    location,
    location_label: LOCATION_LABELS[location],
    filled_add_label: isChandisar ? 'Filled Today' : 'Add (Transfers In)',
    empty_issue_label: isChandisar ? 'Issue (Filled Today + Sent to Vendors)' : 'Issue (Transfers Out)',
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
