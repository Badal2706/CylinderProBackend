// Discount arithmetic across every surface that reports money.
//
// The bug: a discount was subtracted from `amount_received` for display ("Net Amount"), and the
// balance aggregation subtracted it a second time via `- totalDiscount`, which cancelled the
// discount out entirely and left the customer still owing it.
//
// The canonical rule this suite pins down:
//   * `amount_received` is the CASH figure alone. "Net Amount" in any UI == amount_received.
//   * A payment SETTLES amount_received + discount, because a discount reduces what is owed
//     exactly like cash does.
//
// Both wrong answers are asserted against explicitly, because the obvious "fix" (adding the
// discount into the same sum that `- totalDiscount` already covers) over-credits by the discount
// and is just as wrong as the original. A test that only checked `!== old` would pass on it.
process.env.NUMBERING_SALT = process.env.NUMBERING_SALT || 'test-salt-do-not-use-in-production';

const mongoose = require('mongoose');

const User = require('../models/User');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const customerService = require('../services/customer.service');
const reportService = require('../services/report.service');
const paymentService = require('../services/payment.service');
const acct = require('../services/accountNumbering.service');
const N = require('../services/numbering.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_discount_${Date.now()}`;
const CH = 'AT_PLANT_CHANDISAR';

// The user's real example, which is the whole point of this file.
const BILLED = 16695;
const RECEIVED = 16600;
const DISCOUNT = 95;

let user, customer;

beforeAll(async () => {
  await mongoose.connect(TEST_DB);

  user = await User.create({ name: 'Disc', email: 'disc@math.test', password: 'Test1234!' });
  user.account_code = N.deriveAccountCode(user._id);
  await user.save();
  acct._clearCache();

  customer = await Customer.create({
    user_id: user._id, company_name: 'Discount Test Co', customer_type: 'REGULAR',
    contact_person: 'A', phone_primary: '9000000000', is_active: true, holding_limit: 100
  });

  const GasType = require('../models/GasType');
  const CylinderSize = require('../models/CylinderSize');
  const gas = await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
  const size = await CylinderSize.create({ size_label: '7 m3', is_active: true });

  await Bill.create({
    user_id: user._id, customer_id: customer._id, bill_number: '1A001',
    bill_date: new Date('2026-06-15T10:00:00+05:30'), challan_no: 'C-1', location: CH,
    transaction_type: 'GIVEN', transaction_category: 'CUSTOMER',
    // Set explicitly because bill.service computes this on save, not a model hook.
    total_bill_amount: BILLED,
    line_items: [{
      direction: 'GIVEN', gas_type_id: gas._id, cylinder_size_id: size._id,
      gas_type_name: 'Oxygen', size_label: '7 m3',
      serial_number: 'D-1', quantity: 1, rate: BILLED, amount: BILLED
    }]
  });

  await Payment.create({
    user_id: user._id, customer_id: customer._id, receipt_number: 'RCP-0001',
    date: new Date('2026-06-20T10:00:00+05:30'),
    amount_received: RECEIVED, discount: DISCOUNT, payment_mode: 'CASH'
  });
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

describe('outstanding balance treats a discount as settled, exactly once', () => {
  test('getCustomerStats: cash + discount clears the bill', async () => {
    const s = await customerService.getCustomerStats(customer._id);

    expect(s.total_billed).toBe(BILLED);
    expect(s.total_received).toBe(RECEIVED);      // the CASH figure, never cash - discount
    expect(s.total_discount).toBe(DISCOUNT);
    expect(s.current_bill_amount).toBe(0);

    // The two ways of getting this wrong:
    expect(s.current_bill_amount).not.toBe(DISCOUNT);   // old bug: discount cancelled out
    expect(s.current_bill_amount).not.toBe(-DISCOUNT);  // naive fix: discount credited twice
  });

  test('getCustomerDetail agrees with getCustomerStats', async () => {
    const d = await customerService.getCustomerDetail(user._id, customer._id);
    expect(d.total_received).toBe(RECEIVED);
    expect(d.total_discount).toBe(DISCOUNT);
    expect(d.current_bill_amount).toBe(0);
  });

  test('the listCustomers aggregation agrees with both', async () => {
    const res = await customerService.listCustomers(user._id, {});
    const rows = res.data || res;
    const row = rows.find(r => String(r._id) === String(customer._id));
    expect(row).toBeTruthy();
    expect(row.total_received).toBe(RECEIVED);
    expect(row.total_discount).toBe(DISCOUNT);
    expect(row.current_bill_amount).toBe(0);
  });
});

describe('the statement ledger and the customer balance tell the same story', () => {
  test('a payment is credited at cash + discount', async () => {
    const st = await reportService.getCustomerStatement(user._id, customer._id);
    const pay = st.find(r => r.type === 'PAYMENT');
    expect(pay).toBeTruthy();
    expect(pay.credit).toBe(RECEIVED + DISCOUNT);
    expect(pay.credit).not.toBe(RECEIVED);   // the old value, which under-credited the discount
  });

  test('statement closing balance equals current_bill_amount', async () => {
    const st = await reportService.getCustomerStatement(user._id, customer._id);
    const closing = st.reduce((b, r) => b + (r.debit || 0) - (r.credit || 0), 0);
    const { current_bill_amount } = await customerService.getCustomerStats(customer._id);

    // This is the check that would have caught the original bug from either direction: the two
    // screens disagreed by exactly the discount total.
    expect(closing).toBe(current_bill_amount);
    expect(closing).toBe(0);
  });
});

describe('a discount never changes what was stored', () => {
  test('amount_received and discount stay separate, exactly as entered', async () => {
    const p = await Payment.findOne({ customer_id: customer._id }).lean();
    expect(p.amount_received).toBe(RECEIVED);
    expect(p.discount).toBe(DISCOUNT);
  });
});

describe('payment list ordering', () => {
  test('same-date payments come back newest-entered first', async () => {
    const sameDate = new Date('2026-07-01T10:00:00+05:30');
    // Written in ascending createdAt order; the list must return them reversed.
    for (const rn of ['RCP-0002', 'RCP-0003', 'RCP-0004']) {
      await Payment.create({
        user_id: user._id, customer_id: customer._id, receipt_number: rn, date: sameDate,
        amount_received: 100, discount: 0, payment_mode: 'CASH'
      });
      await new Promise(r => setTimeout(r, 10));   // guarantee distinct createdAt
    }

    const res = await paymentService.listPayments(user._id, null, { page: 1, limit: 50 });
    const order = res.data.map(p => p.receipt_number);
    expect(order.slice(0, 3)).toEqual(['RCP-0004', 'RCP-0003', 'RCP-0002']);
  });

  test('search is applied on the server, across the whole ledger', async () => {
    const byReceipt = await paymentService.listPayments(user._id, null, { page: 1, limit: 50, search: 'RCP-0003' });
    expect(byReceipt.data.map(p => p.receipt_number)).toEqual(['RCP-0003']);

    const byCustomer = await paymentService.listPayments(user._id, null, { page: 1, limit: 50, search: 'Discount Test' });
    expect(byCustomer.pagination.total).toBe(4);

    // A term with regex metacharacters must be matched literally, not compiled as a pattern.
    const literal = await paymentService.listPayments(user._id, null, { page: 1, limit: 50, search: 'Discount.Test' });
    expect(literal.pagination.total).toBe(0);
  });
});
