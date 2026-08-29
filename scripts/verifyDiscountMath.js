// Proves the corrected discount arithmetic on REAL production-copy data, then puts everything
// back exactly as it was.
//
// Goes through the real createPayment() service (so receipt allocation, hooks and numbering all
// run for real), checks every surface that reports money, then deletes the payment and rewinds
// the receipt counter so the database is byte-identical to how it started.
//
// Read-then-restore, not read-only: DRY=1 reports the before-state and stops without writing.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const DRY = process.env.DRY === '1';
const BILLED_EXAMPLE = 16695, RECEIVED = 16600, DISCOUNT = 95;

const results = [];
const check = (label, ok, detail) => {
  results.push(!!ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? '   -> ' + detail : ''}`);
};
const r2 = (n) => Math.round((n || 0) * 100) / 100;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`db: ${mongoose.connection.name}${DRY ? '   (DRY RUN — no writes)' : ''}\n`);

  const User = require('../models/User');
  const Customer = require('../models/Customer');
  const Payment = require('../models/Payment');
  const Counter = require('../models/Counter');
  const customerService = require('../services/customer.service');
  const reportService = require('../services/report.service');
  const paymentService = require('../services/payment.service');

  const user = await User.findOne().lean();
  if (!user) throw new Error('no account in this database');
  console.log(`account: ${user.email}  (${user.account_code || 'no account_code'})`);

  // ── 1. Whole-book invariant: statement closing balance must equal the customer detail balance,
  //       for EVERY customer. This is the cross-check the two screens previously failed.
  const customers = await Customer.find({ user_id: user._id, customer_type: 'REGULAR' })
    .select('_id company_name').lean();
  console.log(`\nchecking ${customers.length} customers for statement/detail agreement…`);

  let disagreements = [], withDiscount = 0;
  for (const c of customers) {
    const [stats, statement, pays] = await Promise.all([
      customerService.getCustomerStats(c._id),
      reportService.getCustomerStatement(user._id, c._id),
      Payment.find({ customer_id: c._id }).select('discount').lean()
    ]);
    if (pays.some(p => (p.discount || 0) > 0)) withDiscount++;
    const closing = statement.reduce((b, row) => b + (row.debit || 0) - (row.credit || 0), 0);
    if (Math.abs(r2(closing) - r2(stats.current_bill_amount)) > 0.01) {
      disagreements.push(`${c.company_name}: statement ${r2(closing)} vs detail ${r2(stats.current_bill_amount)}`);
    }
  }
  check(`statement and customer-detail agree for all ${customers.length} customers`,
    disagreements.length === 0, disagreements.slice(0, 5).join(' | ') || 'all match');
  console.log(`        (${withDiscount} of ${customers.length} customers have any discounted payment)`);

  // ── 2. The live example, recorded for real then removed ──
  const target = customers[0];
  const before = await customerService.getCustomerStats(target._id);
  const counterBefore = await Counter.findOne({ user_id: user._id, key: 'receipt_number_series' }).lean();
  console.log(`\ntest customer: ${target.company_name}`);
  console.log(`  before -> billed ${r2(before.total_billed)}  received ${r2(before.total_received)}  ` +
              `discount ${r2(before.total_discount)}  DUE ${r2(before.current_bill_amount)}`);

  if (DRY) {
    console.log('\nDRY=1 — stopping before any write.');
    await mongoose.disconnect();
    return process.exit(0);
  }

  const created = await paymentService.createPayment(user._id, {
    customer_id: String(target._id),
    date: new Date(),
    amount_received: RECEIVED,
    discount: DISCOUNT,
    payment_mode: 'CASH',
    remarks: 'TEMPORARY — discount math verification, deleted immediately'
  });
  console.log(`  recorded receipt ${created.receipt_number} (received ${RECEIVED}, discount ${DISCOUNT})`);

  const after = await customerService.getCustomerStats(target._id);
  console.log(`  after  -> billed ${r2(after.total_billed)}  received ${r2(after.total_received)}  ` +
              `discount ${r2(after.total_discount)}  DUE ${r2(after.current_bill_amount)}`);

  const drop = r2(before.current_bill_amount - after.current_bill_amount);
  check(`outstanding fell by ${RECEIVED} + ${DISCOUNT} = ${BILLED_EXAMPLE}, not ${RECEIVED}`,
    drop === BILLED_EXAMPLE, `fell by ${drop}`);
  check('"Total Received" shows the CASH figure alone',
    r2(after.total_received - before.total_received) === RECEIVED,
    `rose by ${r2(after.total_received - before.total_received)}`);
  check('discount is reported separately, not folded into cash',
    r2(after.total_discount - before.total_discount) === DISCOUNT,
    `rose by ${r2(after.total_discount - before.total_discount)}`);

  // The stored record is untouched by any display rule.
  const stored = await Payment.findById(created.receipt_id).lean();
  check('stored amount_received and discount are exactly as entered',
    stored.amount_received === RECEIVED && stored.discount === DISCOUNT,
    `received=${stored.amount_received} discount=${stored.discount}`);

  // Statement credit and the list aggregation must both agree with the detail view.
  const st = await reportService.getCustomerStatement(user._id, target._id);
  const thisPay = st.find(row => row.receipt_number === created.receipt_number);
  check('statement credits this payment at cash + discount',
    thisPay && r2(thisPay.credit) === BILLED_EXAMPLE, thisPay ? `credit ${r2(thisPay.credit)}` : 'row missing');

  const closingAfter = st.reduce((b, row) => b + (row.debit || 0) - (row.credit || 0), 0);
  check('statement closing still equals the detail balance',
    Math.abs(r2(closingAfter) - r2(after.current_bill_amount)) <= 0.01,
    `statement ${r2(closingAfter)} vs detail ${r2(after.current_bill_amount)}`);

  // Search by name: the list paginates at 50, so the test customer is rarely on page 1.
  const listed = await customerService.listCustomers(user._id, { search: target.company_name, limit: 200 });
  const row = (listed.data || listed).find(x => String(x._id) === String(target._id));
  check('the customer-list aggregation matches the detail view',
    row && Math.abs(r2(row.current_bill_amount) - r2(after.current_bill_amount)) <= 0.01,
    row ? `list ${r2(row.current_bill_amount)} vs detail ${r2(after.current_bill_amount)}` : 'not in list');

  // ── 3. Newest-first ordering by entry time ──
  const recent = await paymentService.listPayments(user._id, null, { page: 1, limit: 5 });
  const stamps = recent.data.map(p => new Date(p.createdAt).getTime());
  check('payment list is ordered newest-entered first',
    stamps.every((t, i) => i === 0 || stamps[i - 1] >= t),
    recent.data.map(p => p.receipt_number).join(', '));
  check('the payment just recorded is at the top',
    recent.data[0] && recent.data[0].receipt_number === created.receipt_number,
    recent.data[0] ? recent.data[0].receipt_number : 'empty');

  // ── 4. Put everything back ──
  await Payment.deleteOne({ _id: created.receipt_id });
  if (counterBefore) {
    await Counter.updateOne({ _id: counterBefore._id }, { $set: { seq: counterBefore.seq } });
  }
  const restored = await customerService.getCustomerStats(target._id);
  const counterAfter = await Counter.findOne({ user_id: user._id, key: 'receipt_number_series' }).lean();

  check('test payment removed — balance back to its original value',
    r2(restored.current_bill_amount) === r2(before.current_bill_amount),
    `${r2(restored.current_bill_amount)} vs ${r2(before.current_bill_amount)}`);
  check('receipt counter rewound',
    !counterBefore || (counterAfter && counterAfter.seq === counterBefore.seq),
    counterBefore ? `${counterBefore.seq} -> ${counterAfter.seq}` : 'no counter existed');
  check('no verification payment left behind',
    (await Payment.countDocuments({ remarks: /discount math verification/ })) === 0);

  console.log('\n' + (results.every(Boolean)
    ? `ALL ${results.length} CHECKS PASSED`
    : `${results.filter(x => !x).length} of ${results.length} FAILED`));
  await mongoose.disconnect();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
