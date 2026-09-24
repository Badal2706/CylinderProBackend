// Q2: a cylinder taken back at a different site than it was issued from.
//
// Giving already refuses a cylinder in stock elsewhere. Receiving did not — it asked only whether
// the cylinder was out with a customer, never where it went out FROM. So a Palanpur cylinder could
// be received on a Chandisar bill and its location was silently rewritten. It happened 22 times in
// real data before this rule existed.
//
// The decision: allow it, warn first, and record the move in the cylinder's history — but write NO
// transfer document. scripts/expCrossSiteReturn.js proved a transfer double-counts the arrival the
// RECEIVED line already records, driving the site's opening balance negative. These tests pin both
// halves down: the warning fires, and the Stock Summary is untouched.

const mongoose = require('mongoose');

const User = require('../models/User');
const Customer = require('../models/Customer');
const Cylinder = require('../models/Cylinder');
const Bill = require('../models/Bill');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const LocationProfile = require('../models/LocationProfile');
const CylinderHistory = require('../models/CylinderHistory');
const billService = require('../services/bill.service');
const reportService = require('../services/report.service');
const N = require('../services/numbering.service');
const acct = require('../services/accountNumbering.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_crosssite_${Date.now()}`;
const CH = 'AT_PLANT_CHANDISAR';
const PA = 'AT_PALANPUR_OFFICE';

let user, customer, gas, size;

// createBill takes given_items / received_items, each a line with serial_numbers[] matching quantity.
const item = (serial) => ({
  gas_type_id: String(gas._id), cylinder_size_id: String(size._id),
  quantity: 1, rate: 0, serial_numbers: [serial]
});

const billBody = (over) => ({
  customer_id: String(customer._id),
  customer_type: 'REGULAR',
  challan_no: 'C-' + Math.random().toString(36).slice(2, 7),
  bill_date: new Date('2026-06-12T10:00:00+05:30'),
  ...over
});

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  user = await User.create({ name: 'X', email: 'cross@site.test', password: 'Test1234!' });
  user.account_code = N.deriveAccountCode(user._id);
  await user.save();
  acct._clearCache();

  await LocationProfile.create([
    { user_id: user._id, location: CH, label: 'Chandisar Plant', is_filling_location: true },
    { user_id: user._id, location: PA, label: 'Palanpur Office' }
  ]);
  gas = await GasType.create({ user_id: user._id, gas_type_name: 'Oxygen', is_active: true });
  size = await CylinderSize.create({ user_id: user._id, size_label: '7 m3', is_active: true });
  customer = await Customer.create({
    user_id: user._id, company_name: 'Cross Site Co', customer_type: 'REGULAR',
    phone_primary: '9000000000', is_active: true, holding_limit: 99
  });
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

// Put a cylinder out with the customer from `from`, by actually saving a GIVEN bill.
async function issueFrom(serial, from) {
  await Cylinder.create({
    user_id: user._id, rotational_number: serial, gas_type: 'Oxygen', capacity: '7 m3',
    location: from, stock_state: 'IN_STOCK'
  });
  const res = await billService.createBill(user._id, billBody({
    location: from, transaction_type: 'GIVEN', given_items: [item(serial)],
    bill_date: new Date('2026-06-10T10:00:00+05:30')
  }));
  expect(res.bill_number).toBeTruthy();
  const c = await Cylinder.findOne({ user_id: user._id, rotational_number: serial }).lean();
  expect(c.stock_state).toBe('AT_CUSTOMER');
  expect(c.location).toBe(from);
  return res;
}

describe('receiving a cylinder at the site it went out from', () => {
  test('saves with no confirmation prompt', async () => {
    await issueFrom('SAME-1', PA);
    const res = await billService.createBill(user._id, billBody({
      location: PA, transaction_type: 'RECEIVED', received_items: [item('SAME-1')]
    }));
    expect(res.requires_cross_site_confirmation).toBeFalsy();
    expect(res.bill_number).toBeTruthy();
  });
});

describe('receiving a cylinder at a DIFFERENT site', () => {
  test('is refused until confirmed, and names both sites', async () => {
    await issueFrom('CROSS-1', PA);

    const res = await billService.createBill(user._id, billBody({
      location: CH, transaction_type: 'RECEIVED', received_items: [item('CROSS-1')]
    }));

    expect(res.requires_cross_site_confirmation).toBe(true);
    expect(res.bill_number).toBeUndefined();          // nothing was saved
    expect(res.cylinders).toHaveLength(1);
    expect(res.cylinders[0]).toMatchObject({ serial: 'CROSS-1', given_at: PA, received_at: CH });
    expect(res.message).toMatch(/Palanpur Office/);
    expect(res.message).toMatch(/Chandisar Plant/);

    // Still with the customer — an unconfirmed prompt must not have moved anything.
    const c = await Cylinder.findOne({ user_id: user._id, rotational_number: 'CROSS-1' }).lean();
    expect(c.stock_state).toBe('AT_CUSTOMER');
    expect(c.location).toBe(PA);
  });

  test('saves once confirmed, and moves the cylinder to the receiving site', async () => {
    const res = await billService.createBill(user._id, billBody({
      location: CH, transaction_type: 'RECEIVED', received_items: [item('CROSS-1')],
      confirm_cross_site: true
    }));
    expect(res.bill_number).toBeTruthy();

    const c = await Cylinder.findOne({ user_id: user._id, rotational_number: 'CROSS-1' }).lean();
    expect(c.stock_state).toBe('IN_STOCK');
    expect(c.location).toBe(CH);
  });

  test('the cylinder history explains where it came back from', async () => {
    const cyl = await Cylinder.findOne({ user_id: user._id, rotational_number: 'CROSS-1' }).lean();
    const ev = await CylinderHistory.findOne({ cylinder_id: cyl._id, event_type: 'RECEIVED' })
      .sort({ event_at: -1, createdAt: -1 }).lean();

    expect(ev).toBeTruthy();
    expect(ev.description).toMatch(/issued from Palanpur Office/);
    expect(ev.from_location).toBe(PA);
    expect(ev.to_location).toBe(CH);
  });

  test('NO transfer document is created — that would double-count the arrival', async () => {
    const transfers = await Bill.countDocuments({
      user_id: user._id, transaction_category: 'INTERNAL_TRANSFER'
    });
    expect(transfers).toBe(0);
  });

  test('the receiving site counts the arrival exactly once, with no negative balance', async () => {
    const rep = await reportService.getStockSummary(user._id, { date: '2026-06-12', location: CH });
    const row = rep.rows.find(r => r.gas_type === 'Oxygen');
    expect(row).toBeTruthy();

    // One cylinder came back, so exactly one empty received — not two.
    expect(row.empty.receive).toBe(1);
    for (const v of [row.filled.opening, row.filled.closing, row.empty.opening, row.empty.closing]) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test('the issuing site is not given a phantom movement', async () => {
    const rep = await reportService.getStockSummary(user._id, { date: '2026-06-12', location: PA });
    const row = rep.rows.find(r => r.gas_type === 'Oxygen');
    expect(row).toBeTruthy();

    // Palanpur genuinely took SAME-1 back on the 12th, so exactly ONE empty received. If a transfer
    // were being written for CROSS-1 this would be 2, and an issue would appear for sending it on.
    expect(row.empty.receive).toBe(1);
    expect(row.empty.issue).toBe(0);
    for (const v of [row.filled.opening, row.filled.closing, row.empty.opening, row.empty.closing]) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
