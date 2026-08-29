// Proves F-11 against the REAL production-copy database, over HTTP, and leaves the database
// exactly as it found it.
//
// The certificate is issued for a real customer — that customer's record is only READ, never
// written. The one check that needs a customer edit ("editing the address afterwards must not
// change an issued certificate") runs against a throwaway customer created and hard-deleted by
// this script, so no live record is ever modified.
//
// Everything this script creates is removed at the end: the certificates, the throwaway customer,
// and the sequence numbers they consumed. The final checks confirm that.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const BASE = process.env.BASE || 'http://127.0.0.1:3001';
const results = [];
const check = (l, ok, d) => { results.push(!!ok); console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${l}${d ? '   -> ' + d : ''}`); };

(async () => {
  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const User = require('../models/User');
  const Customer = require('../models/Customer');
  const Bill = require('../models/Bill');
  const Payment = require('../models/Payment');
  const Cylinder = require('../models/Cylinder');
  const Counter = require('../models/Counter');
  const BusinessProfile = require('../models/BusinessProfile');
  const PurityCertificate = require('../models/PurityCertificate');
  const N = require('../services/numbering.service');

  const user = await User.findOne({ email: /gurugases/i }).select('_id token_version account_code email').lean();
  const token = jwt.sign({ id: String(user._id), tv: user.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const profile = await BusinessProfile.findOne({ user_id: user._id }).select('certificate_prefix').lean();
  const prefix = (profile && profile.certificate_prefix) || '';
  const fy = N.financialYear(new Date());

  // ── Baseline: everything that must be identical when this script finishes ──
  const before = {
    certificates: await PurityCertificate.countDocuments({ user_id: user._id }),
    customers: await Customer.countDocuments({ user_id: user._id }),
    bills: await Bill.countDocuments({ user_id: user._id }),
    payments: await Payment.countDocuments({ user_id: user._id }),
    cylinders: await Cylinder.countDocuments({ user_id: user._id }),
    certCounter: await Counter.findOne({ user_id: user._id, key: 'purity_certificate_series' }).lean(),
    billCounter: await Counter.findOne({ user_id: user._id, key: 'bill_number_series' }).lean()
  };

  const real = await Customer.findOne({ user_id: user._id, is_active: true })
    .select('_id company_name address').sort({ company_name: 1 }).lean();
  console.log(`account       : ${user.email}`);
  console.log(`financial year: ${fy}`);
  console.log(`prefix        : ${prefix ? JSON.stringify(prefix) : '(blank — numbers read "TC/…")'}`);
  console.log(`real customer : ${real.company_name}`);
  console.log(`existing certs: ${before.certificates}\n`);

  const post = (body) => fetch(`${BASE}/api/purity-certificates`, {
    method: 'POST', headers: auth, body: JSON.stringify(body)
  });

  const certBody = (customerId, over) => ({
    customer_id: String(customerId),
    date: new Date().toISOString().slice(0, 10),
    gas_type: 'Oxygen',
    purity_percent: '99.5',
    sub_line: 'Test Certificate for Oxygen Gas',
    declaration_text: 'VERIFY-F11 — issued by scripts/verifyPurityCertificate.js.',
    cylinder_owner: 'Guru Industries',
    cylinder_water_capacity_ltrs: '46.7',
    qty: '2',
    filling_date: new Date().toISOString().slice(0, 10),
    cylinder_serial_no: 'VERIFY-1, VERIFY-2',
    impurities: [{ name: 'Moisture (H2O)', ppm_text: '5' }, { name: 'CO', ppm_text: 'Nil' }],
    ...over
  });

  const created = [];   // every certificate id this script issues, for cleanup

  // ── 1. Issue one for a real customer ──
  const r1 = await post(certBody(real._id));
  const j1 = await r1.json();
  created.push(j1.certificate_id);
  const expected = new RegExp('^' + (prefix ? prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' : '') + 'TC/' + fy + '/\\d+$');
  check('a certificate is issued for a real customer', !!j1.certificate_id, j1.certificate_number || JSON.stringify(j1).slice(0, 140));
  check('its number follows {prefix}/TC/{FY}/{seq}', expected.test(j1.certificate_number || ''), j1.certificate_number);

  const saved = await PurityCertificate.findById(j1.certificate_id).lean();
  check('the customer name and address are snapshotted onto it',
    saved.customer_name === (real.company_name || '') && saved.customer_address === (real.address || ''),
    `${saved.customer_name} / ${saved.customer_address}`);
  check('the numbering identity is scoped to this account and year',
    saved.account_code === user.account_code && saved.financial_year === fy &&
    saved.certificate_uid === N.buildUid(user.account_code, fy, saved.certificate_number));

  // ── 2. The series advances, and no other series moves with it ──
  const r2 = await post(certBody(real._id));
  const j2 = await r2.json();
  created.push(j2.certificate_id);
  const seqOf = (n) => parseInt(String(n).split('/').pop(), 10);
  check('the next certificate takes the next number in the series',
    seqOf(j2.certificate_number) === seqOf(j1.certificate_number) + 1,
    `${j1.certificate_number} -> ${j2.certificate_number}`);

  const billCounterNow = await Counter.findOne({ user_id: user._id, key: 'bill_number_series' }).lean();
  check('the bill counter was not touched',
    (billCounterNow && billCounterNow.seq) === (before.billCounter && before.billCounter.seq),
    `${before.billCounter && before.billCounter.seq} -> ${billCounterNow && billCounterNow.seq}`);

  // ── 3. Numbering cannot collide with a bill or a receipt ──
  const nums = [j1.certificate_number, j2.certificate_number];
  check('no bill in the database carries a certificate number',
    (await Bill.countDocuments({ user_id: user._id, bill_number: { $in: nums } })) === 0);
  check('no receipt in the database carries a certificate number',
    (await Payment.countDocuments({ user_id: user._id, receipt_number: { $in: nums } })) === 0);

  // ── 4. There is no way to edit one ──
  const putRes = await fetch(`${BASE}/api/purity-certificates/${j1.certificate_id}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ purity_percent: '10' })
  });
  const patchRes = await fetch(`${BASE}/api/purity-certificates/${j1.certificate_id}`, {
    method: 'PATCH', headers: auth, body: JSON.stringify({ purity_percent: '10' })
  });
  check('there is no PUT route for a certificate', putRes.status === 404 || putRes.status === 405, `HTTP ${putRes.status}`);
  check('there is no PATCH route for a certificate', patchRes.status === 404 || patchRes.status === 405, `HTTP ${patchRes.status}`);

  let refused = false;
  try { await PurityCertificate.updateOne({ _id: j1.certificate_id }, { $set: { purity_percent: '10' } }); }
  catch (e) { refused = /immutable once issued/i.test(e.message); }
  const stillSame = await PurityCertificate.findById(j1.certificate_id).select('purity_percent').lean();
  check('a direct database update is refused by the model itself', refused);
  check('and the stored value is unchanged', stillSame.purity_percent === '99.5', stillSame.purity_percent);

  // ── 5. Editing the source customer does not change an issued certificate ──
  // Runs against a throwaway customer so no live customer record is ever written.
  const tmp = await Customer.create({
    user_id: user._id, company_name: 'VERIFY-F11 Temp Customer', customer_type: 'REGULAR',
    address: 'Original Address, Palanpur', phone_primary: '9000000000', is_active: true, holding_limit: 5
  });
  const r3 = await post(certBody(tmp._id));
  const j3 = await r3.json();
  created.push(j3.certificate_id);

  const beforeEdit = await PurityCertificate.findById(j3.certificate_id).lean();
  await Customer.updateOne({ _id: tmp._id }, { $set: { address: 'Changed Address, Deesa', company_name: 'VERIFY-F11 Renamed' } });
  const afterEdit = await PurityCertificate.findById(j3.certificate_id).lean();

  check('the certificate captured the customer as it was',
    beforeEdit.customer_name === 'VERIFY-F11 Temp Customer' && beforeEdit.customer_address === 'Original Address, Palanpur');
  check('editing the customer afterwards leaves the certificate untouched',
    afterEdit.customer_name === beforeEdit.customer_name && afterEdit.customer_address === beforeEdit.customer_address,
    `${afterEdit.customer_name} / ${afterEdit.customer_address}`);
  check('the customer really did change, so that check means something',
    (await Customer.findById(tmp._id).lean()).address === 'Changed Address, Deesa');

  // ── 6. Delete leaves everything else alone ──
  const midCounts = {
    bills: await Bill.countDocuments({ user_id: user._id }),
    payments: await Payment.countDocuments({ user_id: user._id }),
    cylinders: await Cylinder.countDocuments({ user_id: user._id })
  };
  const delRes = await fetch(`${BASE}/api/purity-certificates/${j1.certificate_id}`, { method: 'DELETE', headers: auth });
  check('a certificate deletes over the API', delRes.ok, `HTTP ${delRes.status}`);
  check('it is gone', (await PurityCertificate.findById(j1.certificate_id)) === null);
  check('no bill, payment or cylinder was affected by the delete',
    (await Bill.countDocuments({ user_id: user._id })) === midCounts.bills &&
    (await Payment.countDocuments({ user_id: user._id })) === midCounts.payments &&
    (await Cylinder.countDocuments({ user_id: user._id })) === midCounts.cylinders);

  // ── Cleanup: remove everything this script created, including the numbers it consumed ──
  // The service deliberately never rewinds the counter — a reissued number would mean two
  // documents had once shared an identity. That is right for a real deletion and wrong for
  // documents that never existed as far as the business is concerned, so it is undone here.
  await PurityCertificate.deleteMany({ _id: { $in: created.filter(Boolean) } });
  await Customer.deleteOne({ _id: tmp._id });
  if (before.certCounter) {
    await Counter.updateOne({ user_id: user._id, key: 'purity_certificate_series' },
      { $set: { seq: before.certCounter.seq } });
  } else {
    await Counter.deleteOne({ user_id: user._id, key: 'purity_certificate_series' });
  }

  const after = {
    certificates: await PurityCertificate.countDocuments({ user_id: user._id }),
    customers: await Customer.countDocuments({ user_id: user._id }),
    bills: await Bill.countDocuments({ user_id: user._id }),
    payments: await Payment.countDocuments({ user_id: user._id }),
    cylinders: await Cylinder.countDocuments({ user_id: user._id })
  };
  const certCounterAfter = await Counter.findOne({ user_id: user._id, key: 'purity_certificate_series' }).lean();

  console.log('');
  check('every count is back to the baseline',
    after.certificates === before.certificates && after.customers === before.customers &&
    after.bills === before.bills && after.payments === before.payments &&
    after.cylinders === before.cylinders,
    `certs ${before.certificates}->${after.certificates}, customers ${before.customers}->${after.customers}, ` +
    `bills ${before.bills}->${after.bills}, payments ${before.payments}->${after.payments}, ` +
    `cylinders ${before.cylinders}->${after.cylinders}`);
  check('the certificate counter is back where it started',
    (certCounterAfter && certCounterAfter.seq) === (before.certCounter && before.certCounter.seq));
  check('nothing named VERIFY-F11 is left behind',
    (await Customer.countDocuments({ user_id: user._id, company_name: /VERIFY-F11/ })) === 0 &&
    (await PurityCertificate.countDocuments({ user_id: user._id, cylinder_serial_no: /VERIFY-/ })) === 0);

  console.log('\n' + (results.every(Boolean) ? `ALL ${results.length} CHECKS PASSED` : `${results.filter(x => !x).length} of ${results.length} FAILED`));
  await mongoose.disconnect();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
