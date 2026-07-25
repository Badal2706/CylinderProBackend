const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const Cylinder = require('../models/Cylinder');
const { computeHoldings } = require('./holdings.service');

const toOid = (id) => new mongoose.Types.ObjectId(id);

async function getStats(uid) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const [billAgg, paymentAgg, customers, today_transactions] = await Promise.all([
    Bill.aggregate([
      { $match: { user_id: toOid(uid) } },
      { $unwind: '$line_items' },
      { $group: {
        _id: null,
        totalBilled: { $sum: '$line_items.amount' },
        totalGiven: { $sum: { $cond: [{ $eq: ['$line_items.direction', 'GIVEN'] }, '$line_items.quantity', 0] } },
        totalReceived: { $sum: { $cond: [{ $eq: ['$line_items.direction', 'RECEIVED'] }, '$line_items.quantity', 0] } }
      } }
    ]),
    Payment.aggregate([
      { $match: { user_id: toOid(uid) } },
      { $group: { _id: null, totalPaid: { $sum: { $ifNull: ['$amount_received', 0] } } } }
    ]),
    Customer.countDocuments({ user_id: uid, customer_type: 'REGULAR', is_active: true }),
    Bill.countDocuments({
      user_id: uid,
      is_draft: { $ne: true },
      bill_date: { $gte: startOfDay, $lte: endOfDay }
    })
  ]);

  const b = billAgg[0] || { totalBilled: 0, totalGiven: 0, totalReceived: 0 };
  const p = paymentAgg[0] || { totalPaid: 0 };

  const depositAgg = await Customer.aggregate([
    { $match: { user_id: toOid(uid), customer_type: 'REGULAR', is_active: true } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$security_deposit', 0] } } } }
  ]);

  return {
    total_outstanding: (b.totalBilled - p.totalPaid) || 0,
    total_customers: customers,
    total_cylinders_out: b.totalGiven - b.totalReceived,
    today_transactions,
    total_security_deposit: (depositAgg[0] || { total: 0 }).total
  };
}

async function getCylinderStock(uid) {
  const [totalCylinders, cylindersAtPlant, cylindersInRotation, perLocation] = await Promise.all([
    Cylinder.countDocuments({ user_id: uid }),
    Cylinder.countDocuments({ user_id: uid, stock_state: 'IN_STOCK' }),
    Cylinder.countDocuments({ user_id: uid, stock_state: 'AT_CUSTOMER' }),
    Cylinder.aggregate([
      { $match: { user_id: toOid(uid), stock_state: 'IN_STOCK' } },
      { $group: { _id: '$location', count: { $sum: 1 } } }
    ])
  ]);

  const byLocation = {};
  perLocation.forEach(r => { byLocation[r._id] = r.count; });

  return { totalCylinders, cylindersInRotation, cylindersAtPlant, byLocation };
}

async function getOverLimitCustomers(uid) {
  const customers = await Customer.find(
    { user_id: uid, customer_type: 'REGULAR', is_active: true, is_filling_vendor: { $ne: true } },
    { company_name: 1, phone_primary: 1, holding_limit: 1 }
  ).lean();

  if (!customers.length) return [];

  const customerIds = customers.map(c => c._id);
  const allBills = await Bill.find(
    { customer_id: { $in: customerIds }, user_id: uid },
    { customer_id: 1,
      'line_items.direction': 1, 'line_items.quantity': 1, 'line_items.amount': 1,
      'line_items.returned_via': 1, 'line_items.returned_on_behalf_of': 1 }
  ).lean();

  const billMap = {};
  for (const b of allBills) {
    const cid = String(b.customer_id);
    if (!billMap[cid]) billMap[cid] = [];
    billMap[cid].push(b);
  }

  const overLimitCustomers = [];
  for (const customer of customers) {
    const cid = String(customer._id);
    const { held } = computeHoldings(billMap[cid] || []);
    if (held > (customer.holding_limit || 0)) {
      overLimitCustomers.push({
        customer_id: customer._id,
        company_name: customer.company_name,
        phone_primary: customer.phone_primary,
        holding_limit: customer.holding_limit,
        cylinders_held: held
      });
    }
  }

  overLimitCustomers.sort((a, b) =>
    (b.cylinders_held - b.holding_limit) - (a.cylinders_held - a.holding_limit)
  );

  return overLimitCustomers;
}

module.exports = { getStats, getCylinderStock, getOverLimitCustomers };
