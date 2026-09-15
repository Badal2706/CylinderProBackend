// The customer list works out balances and holdings only for the page being returned.
//
// It used to read every customer's bills on every page request, so the three 200-row pages the
// New Transaction picker loads read the whole bill collection three times — on the free Atlas
// tier that repeated reading used up the weekly data-transfer allowance (15 Sep 2026).
//
// What must NOT change: every row, every figure, every total, in every view. This suite builds
// customers whose figures differ (billed, paid, discounted, holding over and under their limit)
// and asserts that stitching the pages together gives exactly what one big page gives.
process.env.NUMBERING_SALT = process.env.NUMBERING_SALT || 'test-salt-do-not-use-in-production';

const mongoose = require('mongoose');

const User = require('../models/User');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const customerService = require('../services/customer.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_custpaging_${Date.now()}`;

let user;
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  user = await User.create({ name: 'Paging', email: 'paging@list.test', password: 'Test1234!' });

  const GasType = require('../models/GasType');
  const CylinderSize = require('../models/CylinderSize');
  const gas = await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
  const size = await CylinderSize.create({ size_label: '7 m3', is_active: true });

  let billNo = 1;
  for (let i = 0; i < NAMES.length; i++) {
    const c = await Customer.create({
      user_id: user._id, company_name: `${NAMES[i]} Co`, customer_type: 'REGULAR',
      contact_person: 'A', phone_primary: `90000000${10 + i}`, is_active: i !== 3,
      holding_limit: i % 2 ? 1 : 10, is_filling_vendor: i === 5
    });
    // i cylinders given, in one bill per cylinder; customer 6 also pays everything off.
    let billed = 0;
    for (let k = 0; k < i; k++) {
      const amount = 100 * (i + 1);
      billed += amount;
      await Bill.create({
        user_id: user._id, customer_id: c._id, bill_number: `1A${String(billNo++).padStart(3, '0')}`,
        bill_date: new Date(`2026-06-${String(10 + k).padStart(2, '0')}T10:00:00+05:30`),
        challan_no: `C-${billNo}`, location: 'AT_PLANT_CHANDISAR',
        transaction_type: 'GIVEN', transaction_category: 'CUSTOMER', total_bill_amount: amount,
        line_items: [{
          direction: 'GIVEN', gas_type_id: gas._id, cylinder_size_id: size._id,
          gas_type_name: 'Oxygen', size_label: '7 m3',
          serial_number: `${NAMES[i]}-${k}`, quantity: 1, rate: amount, amount
        }]
      });
    }
    if (i === 6) {
      await Payment.create({ user_id: user._id, customer_id: c._id, receipt_number: 'RCP-0001',
        date: new Date('2026-06-30T10:00:00+05:30'), amount_received: billed - 50, discount: 50, payment_mode: 'CASH' });
    }
    if (i === 2) {
      await Payment.create({ user_id: user._id, customer_id: c._id, receipt_number: 'RCP-0002',
        date: new Date('2026-06-30T10:00:00+05:30'), amount_received: 120, discount: 0, payment_mode: 'CASH' });
    }
  }
  // A customer with no bills at all — the page-first path must still return it, with zeros.
  await Customer.create({ user_id: user._id, company_name: 'Hotel Co', customer_type: 'REGULAR',
    contact_person: 'A', phone_primary: '9000000099', is_active: true, holding_limit: 5 });
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

const uid = () => String(user._id);
const strip = (res) => JSON.parse(JSON.stringify(res.data));

async function stitched(opts, limit) {
  const first = await customerService.listCustomers(uid(), { ...opts, page: 1, limit });
  const rows = strip(first);
  for (let p = 2; p <= first.pagination.totalPages; p++) {
    rows.push(...strip(await customerService.listCustomers(uid(), { ...opts, page: p, limit })));
  }
  return { rows, total: first.pagination.total, totalPages: first.pagination.totalPages };
}

describe.each([
  ['every customer', {}],
  ['ACTIVE', { status: 'ACTIVE' }],
  ['FILLING_VENDOR', { status: 'FILLING_VENDOR' }],
  ['OVER_LIMIT', { status: 'OVER_LIMIT' }],
  ['ZERO_BALANCE', { status: 'ZERO_BALANCE' }],
  ['search', { search: 'o' }]
])('customer list, %s', (_label, opts) => {
  test('pages of 3 stitch together into exactly the one-page answer', async () => {
    const whole = await customerService.listCustomers(uid(), { ...opts, page: 1, limit: 200 });
    const paged = await stitched(opts, 3);
    expect(paged.rows).toEqual(strip(whole));
    expect(paged.total).toBe(whole.pagination.total);
    expect(paged.totalPages).toBe(Math.ceil(whole.pagination.total / 3));
  });

  test('pages of 1 as well, and a page past the end is empty with the same total', async () => {
    const whole = await customerService.listCustomers(uid(), { ...opts, page: 1, limit: 200 });
    const paged = await stitched(opts, 1);
    expect(paged.rows).toEqual(strip(whole));
    const beyond = await customerService.listCustomers(uid(), { ...opts, page: 99, limit: 3 });
    expect(beyond.data).toEqual([]);
    expect(beyond.pagination.total).toBe(whole.pagination.total);
  });
});

test('the figures themselves are right, not just consistent', async () => {
  const { rows } = await stitched({}, 2);
  const by = Object.fromEntries(rows.map(r => [r.company_name, r]));
  expect(by['Charlie Co']).toMatchObject({ cylinders_held: 2, total_billed: 600, total_received: 120, current_bill_amount: 480 });
  expect(by['Golf Co']).toMatchObject({ cylinders_held: 6, total_billed: 4200, total_discount: 50, current_bill_amount: 0 });
  expect(by['Hotel Co']).toMatchObject({ cylinders_held: 0, total_billed: 0, current_bill_amount: 0 });
  expect(by['Bravo Co'].status).toBe('ACTIVE');          // holds 1, limit 1
  expect(by['Delta Co'].status).toBe('OVER LIMIT');      // holds 3, limit 1 (inactive, but over limit wins)
  expect(by['Foxtrot Co'].status).toBe('ACTIVE');        // vendor holding 5 on a limit of 1: never over limit
});
