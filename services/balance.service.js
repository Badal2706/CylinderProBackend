const mongoose = require('mongoose');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');

// ─── What a customer owes — one calculator, every screen ───
//
// THE RULE, in one place: `amount_received` is the CASH figure alone, and a discount settles a
// balance exactly as cash does. So
//
//     amount due = total billed − cash received − discount
//
// Three screens show this number: the Customers list, the balance line on the payment form (which
// reads the customer list's row), and the All Customer Ledger report. They used to work it out
// separately, and the ledger's copy left the discount out — so the moment a discount was recorded,
// the report would have shown a customer still owing money the business had already written off.
// The figures agreed only because no discount had been entered yet (₹0 across all payments,
// 20 Sep 2026); this removes the second formula before that changes.
//
// Unlike cylinders held, this IS a plain sum: it needs no replay of bill history, so it is done in
// the database rather than by reading every bill (see deploy/phase2-findings.md).
const toOid = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)));

// Returns a map: customer id (string) -> { total_billed, total_received, total_discount,
// current_bill_amount }. Customers with no bills and no payments are absent; callers treat a
// missing entry as all-zeroes (see ZERO below).
async function balancesFor(userId, customerIds) {
  const ids = (customerIds || []).map(toOid);
  if (!ids.length) return {};

  const [billAgg, payAgg] = await Promise.all([
    Bill.aggregate([
      { $match: { user_id: toOid(userId), customer_id: { $in: ids } } },
      { $group: { _id: '$customer_id', billed: { $sum: { $ifNull: ['$total_bill_amount', 0] } } } }
    ]),
    Payment.aggregate([
      { $match: { customer_id: { $in: ids } } },
      { $group: {
        _id: '$customer_id',
        received: { $sum: { $ifNull: ['$amount_received', 0] } },   // cash only
        discount: { $sum: { $ifNull: ['$discount', 0] } }
      } }
    ])
  ]);

  const out = {};
  const row = (cid) => (out[cid] = out[cid] || { total_billed: 0, total_received: 0, total_discount: 0, current_bill_amount: 0 });
  for (const b of billAgg) row(String(b._id)).total_billed = b.billed || 0;
  for (const p of payAgg) {
    const r = row(String(p._id));
    r.total_received = p.received || 0;
    r.total_discount = p.discount || 0;
  }
  for (const r of Object.values(out)) r.current_bill_amount = r.total_billed - r.total_received - r.total_discount;
  return out;
}

const ZERO = Object.freeze({ total_billed: 0, total_received: 0, total_discount: 0, current_bill_amount: 0 });

// One customer, same rule.
async function balanceFor(userId, customerId) {
  const map = await balancesFor(userId, [customerId]);
  return map[String(customerId)] || { ...ZERO };
}

module.exports = { balancesFor, balanceFor, ZERO };
