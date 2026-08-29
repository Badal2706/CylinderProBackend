// Stock Summary — the invariant that no figure may ever be negative.
//
// "How can we give a cylinder to someone if it does not exist at our location?" Every number in
// this report counts physical cylinders. There is no minus one cylinder, at any site, on any day.
//
// The report derives a past day BACKWARDS: Closing(today) is the site's real current stock, and
// each day's figures are found by backing movements out of it. That only holds while two things
// agree about every cylinder:
//
//   (a) which POOL it is in now — filled or empty — decided by its latest event ever, and
//   (b) which MOVEMENTS are recorded at each site.
//
// Wherever those two disagree, the arithmetic produces a negative. Each test below is one such
// disagreement, written as the behaviour that must hold.
process.env.NUMBERING_SALT = process.env.NUMBERING_SALT || 'test-salt-do-not-use-in-production';

const mongoose = require('mongoose');

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

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_neg_${Date.now()}`;

const PLANT = 'AT_WORKS_ALPHA';
const OFFICE_A = 'AT_DEPOT_BETA';
const OFFICE_B = 'AT_DEPOT_GAMMA';

const GAS = 'Oxygen';
const CAP = '7 m3';

let user, gas, size, vendor, regular;

const item = (serial) => ({
  gas_type_id: String(gas._id), cylinder_size_id: String(size._id),
  quantity: 1, rate: 0, serial_numbers: [serial]
});

async function rowAt(location, date) {
  const rep = await reportService.getStockSummary(user._id, { date, location });
  const row = rep.rows.find(r => r.gas_type === GAS && r.capacity === CAP);
  return row || { filled: { opening: 0, add: 0, issue: 0, closing: 0 },
                  empty: { opening: 0, receive: 0, issue: 0, closing: 0 } };
}

// Every figure in one row, flattened, so a negative can be named precisely.
const figures = (row) => ([
  ['filled.opening', row.filled.opening], ['filled.add', row.filled.add],
  ['filled.issue', row.filled.issue], ['filled.closing', row.filled.closing],
  ['empty.opening', row.empty.opening], ['empty.receive', row.empty.receive],
  ['empty.issue', row.empty.issue], ['empty.closing', row.empty.closing]
]);
const negativesIn = (row) => figures(row).filter(([, v]) => v < 0).map(([k, v]) => `${k}=${v}`);

async function mkCylinder(serial, location) {
  return Cylinder.create({
    user_id: user._id, rotational_number: serial, gas_type: GAS, capacity: CAP,
    location, stock_state: 'IN_STOCK'
  });
}

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  user = await User.create({ name: 'N', email: 'neg@stock.test', password: 'Test1234!' });
  user.account_code = N.deriveAccountCode(user._id);
  await user.save();
  acct._clearCache();

  await LocationProfile.create([
    { user_id: user._id, location: PLANT, label: 'Works Alpha', is_filling_location: true },
    { user_id: user._id, location: OFFICE_A, label: 'Depot Beta' },
    { user_id: user._id, location: OFFICE_B, label: 'Depot Gamma' }
  ]);
  gas = await GasType.create({ gas_type_name: GAS, is_active: true });
  size = await CylinderSize.create({ size_label: CAP, is_active: true });

  vendor = await Customer.create({
    user_id: user._id, company_name: 'Refill Vendor Ltd', customer_type: 'REGULAR',
    phone_primary: '9000000001', is_active: true, is_filling_vendor: true, holding_limit: 999
  });
  regular = await Customer.create({
    user_id: user._id, company_name: 'Ordinary Customer', customer_type: 'REGULAR',
    phone_primary: '9000000002', is_active: true, holding_limit: 99
  });
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a cylinder returned FILLED by a filling vendor', () => {
  // R55: for a filling vendor the directions inverse. We GIVE them empties and RECEIVE filled
  // cylinders back — the opposite of an ordinary customer. The movement side of the report knows
  // this. The pool the cylinder lands in must know it too, or the two disagree by one cylinder.
  const S = 'VEND-1';
  const DAY = '2026-06-20';

  beforeAll(async () => {
    await mkCylinder(S, PLANT);
    // We send it out empty to the vendor…
    await billService.createBill(user._id, {
      customer_id: String(vendor._id), customer_type: 'REGULAR', challan_no: 'V-1',
      location: PLANT, transaction_type: 'GIVEN', given_items: [item(S)],
      bill_date: new Date(`${DAY}T09:00:00+05:30`)
    });
    // …and it comes back FILLED the same day.
    await billService.createBill(user._id, {
      customer_id: String(vendor._id), customer_type: 'REGULAR', challan_no: 'V-2',
      location: PLANT, transaction_type: 'RECEIVED', received_items: [item(S)],
      bill_date: new Date(`${DAY}T16:00:00+05:30`)
    });
  });

  test('it is counted as filled stock arriving, not empty', async () => {
    const row = await rowAt(PLANT, DAY);
    expect(row.filled.add).toBe(1);      // vendor returned it filled
    expect(row.empty.issue).toBe(1);     // we sent an empty out to them
  });

  test('no figure is negative', async () => {
    expect(negativesIn(await rowAt(PLANT, DAY))).toEqual([]);
  });

  test('both ledgers balance', async () => {
    const row = await rowAt(PLANT, DAY);
    expect(row.filled.opening + row.filled.add - row.filled.issue).toBe(row.filled.closing);
    expect(row.empty.opening + row.empty.receive - row.empty.issue).toBe(row.empty.closing);
  });

  test('it ends the day in the filled pool, where it physically is', async () => {
    const row = await rowAt(PLANT, DAY);
    expect(row.filled.closing).toBe(1);
    expect(row.empty.closing).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a transfer between two NON-filling sites', () => {
  // Neither end is the plant. The cylinder physically leaves one site and arrives at the other,
  // so both sites must show it — otherwise the destination's stock appears from nowhere and the
  // source's goes missing.
  const S = 'SUB-1';
  const DAY = '2026-06-21';

  beforeAll(async () => {
    await mkCylinder(S, PLANT);
    // Give it a filled history first: transferred out from the plant, so it is filled stock.
    await billService.createBill(user._id, {
      transaction_category: 'INTERNAL_TRANSFER', challan_no: 'S-0',
      from_location: PLANT, to_location: OFFICE_A, serial_numbers: [S],
      bill_date: new Date('2026-06-19T10:00:00+05:30')
    });
    // …then office A hands it on to office B, without the plant being involved at all.
    await billService.createBill(user._id, {
      transaction_category: 'INTERNAL_TRANSFER', challan_no: 'S-1',
      from_location: OFFICE_A, to_location: OFFICE_B, serial_numbers: [S],
      bill_date: new Date(`${DAY}T11:00:00+05:30`)
    });
  });

  test('the cylinder really did move', async () => {
    expect((await Cylinder.findOne({ user_id: user._id, rotational_number: S }).lean()).location)
      .toBe(OFFICE_B);
  });

  test('the sending site records it leaving', async () => {
    const row = await rowAt(OFFICE_A, DAY);
    expect(row.filled.issue).toBe(1);
    expect(row.filled.opening).toBe(1);   // it was there when the day began
    expect(row.filled.closing).toBe(0);   // and gone by the end
  });

  test('the receiving site records it arriving', async () => {
    const row = await rowAt(OFFICE_B, DAY);
    expect(row.filled.add).toBe(1);
    expect(row.filled.opening).toBe(0);   // it was NOT there when the day began
    expect(row.filled.closing).toBe(1);
  });

  test('neither site reports a negative', async () => {
    expect(negativesIn(await rowAt(OFFICE_A, DAY))).toEqual([]);
    expect(negativesIn(await rowAt(OFFICE_B, DAY))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a past day, reported after the cylinder has moved on', () => {
  // The report is derived backwards from today's stock, so a past day's figures depend on
  // everything that happened since. Running the same past day later must not change it.
  const S = 'PAST-1';
  const DAY1 = '2026-06-22';   // returned empty by a customer
  const DAY2 = '2026-06-23';   // transferred to the plant and refilled

  beforeAll(async () => {
    await mkCylinder(S, OFFICE_A);
    await billService.createBill(user._id, {
      customer_id: String(regular._id), customer_type: 'REGULAR', challan_no: 'P-0',
      location: OFFICE_A, transaction_type: 'GIVEN', given_items: [item(S)],
      bill_date: new Date('2026-06-21T09:00:00+05:30')
    });
    await billService.createBill(user._id, {
      customer_id: String(regular._id), customer_type: 'REGULAR', challan_no: 'P-1',
      location: OFFICE_A, transaction_type: 'RECEIVED', received_items: [item(S)],
      bill_date: new Date(`${DAY1}T10:00:00+05:30`)
    });
    await billService.createBill(user._id, {
      transaction_category: 'INTERNAL_TRANSFER', challan_no: 'P-2',
      from_location: OFFICE_A, to_location: PLANT, serial_numbers: [S],
      bill_date: new Date(`${DAY2}T10:00:00+05:30`)
    });
  });

  test('on the day it came back, the office shows it as an empty received and held', async () => {
    const row = await rowAt(OFFICE_A, DAY1);
    expect(row.empty.receive).toBe(1);
    expect(row.empty.closing).toBe(1);    // still sitting there at close of that day
    expect(negativesIn(row)).toEqual([]);
  });

  test('on the next day it leaves as an empty transferred out', async () => {
    const row = await rowAt(OFFICE_A, DAY2);
    expect(row.empty.opening).toBe(1);
    expect(row.empty.issue).toBe(1);
    expect(row.empty.closing).toBe(0);
    expect(negativesIn(row)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the invariant, stated once over every site and every day touched', () => {
  test('no site reports a negative figure on any day in the range', async () => {
    const days = ['2026-06-19', '2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23', '2026-06-24'];
    const found = [];
    for (const loc of [PLANT, OFFICE_A, OFFICE_B]) {
      for (const d of days) {
        const rep = await reportService.getStockSummary(user._id, { date: d, location: loc });
        for (const row of rep.rows) {
          const neg = negativesIn(row);
          if (neg.length) found.push(`${loc} ${d} ${row.gas_type}/${row.capacity}: ${neg.join(', ')}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  test('every ledger balances on every day', async () => {
    const days = ['2026-06-19', '2026-06-20', '2026-06-21', '2026-06-22', '2026-06-23', '2026-06-24'];
    const broken = [];
    for (const loc of [PLANT, OFFICE_A, OFFICE_B]) {
      for (const d of days) {
        const rep = await reportService.getStockSummary(user._id, { date: d, location: loc });
        for (const r of rep.rows) {
          if (r.filled.opening + r.filled.add - r.filled.issue !== r.filled.closing)
            broken.push(`${loc} ${d} filled`);
          if (r.empty.opening + r.empty.receive - r.empty.issue !== r.empty.closing)
            broken.push(`${loc} ${d} empty`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
