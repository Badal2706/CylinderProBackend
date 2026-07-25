const Bill = require('../models/Bill');
const Cylinder = require('../models/Cylinder');
const Customer = require('../models/Customer');
const RentalCharge = require('../models/RentalCharge');
const HttpError = require('../utils/HttpError');

const DAY_MS = 86400000;
const daysBetween = (from, to) => Math.max(0, Math.floor((to - new Date(from).getTime()) / DAY_MS));

// Per-customer aging: every cylinder this customer currently holds, with days-held and the
// issuing location. Holder resolution matches the global aging report: the most recent GIVEN
// line (not yet returned) per rotational number determines the current holder — so cylinders
// returned on this customer's behalf by someone else are correctly excluded.
async function getCustomerAging(uid, customerId) {
  const customer = await Customer.findOne({ _id: customerId, user_id: uid });
  if (!customer) throw new HttpError(404, 'Customer not found');

  const bills = await Bill.find({ user_id: uid }).sort('-bill_date -createdAt');

  // Latest unreturned GIVEN line per rotational number (across ALL customers).
  const latestGiven = {};
  for (const bill of bills) {
    for (const li of bill.line_items) {
      if (li.direction === 'GIVEN' && !li.returned_via && li.serial_number && latestGiven[li.serial_number] === undefined) {
        latestGiven[li.serial_number] = { bill, line: li };
      }
    }
  }

  const cylinders = await Cylinder.find({ user_id: uid, stock_state: 'AT_CUSTOMER' });
  const now = Date.now();
  const rows = [];

  for (const c of cylinders) {
    const rec = latestGiven[c.rotational_number];
    if (!rec || String(rec.bill.customer_id) !== String(customerId)) continue;

    const dateGiven = rec.bill.bill_date;
    // Chargeable window starts at the later of: this holding's start, or what has already
    // been charged (rental_charged_through) — a stale value from an older holding loses to max().
    const chargedThrough = c.rental_charged_through;
    const chargeFrom = (chargedThrough && new Date(chargedThrough) > new Date(dateGiven)) ? chargedThrough : dateGiven;

    rows.push({
      cylinder_id: c._id,
      serial_number: c.rotational_number,
      physical_number: c.physical_number || '',
      gas_type: c.gas_type,
      capacity: c.capacity,
      location: c.location, // issuing site (stamped by the GIVEN bill's location)
      date_given: dateGiven,
      days_held: daysBetween(dateGiven, now),
      bill_number: rec.bill.bill_number,
      rental_charged_through: chargedThrough,
      charge_from: chargeFrom,
      // Days not yet billed — the base for the rental calculator.
      days_unbilled: daysBetween(chargeFrom, now),
      rate: rec.line.rate || 0
    });
  }

  rows.sort((a, b) => b.days_held - a.days_held);
  return rows;
}

// Generate + persist a rental charge for the selected cylinders.
// days_charged = max(0, days_unbilled - free_days); amount = days_charged × rate_per_day.
// Advances rental_charged_through = now on each included cylinder (and nothing else —
// Bill/Payment/receivables are untouched in this phase).
async function generateRentalCharge(uid, customerId, { free_days, rate_per_day, serial_numbers }) {
  const freeDays = Number(free_days);
  const rate = Number(rate_per_day);
  if (!Number.isFinite(freeDays) || freeDays < 0) throw new HttpError(400, 'Free days must be a number ≥ 0');
  if (!Number.isFinite(rate) || rate < 0) throw new HttpError(400, 'Rate per day must be a number ≥ 0');

  const selected = [...new Set((serial_numbers || []).map(s => String(s).trim()).filter(Boolean))];
  if (!selected.length) throw new HttpError(400, 'Select at least one cylinder to charge');

  const rows = await getCustomerAging(uid, customerId); // re-validated server-side
  const byRot = {};
  rows.forEach(r => { byRot[r.serial_number] = r; });

  const now = new Date();
  const lineItems = [];
  for (const s of selected) {
    const r = byRot[s];
    if (!r) throw new HttpError(400, `Cylinder "${s}" is not currently held by this customer`);
    const daysCharged = Math.max(0, r.days_unbilled - freeDays);
    lineItems.push({
      serial_number: r.serial_number,
      gas_type: r.gas_type,
      capacity: r.capacity,
      date_given: r.date_given,
      charged_from: r.charge_from,
      charged_through: now,
      days_held: r.days_unbilled,
      days_charged: daysCharged,
      amount: daysCharged * rate
    });
  }

  const charge = new RentalCharge({
    user_id: uid,
    customer_id: customerId,
    generated_date: now,
    free_days: freeDays,
    rate_per_day: rate,
    line_items: lineItems,
    total_amount: lineItems.reduce((sum, li) => sum + li.amount, 0)
  });
  await charge.save();

  await Cylinder.updateMany(
    { user_id: uid, rotational_number: { $in: selected } },
    { rental_charged_through: now }
  );

  return getRentalCharge(uid, charge._id);
}

// Fetch a saved charge with customer details attached (for the printable summary).
async function getRentalCharge(uid, chargeId) {
  const charge = await RentalCharge.findOne({ _id: chargeId, user_id: uid }).populate('customer_id');
  if (!charge) throw new HttpError(404, 'Rental charge not found');

  const data = charge.toObject();
  const cust = charge.customer_id || {};
  data.customer = {
    customer_id: cust._id,
    company_name: cust.company_name || '',
    contact_person: cust.contact_person || '',
    phone_primary: cust.phone_primary || '',
    address: cust.address || '',
    gst_number: cust.gst_number || ''
  };
  return data;
}

module.exports = { getCustomerAging, generateRentalCharge, getRentalCharge };
