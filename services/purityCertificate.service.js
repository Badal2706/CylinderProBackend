const PurityCertificate = require('../models/PurityCertificate');
const Customer = require('../models/Customer');
const BusinessProfile = require('../models/BusinessProfile');
const Counter = require('../models/Counter');
const HttpError = require('../utils/HttpError');
const accountNumbering = require('./accountNumbering.service');

// ─── F-11: issuing, listing and deleting Purity Test Certificates ───
//
// There is deliberately no update function in this file. Immutability is a property of the
// document (see models/PurityCertificate.js, which refuses the write itself); this service simply
// never has cause to attempt one.

// The certificate series draws from the same per-account, per-financial-year Counter mechanism
// that bill numbers use (GEN-C), under its own key — so it advances independently of bills and
// receipts and can never be nudged by them.
const COUNTER_KEY = 'purity_certificate_series';

// {certificate_prefix}/TC/{financial_year}/{seq}   ->   "GI/TC/2026-27/1"
//
// A blank prefix drops its whole segment rather than printing a bare leading slash, exactly the
// way the letterhead drops a blank field instead of printing an orphan label (GEN-A). The
// financial year is spelled out in full ("2026-27", not "2627") because unlike a bill_uid this
// string is read by a customer on a printed page.
function formatCertificateNumber(prefix, financialYear, seq) {
  const p = String(prefix == null ? '' : prefix).trim();
  return (p ? p + '/' : '') + 'TC/' + financialYear + '/' + seq;
}

// The next free number in this account's series, plus the sequence index behind it so the caller
// can advance the counter once the save has actually succeeded.
//
// Like peekNextBillNumber, this steps past anything already taken rather than trusting the
// counter alone — a certificate backdated into a gap must not be handed out twice.
async function nextCertificateNumber(userId, date) {
  const { accountCode, financialYear, counterFy } = await accountNumbering.getContext(userId, date);
  const profile = await BusinessProfile.findOne({ user_id: userId }).select('certificate_prefix').lean();
  const prefix = (profile && profile.certificate_prefix) || '';

  const counter = await Counter.findOne({ user_id: userId, key: COUNTER_KEY, financial_year: counterFy }).lean();
  let n = ((counter && counter.seq) || 0) + 1;

  for (let guard = 0; guard < 100000; guard++) {
    const candidate = formatCertificateNumber(prefix, financialYear, n);
    const taken = await PurityCertificate.exists({
      account_code: accountCode, financial_year: financialYear, certificate_number: candidate
    });
    if (!taken) return { number: candidate, seq: n, counterFy };
    n++;
  }
  return { number: formatCertificateNumber(prefix, financialYear, n), seq: n, counterFy };
}

async function advanceCounter(userId, counterFy, seq) {
  await Counter.updateOne(
    { user_id: userId, key: COUNTER_KEY, financial_year: counterFy },
    { $max: { seq } },
    { upsert: true }
  );
}

const str = (v) => String(v == null ? '' : v).trim();

// A date field that may legitimately be absent (delivery_date). An unparseable value becomes null
// rather than an Invalid Date, which would store as null anyway but fail validation noisily first.
function optDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Impurity rows arrive as the operator left them: added, removed, renamed, reordered. They are
// stored in exactly that order — the printed table is the certified content, so its layout is
// part of what is being certified. Rows blank in BOTH columns are dropped (an empty row is a UI
// artifact of the "+ Add row" button, not a statement about the gas); a row with a name and no
// figure, or a figure and no name, is kept as typed.
function cleanImpurities(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(r => ({ name: str(r && r.name), ppm_text: str(r && r.ppm_text) }))
    .filter(r => r.name || r.ppm_text);
}

async function createCertificate(userId, body) {
  const customerId = str(body && body.customer_id);
  if (!customerId) throw new HttpError(400, 'A customer is required');

  const date = optDate(body.date) || new Date();

  // The customer is read for ONE reason: to confirm it belongs to this account and still exists.
  // The name and address that go onto the certificate come from the request, because the operator
  // is allowed to correct them on the form before issuing — the customer record is the default,
  // not the authority. Whatever is saved here is frozen from this moment on.
  const customer = await Customer.findOne({ _id: customerId, user_id: userId })
    .select('_id company_name address').lean();
  if (!customer) throw new HttpError(404, 'Customer not found');

  const doc = {
    user_id: userId,
    customer_id: customer._id,
    customer_name: body.customer_name !== undefined ? str(body.customer_name) : (customer.company_name || ''),
    customer_address: body.customer_address !== undefined ? str(body.customer_address) : (customer.address || ''),
    date,
    gas_type: str(body.gas_type),
    purity_percent: str(body.purity_percent),
    sub_line: str(body.sub_line),
    declaration_text: str(body.declaration_text),
    cylinder_owner: str(body.cylinder_owner),
    cylinder_water_capacity_ltrs: str(body.cylinder_water_capacity_ltrs),
    qty: str(body.qty),
    filling_date: optDate(body.filling_date),
    delivery_date: optDate(body.delivery_date),
    cylinder_serial_no: str(body.cylinder_serial_no),
    challan_ref: str(body.challan_ref),
    impurities: cleanImpurities(body.impurities)
  };

  // The number is assigned here, never accepted from the client. Two operators issuing at the
  // same instant can still both reach for the same one, and the unique index is what actually
  // decides — so a duplicate-key rejection is retried with the next free number rather than
  // surfacing as an error to whoever lost the race.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { number, seq, counterFy } = await nextCertificateNumber(userId, date);
    try {
      const cert = new PurityCertificate({ ...doc, certificate_number: number });
      await cert.save();
      // Only after the save — an advanced counter with no document behind it would burn a number.
      try { await advanceCounter(userId, counterFy, seq); } catch { /* non-fatal, the scan recovers it */ }
      return { certificate_id: cert._id, certificate_number: cert.certificate_number,
               message: 'Purity test certificate issued' };
    } catch (e) {
      if (e && e.code === 11000 && attempt < 4) continue;
      throw e;
    }
  }
  throw new HttpError(409, 'Could not allocate a certificate number — please try again');
}

// Newest first. Certificates are few per customer, so this returns them all rather than paging:
// the Customer Detail section shows a short list with the app's standard "View All" expansion,
// which needs the full set in hand to search across.
async function listCertificates(userId, { customer_id } = {}) {
  const query = { user_id: userId };
  if (customer_id) query.customer_id = customer_id;
  return PurityCertificate.find(query).sort({ date: -1, createdAt: -1 }).limit(2000).lean();
}

async function getCertificate(userId, id) {
  const cert = await PurityCertificate.findOne({ _id: id, user_id: userId }).lean();
  if (!cert) throw new HttpError(404, 'Certificate not found');
  return cert;
}

// Deleting a certificate removes the certificate and nothing else. No cylinder, bill, payment,
// customer or history record references one, so there is no cascade to run and none to suppress.
// The number it consumed is NOT returned to the series: the counter is monotonic by design, and a
// reissued number would mean two different documents had once carried the same identity.
async function deleteCertificate(userId, id) {
  const cert = await PurityCertificate.findOne({ _id: id, user_id: userId }).select('certificate_number').lean();
  if (!cert) throw new HttpError(404, 'Certificate not found');
  await PurityCertificate.deleteOne({ _id: id, user_id: userId });
  return { message: `Certificate ${cert.certificate_number} deleted` };
}

module.exports = {
  COUNTER_KEY,
  formatCertificateNumber,
  nextCertificateNumber,
  createCertificate,
  listCertificates,
  getCertificate,
  deleteCertificate
};
