const mongoose = require('mongoose');

// ─── F-11: Purity Test Certificate ───
//
// A standalone document issued to one customer for one filling. It is NOT a bill, a payment or a
// cylinder record: nothing in stock, ledger or history depends on it, and deleting one changes
// nothing else in the system.
//
// TWO PROPERTIES DEFINE THIS MODEL, and both are enforced here rather than trusted to the UI:
//
//   1. IMMUTABLE ONCE SAVED. A certificate is a signed statement about a specific cylinder on a
//      specific day. Editing one after it has been handed over would silently rewrite what the
//      business certified. Corrections work the way they work everywhere else in this app — issue
//      a new record, delete the wrong one — so the only writes this schema permits are the first
//      insert and a delete. See the guards below: they refuse the write, they do not merely omit
//      a button.
//
//   2. THE CUSTOMER IS SNAPSHOTTED, NOT JOINED. customer_name and customer_address are copied at
//      creation. customer_id is kept only so the certificate can be listed under its customer —
//      it is never read back for display. An address edited next month must not change a
//      certificate issued today, and a live populate() would do exactly that.

// Every field that forms the CONTENT of the issued document. Changing any of these after the
// insert is what immutability forbids. Deliberately excludes the mongoose bookkeeping fields
// (_id, timestamps, __v) and the derived numbering identity, which are written by this schema's
// own hooks during the initial validate.
const CONTENT_FIELDS = [
  'certificate_number', 'customer_id', 'customer_name', 'customer_address', 'date',
  'gas_type', 'purity_percent', 'sub_line', 'declaration_text', 'cylinder_owner',
  'cylinder_water_capacity_ltrs', 'qty', 'filling_date', 'delivery_date',
  'cylinder_serial_no', 'challan_ref', 'impurities'
];

// One impurity row on the printed table. `ppm_text` is free text, not a number, because a real
// certificate says "< 5" or "Nil" or "10 max" as often as it says a bare figure — and whatever
// was approved has to print back exactly as approved.
const impuritySchema = new mongoose.Schema({
  name: { type: String, default: '' },
  ppm_text: { type: String, default: '' }
}, { _id: false });

const purityCertificateSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // Format: {certificate_prefix}/TC/{financial_year}/{seq}, e.g. "GI/TC/2026-27/1". The prefix
  // segment is omitted entirely when BusinessProfile.certificate_prefix is blank ("TC/2026-27/1")
  // rather than printing a leading slash. Assigned server-side and never accepted from a client.
  certificate_number: { type: String, required: true },

  // ─── Phase GEN-C numbering identity (mirrors Bill and Payment) ───
  // Uniqueness is scoped to (account_code, financial_year), so two CylinderPro clients can each
  // issue "TC/2026-27/1" and an account that restarts its series on 1 April may reuse a number in
  // the following year.
  account_code: { type: String, default: '', index: true },
  financial_year: { type: String, default: '', index: true },
  certificate_uid: { type: String, default: '', index: true },

  // Kept for listing the certificate under its customer. NEVER populated for display — see the
  // snapshot rule above.
  customer_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  customer_name: { type: String, default: '' },
  customer_address: { type: String, default: '' },

  date: { type: Date, required: true },

  // ─── The certified content ───
  // purity_percent, cylinder_water_capacity_ltrs and qty are STRINGS on purpose. Nothing in the
  // system ever computes with them; they exist to be printed. Storing them verbatim is what lets
  // "99.5 % V/V", "≥ 99.995", "46.7 Ltrs" and "10 Nos." each print back exactly as the operator
  // approved them, and guarantees a re-print years later is byte-identical to the original.
  gas_type: { type: String, default: '' },
  purity_percent: { type: String, default: '' },
  sub_line: { type: String, default: '' },
  declaration_text: { type: String, default: '' },
  cylinder_owner: { type: String, default: '' },
  cylinder_water_capacity_ltrs: { type: String, default: '' },
  qty: { type: String, default: '' },
  filling_date: { type: Date, default: null },
  delivery_date: { type: Date, default: null },
  cylinder_serial_no: { type: String, default: '' },
  challan_ref: { type: String, default: '' },
  impurities: { type: [impuritySchema], default: [] }
}, {
  timestamps: true
});

// GEN-C: fill the derived numbering fields from the account and the document's own date. Runs on
// the initial insert only — on an existing document these values are as immutable as the rest.
purityCertificateSchema.pre('validate', async function () {
  if (!this.isNew) return;
  const { financialYear, buildUid } = require('../services/numbering.service');
  if (!this.account_code && this.user_id) {
    try {
      this.account_code = await require('../services/accountNumbering.service').accountCodeFor(this.user_id);
    } catch { /* leave blank — buildUid returns '' rather than a half-built identity */ }
  }
  if (this.date) {
    try { this.financial_year = financialYear(this.date); } catch { /* leave as-is */ }
  }
  this.certificate_uid = buildUid(this.account_code, this.financial_year, this.certificate_number);
});

// ─── Immutability, enforced at the only two places a write can arrive ───
//
// Document path: a re-save of a loaded certificate.
purityCertificateSchema.pre('save', function () {
  if (this.isNew) return;
  const touched = CONTENT_FIELDS.filter(f => this.isModified(f));
  if (touched.length) {
    throw new Error(
      'A purity certificate cannot be edited once issued (attempted to change: ' +
      touched.join(', ') + '). Delete it and issue a new one instead.'
    );
  }
});

// Query path: findOneAndUpdate / updateOne / updateMany bypass document middleware entirely
// (R111), so the same rule has to be stated again here. This one refuses outright rather than
// inspecting the payload — there is no legitimate update to a certificate, so there is nothing
// to allow through. deleteOne / findOneAndDelete are untouched: deleting IS the supported
// correction, and it is the whole reason this guard can be absolute.
function refuseUpdate() {
  throw new Error(
    'A purity certificate is immutable once issued — it can only be viewed or deleted. ' +
    'Issue a new certificate to correct one.'
  );
}
purityCertificateSchema.pre('findOneAndUpdate', refuseUpdate);
purityCertificateSchema.pre('updateOne', refuseUpdate);
purityCertificateSchema.pre('updateMany', refuseUpdate);
purityCertificateSchema.pre('findOneAndReplace', refuseUpdate);
purityCertificateSchema.pre('replaceOne', refuseUpdate);

// GEN-C: unique within (account, financial year) — the same scoping as bill_number and
// receipt_number. Note that this lives in its OWN collection, so a certificate number can never
// collide with a bill or receipt number no matter what either series reaches.
purityCertificateSchema.index({ account_code: 1, financial_year: 1, certificate_number: 1 }, { unique: true });
purityCertificateSchema.index({ user_id: 1, customer_id: 1, date: -1 });  // the per-customer list
purityCertificateSchema.index({ user_id: 1, createdAt: -1 });             // recent-first listings

purityCertificateSchema.set('toJSON', { virtuals: true });
purityCertificateSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('PurityCertificate', purityCertificateSchema);
module.exports.CONTENT_FIELDS = CONTENT_FIELDS;
