// A "day" in this software is a CALENDAR DAY IN INDIA. Not a UTC day, and not a day in whatever
// timezone the server is set to.
//
// THE REPORTED BUG. Four transactions entered just after midnight IST vanished from the
// Transaction History when you filtered for that date — "No transactions found" — while the
// unfiltered list showed them under the same date heading. They were stored at 19:20–19:40Z on the
// PREVIOUS UTC day, and the filter's window began at UTC midnight, five and a half hours late.
//
// THE SECOND BUG, which no test on an Indian dev machine could have caught. Where a window was
// built with `setHours`, it used the SERVER'S timezone. Correct on a machine set to IST; shifted by
// 5.5 hours on one set to UTC. Same code, different answer depending on where it runs — so the
// tests below assert the helper's output as absolute UTC instants, which pins the behaviour on
// every machine rather than agreeing with whatever this one happens to be set to.

const mongoose = require('mongoose');

const { istDayRange, istDayString, istRange } = require('../utils/istDay');
const User = require('../models/User');
const Customer = require('../models/Customer');
const Cylinder = require('../models/Cylinder');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const LocationProfile = require('../models/LocationProfile');
const billService = require('../services/bill.service');
const reportService = require('../services/report.service');
const N = require('../services/numbering.service');
const acct = require('../services/accountNumbering.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_istday_${Date.now()}`;

const PLANT = 'AT_WORKS';
const GAS = 'Oxygen';
const CAP = '7 m3';

let user, gas, size, customer;

// ─────────────────────────────────────────────────────────────────────────────
// The helper, in isolation. No database, no server clock.
describe('the IST day window itself', () => {
  test('a day starts at 18:30Z the PREVIOUS day and ends at 18:29:59.999Z', () => {
    const { start, end } = istDayRange('2026-08-30');
    expect(start.toISOString()).toBe('2026-08-29T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-08-30T18:29:59.999Z');
  });

  test('the window is exactly 24 hours', () => {
    const { start, end } = istDayRange('2026-08-30');
    expect(end.getTime() - start.getTime()).toBe(86400000 - 1);
  });

  test('00:50 IST on the 30th belongs to the 30th, not the 29th', () => {
    // Stored as 2026-08-29T19:20:00Z — the instant that used to disappear.
    const t = new Date('2026-08-29T19:20:00.000Z');
    expect(istDayString(t)).toBe('2026-08-30');
    const { start, end } = istDayRange('2026-08-30');
    expect(t >= start && t <= end).toBe(true);
    const prev = istDayRange('2026-08-29');
    expect(t >= prev.start && t <= prev.end).toBe(false);
  });

  test('23:50 IST on the 29th belongs to the 29th', () => {
    const t = new Date('2026-08-29T18:20:00.000Z');
    expect(istDayString(t)).toBe('2026-08-29');
  });

  test('consecutive days abut exactly, with no gap and no overlap', () => {
    const a = istDayRange('2026-08-29');
    const b = istDayRange('2026-08-30');
    expect(b.start.getTime() - a.end.getTime()).toBe(1);
  });

  test('a month boundary is handled', () => {
    const { start, end } = istDayRange('2026-09-01');
    expect(start.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-09-01T18:29:59.999Z');
  });

  test('a multi-day range covers whole days at both ends', () => {
    const { start, end } = istRange('2026-08-01', '2026-08-31');
    expect(start.toISOString()).toBe('2026-07-31T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-08-31T18:29:59.999Z');
  });

  test('a Date is accepted as well as a string, and lands on the same day', () => {
    const viaDate = istDayRange(new Date('2026-08-29T19:20:00.000Z'));
    const viaString = istDayRange('2026-08-30');
    expect(viaDate.start.toISOString()).toBe(viaString.start.toISOString());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The bug as the user met it.
describe('a bill entered just after midnight IST', () => {
  beforeAll(async () => {
    await mongoose.connect(TEST_DB);
    user = await User.create({ name: 'T', email: 'ist@day.test', password: 'Test1234!' });
    user.account_code = N.deriveAccountCode(user._id);
    await user.save();
    acct._clearCache();

    await LocationProfile.create([{ user_id: user._id, location: PLANT, label: 'Works', is_filling_location: true }]);
    gas = await GasType.create({ user_id: user._id, gas_type_name: GAS, is_active: true });
    size = await CylinderSize.create({ user_id: user._id, size_label: CAP, is_active: true });
    customer = await Customer.create({
      user_id: user._id, company_name: 'Night Shift Ltd', customer_type: 'REGULAR',
      phone_primary: '9000000000', is_active: true, holding_limit: 99
    });
    for (const r of ['N-1', 'N-2']) {
      await Cylinder.create({
        user_id: user._id, rotational_number: r, gas_type: GAS, capacity: CAP,
        location: PLANT, stock_state: 'IN_STOCK'
      });
    }

    const item = (serial) => ({
      gas_type_id: String(gas._id), cylinder_size_id: String(size._id),
      quantity: 1, rate: 100, serial_numbers: [serial]
    });

    // 00:50 IST on 30 Aug — the case that vanished.
    await billService.createBill(user._id, {
      customer_id: String(customer._id), customer_type: 'REGULAR', challan_no: 'NIGHT-1',
      location: PLANT, transaction_type: 'GIVEN', given_items: [item('N-1')],
      bill_date: new Date('2026-08-29T19:20:00.000Z')
    });
    // 23:50 IST on 29 Aug — the neighbour that must NOT move with it.
    await billService.createBill(user._id, {
      customer_id: String(customer._id), customer_type: 'REGULAR', challan_no: 'EVENING-1',
      location: PLANT, transaction_type: 'GIVEN', given_items: [item('N-2')],
      bill_date: new Date('2026-08-29T18:20:00.000Z')
    });
  });

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.connection.close();
  });

  test('shows up in the Transaction History for ITS OWN day', async () => {
    const r = await billService.listBills(user._id, { date: '2026-08-30' });
    expect(r.data.map(b => b.challan_no)).toEqual(['NIGHT-1']);
  });

  test('does not also show up on the previous day', async () => {
    const r = await billService.listBills(user._id, { date: '2026-08-29' });
    expect(r.data.map(b => b.challan_no)).toEqual(['EVENING-1']);
  });

  test('every bill lands on exactly one day — none lost, none double-counted', async () => {
    const days = ['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31'];
    let total = 0;
    for (const d of days) total += (await billService.listBills(user._id, { date: d })).pagination.total;
    expect(total).toBe(2);
  });

  test('the DSR agrees with the Transaction History', async () => {
    const d30 = await reportService.getDSR(user._id, { date: '2026-08-30', location: PLANT });
    const d29 = await reportService.getDSR(user._id, { date: '2026-08-29', location: PLANT });
    expect(d30.rows.map(r => r.challan_no)).toEqual(['NIGHT-1']);
    expect(d29.rows.map(r => r.challan_no)).toEqual(['EVENING-1']);
  });

  test('the Stock Summary puts the movement on the same day too', async () => {
    const rep = await reportService.getStockSummary(user._id, { date: '2026-08-30', location: PLANT });
    const row = rep.rows.find(r => r.gas_type === GAS && r.capacity === CAP);
    expect(row.filled.issue).toBe(1);   // N-1 went out on the 30th, not the 29th
  });
});
