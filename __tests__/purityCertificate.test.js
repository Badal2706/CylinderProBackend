// F-11: Purity Test Certificate.
//
// Three things are worth pinning down and nothing else really is: that an issued certificate is
// genuinely unwritable (not merely un-buttoned), that its customer details are a snapshot rather
// than a join, and that its numbering is scoped the way bills and receipts are so it can never
// collide with either.

const mongoose = require('mongoose');

const User = require('../models/User');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const Counter = require('../models/Counter');
const BusinessProfile = require('../models/BusinessProfile');
const PurityCertificate = require('../models/PurityCertificate');
const certService = require('../services/purityCertificate.service');
const customerService = require('../services/customer.service');
const N = require('../services/numbering.service');
const acct = require('../services/accountNumbering.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_purity_${Date.now()}`;

let user, customer;

const body = (over) => ({
  customer_id: String(customer._id),
  date: new Date('2026-06-12T10:00:00+05:30'),
  gas_type: 'Oxygen',
  purity_percent: '99.5',
  sub_line: 'Test Certificate for Oxygen Gas',
  declaration_text: 'This is to certify that the gas supplied has been tested.',
  cylinder_owner: 'Guru Industries',
  cylinder_water_capacity_ltrs: '46.7',
  qty: '10',
  filling_date: new Date('2026-06-11T10:00:00+05:30'),
  cylinder_serial_no: '1024, 1025',
  impurities: [
    { name: 'Moisture (H2O)', ppm_text: '5' },
    { name: 'Carbon Monoxide (CO)', ppm_text: 'Nil' }
  ],
  ...over
});

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  user = await User.create({ name: 'P', email: 'purity@cert.test', password: 'Test1234!' });
  user.account_code = N.deriveAccountCode(user._id);
  await user.save();
  acct._clearCache();

  await BusinessProfile.create({ user_id: user._id, business_name: 'Guru Industries', certificate_prefix: 'GI' });
  customer = await Customer.create({
    user_id: user._id, company_name: 'Shri Hari Hospital', customer_type: 'REGULAR',
    address: 'Station Road, Palanpur', phone_primary: '9000000000', is_active: true, holding_limit: 99
  });
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

describe('numbering', () => {
  test('the first certificate takes the prefix/TC/FY/seq form', async () => {
    const res = await certService.createCertificate(user._id, body());
    expect(res.certificate_number).toBe('GI/TC/2026-27/1');
  });

  test('the series advances, and its counter is separate from the bill counter', async () => {
    const res = await certService.createCertificate(user._id, body());
    expect(res.certificate_number).toBe('GI/TC/2026-27/2');

    // Its own key. A bill issued in between must not push the certificate series along, and vice
    // versa — that separation is the whole point of giving it a key of its own.
    const keys = (await Counter.find({ user_id: user._id }).lean()).map(c => c.key);
    expect(keys).toContain('purity_certificate_series');
    expect(keys).not.toContain('bill_number_series');
  });

  test('a certificate number can never collide with a bill or receipt number', async () => {
    // Different collections with independent unique indexes, and a format no bill or receipt
    // series can produce. This asserts the property directly rather than trusting the format.
    const cert = await PurityCertificate.findOne({ user_id: user._id }).lean();
    expect(await Bill.exists({ bill_number: cert.certificate_number })).toBeFalsy();
    expect(await Payment.exists({ receipt_number: cert.certificate_number })).toBeFalsy();
    expect(cert.certificate_number).toMatch(/\/TC\//);
  });

  test('a blank prefix drops the segment rather than printing a leading slash', () => {
    expect(certService.formatCertificateNumber('', '2026-27', 4)).toBe('TC/2026-27/4');
    expect(certService.formatCertificateNumber('  ', '2026-27', 4)).toBe('TC/2026-27/4');
    expect(certService.formatCertificateNumber('GI', '2026-27', 4)).toBe('GI/TC/2026-27/4');
  });

  test('the numbering identity fields are filled in, scoped to the financial year', async () => {
    const cert = await PurityCertificate.findOne({ user_id: user._id }).sort({ createdAt: 1 }).lean();
    expect(cert.account_code).toBe(user.account_code);
    expect(cert.financial_year).toBe('2026-27');
    expect(cert.certificate_uid).toBe(N.buildUid(user.account_code, '2026-27', cert.certificate_number));
  });

  test('a number already taken is stepped past, not reissued', async () => {
    // Simulates a certificate that occupies the next slot without the counter knowing — the same
    // situation peekNextBillNumber guards against for bills.
    const { accountCode, financialYear } = await acct.getContext(user._id, new Date('2026-06-12'));
    await PurityCertificate.create({
      user_id: user._id, customer_id: customer._id, date: new Date('2026-06-12T10:00:00+05:30'),
      certificate_number: 'GI/TC/2026-27/3', account_code: accountCode, financial_year: financialYear
    });
    const res = await certService.createCertificate(user._id, body());
    expect(res.certificate_number).toBe('GI/TC/2026-27/4');
  });
});

describe('the customer is snapshotted, not joined', () => {
  test('name and address are copied from the customer record at issue time', async () => {
    const res = await certService.createCertificate(user._id, body());
    const cert = await certService.getCertificate(user._id, res.certificate_id);
    expect(cert.customer_name).toBe('Shri Hari Hospital');
    expect(cert.customer_address).toBe('Station Road, Palanpur');
  });

  test('editing the customer afterwards does NOT change the issued certificate', async () => {
    const res = await certService.createCertificate(user._id, body());

    await customerService.updateCustomer(user._id, String(customer._id), {
      company_name: 'Shri Hari Hospital & Research Centre',
      address: 'New Highway Road, Deesa'
    });

    const cert = await certService.getCertificate(user._id, res.certificate_id);
    expect(cert.customer_name).toBe('Shri Hari Hospital');
    expect(cert.customer_address).toBe('Station Road, Palanpur');

    // …and the customer really did change, so the assertion above means something.
    const fresh = await Customer.findById(customer._id).lean();
    expect(fresh.address).toBe('New Highway Road, Deesa');
  });

  test('the form may correct the name and address before issuing', async () => {
    const res = await certService.createCertificate(user._id, body({
      customer_name: 'Shri Hari Hospital (Unit II)',
      customer_address: 'Plot 9, GIDC'
    }));
    const cert = await certService.getCertificate(user._id, res.certificate_id);
    expect(cert.customer_name).toBe('Shri Hari Hospital (Unit II)');
    expect(cert.customer_address).toBe('Plot 9, GIDC');
  });
});

describe('an issued certificate is immutable', () => {
  let certId;
  beforeAll(async () => {
    const res = await certService.createCertificate(user._id, body({ purity_percent: '99.7' }));
    certId = res.certificate_id;
  });

  test('re-saving a loaded document with a changed field is refused', async () => {
    const doc = await PurityCertificate.findById(certId);
    doc.purity_percent = '95.0';
    await expect(doc.save()).rejects.toThrow(/cannot be edited once issued/i);

    const after = await PurityCertificate.findById(certId).lean();
    expect(after.purity_percent).toBe('99.7');
  });

  test('findOneAndUpdate is refused', async () => {
    await expect(
      PurityCertificate.findOneAndUpdate({ _id: certId }, { $set: { gas_type: 'Nitrogen' } })
    ).rejects.toThrow(/immutable once issued/i);
    expect((await PurityCertificate.findById(certId).lean()).gas_type).toBe('Oxygen');
  });

  test('updateOne and updateMany are refused', async () => {
    await expect(PurityCertificate.updateOne({ _id: certId }, { $set: { qty: '1' } }))
      .rejects.toThrow(/immutable once issued/i);
    await expect(PurityCertificate.updateMany({ user_id: user._id }, { $set: { qty: '1' } }))
      .rejects.toThrow(/immutable once issued/i);
    expect((await PurityCertificate.findById(certId).lean()).qty).toBe('10');
  });

  test('the impurity rows are immutable too', async () => {
    const doc = await PurityCertificate.findById(certId);
    doc.impurities.push({ name: 'Argon', ppm_text: '3' });
    await expect(doc.save()).rejects.toThrow(/cannot be edited once issued/i);
    expect((await PurityCertificate.findById(certId).lean()).impurities).toHaveLength(2);
  });

  test('re-saving an untouched document is still allowed', async () => {
    // The guard must catch real edits, not any save at all — otherwise ordinary code that loads
    // and re-saves a document for an unrelated reason would break.
    const doc = await PurityCertificate.findById(certId);
    await expect(doc.save()).resolves.toBeTruthy();
  });

  test('the service exposes no update function at all', () => {
    expect(certService.updateCertificate).toBeUndefined();
    expect(Object.keys(certService).filter(k => /update|edit/i.test(k))).toHaveLength(0);
  });
});

describe('listing and deleting', () => {
  test('certificates list newest first, scoped to one customer', async () => {
    const other = await Customer.create({
      user_id: user._id, company_name: 'Other Co', customer_type: 'REGULAR',
      phone_primary: '9000000001', is_active: true, holding_limit: 9
    });
    await certService.createCertificate(user._id, body({ customer_id: String(other._id) }));

    const mine = await certService.listCertificates(user._id, { customer_id: String(customer._id) });
    expect(mine.length).toBeGreaterThan(1);
    expect(mine.every(c => String(c.customer_id) === String(customer._id))).toBe(true);

    const all = await certService.listCertificates(user._id, {});
    expect(all.length).toBe(mine.length + 1);
  });

  test('deleting removes the certificate and nothing else', async () => {
    const res = await certService.createCertificate(user._id, body());
    const before = {
      customers: await Customer.countDocuments({ user_id: user._id }),
      bills: await Bill.countDocuments({ user_id: user._id }),
      payments: await Payment.countDocuments({ user_id: user._id })
    };

    await certService.deleteCertificate(user._id, res.certificate_id);

    expect(await PurityCertificate.findById(res.certificate_id)).toBeNull();
    expect(await Customer.countDocuments({ user_id: user._id })).toBe(before.customers);
    expect(await Bill.countDocuments({ user_id: user._id })).toBe(before.bills);
    expect(await Payment.countDocuments({ user_id: user._id })).toBe(before.payments);
  });

  test('a deleted number is NOT handed out again', async () => {
    const gone = await certService.createCertificate(user._id, body());
    await certService.deleteCertificate(user._id, gone.certificate_id);
    const next = await certService.createCertificate(user._id, body());
    expect(next.certificate_number).not.toBe(gone.certificate_number);
  });

  test('another account cannot read or delete this account\'s certificate', async () => {
    const stranger = await User.create({ name: 'S', email: 'stranger@cert.test', password: 'Test1234!' });
    const res = await certService.createCertificate(user._id, body());
    await expect(certService.getCertificate(stranger._id, res.certificate_id)).rejects.toThrow(/not found/i);
    await expect(certService.deleteCertificate(stranger._id, res.certificate_id)).rejects.toThrow(/not found/i);
    expect(await PurityCertificate.findById(res.certificate_id)).toBeTruthy();
  });
});

describe('content handling', () => {
  test('blank impurity rows are dropped, partial ones kept', async () => {
    const res = await certService.createCertificate(user._id, body({
      impurities: [
        { name: 'Moisture', ppm_text: '5' },
        { name: '', ppm_text: '' },          // an artifact of "+ Add row" — dropped
        { name: 'Oxygen', ppm_text: '' },    // a real statement in progress — kept
        { name: '', ppm_text: 'Nil' }        // likewise
      ]
    }));
    const cert = await certService.getCertificate(user._id, res.certificate_id);
    expect(cert.impurities).toHaveLength(3);
    expect(cert.impurities[0]).toMatchObject({ name: 'Moisture', ppm_text: '5' });
  });

  test('impurity order is preserved exactly as entered', async () => {
    const rows = [
      { name: 'C', ppm_text: '3' }, { name: 'A', ppm_text: '1' }, { name: 'B', ppm_text: '2' }
    ];
    const res = await certService.createCertificate(user._id, body({ impurities: rows }));
    const cert = await certService.getCertificate(user._id, res.certificate_id);
    expect(cert.impurities.map(r => r.name)).toEqual(['C', 'A', 'B']);
  });

  test('an optional delivery date left blank is stored as null, not an invalid date', async () => {
    const res = await certService.createCertificate(user._id, body({ delivery_date: '' }));
    const cert = await certService.getCertificate(user._id, res.certificate_id);
    expect(cert.delivery_date).toBeNull();
    expect(cert.challan_ref).toBe('');
  });

  test('a missing customer is refused', async () => {
    await expect(certService.createCertificate(user._id, body({
      customer_id: String(new mongoose.Types.ObjectId())
    }))).rejects.toThrow(/Customer not found/i);
  });
});

describe('cascades', () => {
  test('hard-deleting a customer takes its certificates with it', async () => {
    const doomed = await Customer.create({
      user_id: user._id, company_name: 'Closing Down Ltd', customer_type: 'REGULAR',
      phone_primary: '9000000002', is_active: true, holding_limit: 9
    });
    await certService.createCertificate(user._id, body({ customer_id: String(doomed._id) }));
    expect(await PurityCertificate.countDocuments({ customer_id: doomed._id })).toBe(1);

    const result = await customerService.deleteCustomerCascade(user._id, String(doomed._id));
    expect(result.deleted.purity_certificates).toBe(1);
    expect(await PurityCertificate.countDocuments({ customer_id: doomed._id })).toBe(0);

    // Everyone else's certificates are untouched.
    expect(await PurityCertificate.countDocuments({ customer_id: customer._id })).toBeGreaterThan(0);
  });

  test('the restore path is not blocked by the immutability guards', async () => {
    // A restore reproduces documents that were already issued once; it inserts through the native
    // driver precisely so schema middleware does not re-derive them. The guards must refuse
    // UPDATES without ever standing in the way of that.
    const id = new mongoose.Types.ObjectId();
    await PurityCertificate.collection.insertMany([{
      _id: id, user_id: user._id, customer_id: customer._id, date: new Date(),
      certificate_number: 'RESTORED/TC/2026-27/999', account_code: user.account_code,
      financial_year: '2026-27', purity_percent: '99.9', impurities: []
    }], { ordered: false });
    expect((await PurityCertificate.findById(id).lean()).certificate_number).toBe('RESTORED/TC/2026-27/999');
    await PurityCertificate.deleteOne({ _id: id });
  });

  test('certificates are included in the backup collection list', () => {
    // Registration here is what puts them in a backup AND in the account-purge list, which is
    // derived from the same array (profile.service.deleteAccount).
    const backup = require('../services/backup.service');
    const spec = backup.COLLECTIONS.find(c => c.model === 'PurityCertificate');
    expect(spec).toBeTruthy();
    expect(spec.scope).toBe('user');
    expect(spec.key).toBe('puritycertificates');
  });
});
