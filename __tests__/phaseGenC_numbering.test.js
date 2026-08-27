// Phase GEN-C: per-account, per-financial-year numbering, proved end to end against a real
// database rather than in isolation. These are the assertions that matter for a live billing
// system — two clients must never fight over a number, and a series that restarts each 1 April
// must actually restart.
process.env.NUMBERING_SALT = process.env.NUMBERING_SALT || 'test-salt-do-not-use-in-production';

const mongoose = require('mongoose');
const User = require('../models/User');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const Counter = require('../models/Counter');
const Customer = require('../models/Customer');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const LocationProfile = require('../models/LocationProfile');
const BusinessProfile = require('../models/BusinessProfile');
const billSvc = require('../services/bill.service');
const paySvc = require('../services/payment.service');
const acct = require('../services/accountNumbering.service');
const N = require('../services/numbering.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_genc_${Date.now()}`;
const CH = 'AT_PLANT_CHANDISAR';

// Two financial years, so "the same number in different years" is testable.
const FY26 = new Date('2026-06-15T10:00:00+05:30');   // FY 2026-27
const FY27 = new Date('2027-06-15T10:00:00+05:30');   // FY 2027-28

let gas, size;

// A complete, independent account: user + code + filling location + a customer.
async function makeAccount(label, { fyReset = false } = {}) {
  const user = await User.create({ name: label, email: `${label}@genc.test`, password: 'Test1234!' });
  await User.collection.updateOne(                       // immutable: native driver, as the migration does
    { _id: user._id }, { $set: { account_code: N.deriveAccountCode(user._id) } });
  await LocationProfile.create({ user_id: user._id, location: CH, manager_name: label, is_filling_location: true });
  await BusinessProfile.create({ user_id: user._id, fy_reset_numbering: fyReset });
  const cust = await Customer.create({
    user_id: user._id, company_name: `${label} Co`, phone_primary: '9999999999', holding_limit: 500 });
  acct._clearCache();
  return { uid: user._id, code: N.deriveAccountCode(user._id), cust };
}

const makeBill = (uid, cust, date, billNumber) => billSvc.createBill(uid, {
  customer_id: String(cust._id), bill_date: date, transaction_type: 'GIVEN',
  challan_no: 'C1', location: CH, bill_number: billNumber,
  // Personal (quantity-only) cylinders: the account's numbering is what is under test here,
  // not its inventory, and this keeps the fixture free of real Cylinder documents.
  given_items: [{
    gas_type_id: String(gas._id), cylinder_size_id: String(size._id),
    quantity: 0, rate: 100, personalCylindersIn: 1
  }]
});

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  await Promise.all([Bill.syncIndexes(), Payment.syncIndexes(), Counter.syncIndexes(), LocationProfile.syncIndexes()]);
  gas = await GasType.create({ gas_type_name: 'Oxygen', is_active: true });
  size = await CylinderSize.create({ size_label: '7 m3', is_active: true });
});
afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.connection.close(); });

describe('account isolation — the reason this phase exists', () => {
  test('two clients can each issue the SAME bill number', async () => {
    const a = await makeAccount('alpha');
    const b = await makeAccount('bravo');

    const ba = await makeBill(a.uid, a.cust, FY26, '1A001');
    const bb = await makeBill(b.uid, b.cust, FY26, '1A001');

    expect(ba.bill_number).toBe('1A001');
    expect(bb.bill_number).toBe('1A001');           // would have been rejected before GEN-C

    // Same visible number, different identities.
    const [da, db] = await Promise.all([
      Bill.findById(ba.bill_id).lean(), Bill.findById(bb.bill_id).lean()]);
    expect(da.account_code).not.toBe(db.account_code);
    expect(da.bill_uid).toBe(`${a.code}-2627-1A001`);
    expect(db.bill_uid).toBe(`${b.code}-2627-1A001`);
    expect(da.bill_uid).not.toBe(db.bill_uid);
  });

  test('the database itself refuses a duplicate WITHIN one account and year', async () => {
    const a = await makeAccount('charlie');
    await makeBill(a.uid, a.cust, FY26, '1A001');
    await expect(makeBill(a.uid, a.cust, FY26, '1A001')).rejects.toThrow(/already used/i);
  });

  test("one client's counter is not advanced by another's bills", async () => {
    const a = await makeAccount('delta');
    const b = await makeAccount('echo');
    // Burn several numbers on A.
    for (let i = 0; i < 3; i++) await makeBill(a.uid, a.cust, FY26, undefined);
    // B is untouched and still starts at the beginning.
    expect(await billSvc.generateBillNumber(b.uid, FY26)).toBe('1A001');
  });

  test('receipt numbers are scoped per account too', async () => {
    const a = await makeAccount('foxtrot');
    const b = await makeAccount('golf');
    const ra = await paySvc.createPayment(a.uid, {
      customer_id: String(a.cust._id), date: FY26, amount_received: 100, payment_mode: 'CASH' });
    const rb = await paySvc.createPayment(b.uid, {
      customer_id: String(b.cust._id), date: FY26, amount_received: 100, payment_mode: 'CASH' });
    // Both start their own series — before GEN-C the max was taken across EVERY payment.
    expect(ra.receipt_number).toBe('RCP-0001');
    expect(rb.receipt_number).toBe('RCP-0001');
  });
});

describe('financial-year reset OFF (the default)', () => {
  test('the series runs continuously across 1 April', async () => {
    const a = await makeAccount('hotel', { fyReset: false });
    await makeBill(a.uid, a.cust, FY26, undefined);          // 1A001, FY 2026-27
    const next = await billSvc.generateBillNumber(a.uid, FY27);
    expect(next).toBe('1A002');                              // NOT back to 1A001
  });

  test('one counter row, with no financial year attached', async () => {
    const a = await makeAccount('india', { fyReset: false });
    await makeBill(a.uid, a.cust, FY26, undefined);
    const rows = await Counter.find({ user_id: a.uid }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].financial_year).toBe('');
  });
});

describe('financial-year reset ON', () => {
  test('the series restarts at 1A001 in the new year', async () => {
    const a = await makeAccount('juliet', { fyReset: true });
    const first = await makeBill(a.uid, a.cust, FY26, undefined);
    const second = await makeBill(a.uid, a.cust, FY26, undefined);
    expect(first.bill_number).toBe('1A001');
    expect(second.bill_number).toBe('1A002');

    // Cross into the next financial year.
    expect(await billSvc.generateBillNumber(a.uid, FY27)).toBe('1A001');
  });

  test('the SAME number in two different years is legal, and distinguishable', async () => {
    const a = await makeAccount('kilo', { fyReset: true });
    const y1 = await makeBill(a.uid, a.cust, FY26, '1A001');
    const y2 = await makeBill(a.uid, a.cust, FY27, '1A001');   // same number, next year

    const [d1, d2] = await Promise.all([
      Bill.findById(y1.bill_id).lean(), Bill.findById(y2.bill_id).lean()]);
    expect(d1.bill_number).toBe(d2.bill_number);               // identical to the operator
    expect(d1.financial_year).toBe('2026-27');
    expect(d2.financial_year).toBe('2027-28');
    expect(d1.bill_uid).toBe(`${a.code}-2627-1A001`);
    expect(d2.bill_uid).toBe(`${a.code}-2728-1A001`);
    expect(d1.bill_uid).not.toBe(d2.bill_uid);                 // ...but findable apart years later
  });

  test('a separate counter row per financial year', async () => {
    const a = await makeAccount('lima', { fyReset: true });
    await makeBill(a.uid, a.cust, FY26, undefined);
    await makeBill(a.uid, a.cust, FY27, undefined);
    const rows = await Counter.find({ user_id: a.uid }).sort({ financial_year: 1 }).lean();
    expect(rows.map(r => r.financial_year)).toEqual(['2026-27', '2027-28']);
  });

  test('receipts restart each year as well', async () => {
    const a = await makeAccount('mike', { fyReset: true });
    const r1 = await paySvc.createPayment(a.uid, {
      customer_id: String(a.cust._id), date: FY26, amount_received: 50, payment_mode: 'CASH' });
    const r2 = await paySvc.createPayment(a.uid, {
      customer_id: String(a.cust._id), date: FY27, amount_received: 50, payment_mode: 'CASH' });
    expect(r1.receipt_number).toBe('RCP-0001');
    expect(r2.receipt_number).toBe('RCP-0001');
    const docs = await Payment.find({ user_id: a.uid }).sort({ date: 1 }).lean();
    expect(docs.map(d => d.receipt_uid)).toEqual([`${a.code}-2627-RCP-0001`, `${a.code}-2728-RCP-0001`]);
  });
});

describe('editing a bill number', () => {
  test('a number free in THIS year is accepted even though it exists in another', async () => {
    const a = await makeAccount('november', { fyReset: true });
    await makeBill(a.uid, a.cust, FY26, '1A050');          // taken in 2026-27
    const target = await makeBill(a.uid, a.cust, FY27, '1A900');
    // Renaming the 2027-28 bill to 1A050 is legal: the clash is in a different year.
    await expect(billSvc.updateBill({ id: a.uid }, target.bill_id, { bill_number: '1A050' }))
      .resolves.toBeTruthy();
    expect((await Bill.findById(target.bill_id).lean()).bill_number).toBe('1A050');
  });

  test('a number already taken in the SAME year is refused, naming the year', async () => {
    const a = await makeAccount('oscar', { fyReset: true });
    await makeBill(a.uid, a.cust, FY26, '1A060');
    const other = await makeBill(a.uid, a.cust, FY26, '1A061');
    await expect(billSvc.updateBill({ id: a.uid }, other.bill_id, { bill_number: '1A060' }))
      .rejects.toThrow(/already used .* 2026-27/i);
  });

  test("another account's bill number never blocks an edit", async () => {
    const a = await makeAccount('papa');
    const b = await makeAccount('quebec');
    await makeBill(a.uid, a.cust, FY26, '1A070');
    const mine = await makeBill(b.uid, b.cust, FY26, '1A071');
    await expect(billSvc.updateBill({ id: b.uid }, mine.bill_id, { bill_number: '1A070' }))
      .resolves.toBeTruthy();
  });
});

describe('moving a bill across 1 April', () => {
  test('re-dating into a year where the number is FREE is allowed, and the identity follows', async () => {
    const a = await makeAccount('romeo', { fyReset: true });
    const b1 = await makeBill(a.uid, a.cust, FY26, '1A080');
    await billSvc.updateBill({ id: a.uid }, b1.bill_id, { bill_date: FY27 });

    const doc = await Bill.findById(b1.bill_id).lean();
    expect(doc.financial_year).toBe('2027-28');
    expect(doc.bill_uid).toBe(`${a.code}-2728-1A080`);   // identity moved with it
    expect(doc.bill_number).toBe('1A080');               // the printed number did NOT change
  });

  test('re-dating into a year where the number is TAKEN is refused', async () => {
    const a = await makeAccount('sierra', { fyReset: true });
    await makeBill(a.uid, a.cust, FY27, '1A090');        // 1A090 already exists in 2027-28
    const mover = await makeBill(a.uid, a.cust, FY26, '1A090');  // legal: different year

    await expect(billSvc.updateBill({ id: a.uid }, mover.bill_id, { bill_date: FY27 }))
      .rejects.toThrow(/already used .* 2027-28/i);

    // And it stayed exactly where it was — a refused edit changes nothing.
    const doc = await Bill.findById(mover.bill_id).lean();
    expect(doc.financial_year).toBe('2026-27');
    expect(doc.bill_number).toBe('1A090');
  });
});

describe('the financial-year choice locks permanently', () => {
  const profileSvc = require('../services/profile.service');

  // Backdating createdAt is how an account is aged past its first 1 April without waiting.
  const ageAccount = (uid, when) => User.collection.updateOne({ _id: uid }, { $set: { createdAt: when } });

  test('a young account can still change it, and the deadline is reported', async () => {
    const a = await makeAccount('whiskey');
    await ageAccount(a.uid, new Date('2026-07-31T00:00:00Z'));   // like the live account

    const before = await profileSvc.getBusinessProfile(a.uid);
    expect(before.fy_choice_locked).toBe(false);
    expect(new Date(before.fy_lock_date).toISOString()).toBe('2027-03-31T18:30:00.000Z');  // 1 Apr 2027 IST

    await profileSvc.updateBusinessProfile(a.uid, { fy_reset_numbering: true });
    expect((await profileSvc.getBusinessProfile(a.uid)).fy_reset_numbering).toBe(true);
  });

  test('an account past its first 1 April is refused, and told when it locked', async () => {
    const a = await makeAccount('xray');
    await ageAccount(a.uid, new Date('2020-05-01T00:00:00Z'));   // long past 1 Apr 2021

    const p = await profileSvc.getBusinessProfile(a.uid);
    expect(p.fy_choice_locked).toBe(true);

    await expect(profileSvc.updateBusinessProfile(a.uid, { fy_reset_numbering: true }))
      .rejects.toThrow(/locked on .*01\/04\/2021/);
  });

  test('a locked account can still save the REST of its letterhead', async () => {
    const a = await makeAccount('yankee');
    await ageAccount(a.uid, new Date('2020-05-01T00:00:00Z'));

    // The Settings form posts the whole card, including the unchanged toggle. Re-sending the
    // same value must not be mistaken for an attempt to change it.
    await expect(profileSvc.updateBusinessProfile(a.uid, {
      business_name: 'Locked Co', fy_reset_numbering: false
    })).resolves.toBeTruthy();
    expect((await profileSvc.getBusinessProfile(a.uid)).business_name).toBe('Locked Co');
  });

  test('the account code is never exposed through the profile API', async () => {
    const a = await makeAccount('zulu');
    const p = await profileSvc.getBusinessProfile(a.uid);
    expect(p.account_code).toBe('');       // deliberately blanked - backend identity only
  });
});

describe('the derived fields keep themselves honest', () => {
  test('account_code is filled automatically — no creation site has to remember', async () => {
    const a = await makeAccount('tango');
    const b = await makeBill(a.uid, a.cust, FY26, '1A100');
    const doc = await Bill.findById(b.bill_id).lean();
    expect(doc.account_code).toBe(a.code);
    expect(doc.financial_year).toBe('2026-27');
    expect(doc.bill_uid).toBe(`${a.code}-2627-1A100`);
  });

  test('a direct findOneAndUpdate on a payment date still updates the identity', async () => {
    // This is the path payment.service.updatePayment uses. Document middleware does NOT run for
    // it, so without the query-level hook financial_year and receipt_uid would silently go stale.
    const a = await makeAccount('uniform', { fyReset: true });
    const r = await paySvc.createPayment(a.uid, {
      customer_id: String(a.cust._id), date: FY26, amount_received: 10, payment_mode: 'CASH' });

    const before = await Payment.findById(r.receipt_id).lean();
    expect(before.financial_year).toBe('2026-27');

    await paySvc.updatePayment(a.uid, String(r.receipt_id), { date: FY27 });

    const after = await Payment.findById(r.receipt_id).lean();
    expect(after.financial_year).toBe('2027-28');
    expect(after.receipt_uid).toBe(`${a.code}-2728-${after.receipt_number}`);
  });

  test('the account code is stable across the whole account, forever', async () => {
    const a = await makeAccount('victor');
    await makeBill(a.uid, a.cust, FY26, '1A110');
    await makeBill(a.uid, a.cust, FY27, '1A111');
    const codes = await Bill.distinct('account_code', { user_id: a.uid });
    expect(codes).toEqual([a.code]);
  });
});
