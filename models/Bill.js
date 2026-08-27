const mongoose = require('mongoose');

const billLineItemSchema = new mongoose.Schema({
  direction: {
    type: String,
    // TRANSFER lines belong to INTERNAL_TRANSFER bills only — they are deliberately NOT
    // 'GIVEN', so holder-detection (findCurrentGiven) and dashboard out-counts ignore them.
    enum: ['GIVEN', 'RECEIVED', 'TRANSFER'],
    required: true
  },
  gas_type_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GasType',
    required: true
  },
  cylinder_size_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CylinderSize',
    required: true
  },
  // Snapshot values captured at transaction time (Phase 9). Display always prefers these, so
  // historical bills / DSR entries never change when a cylinder's or master's current
  // type/size is edited or removed later. Backfilled on old bills by scripts/migratePhase9.js.
  gas_type_name: { type: String, default: '' },
  size_label:    { type: String, default: '' },
  // Free-text per-row note shown on the DSR (Phase 10) — additive next to the PC columns,
  // written quietly via PATCH /bills/:id/dsr-remark (no edit_history, no 3-day lock).
  remarks: { type: String, default: '' },
  serial_number: {
    type: String,
    default: ''   // blank for personal-cylinder-only lines (quantity-only, no inventory cylinder)
  },
  quantity: {
    type: Number,
    default: 1
  },
  rate: {
    type: Number,
    default: 0
  },
  amount: {
    type: Number,
    default: 0
  },
  // ─── Phase 35: effective time for state ordering ───
  // When a cylinder is ADDED to a bill during a LATER edit, its physical movement happened at the
  // edit moment, not at the bill's original date. This stamps that moment so the state replay orders
  // the added line by when it was actually added (not the bill's creation time), keeping a later
  // transfer authoritative over receives that were entered before the edit. Absent on original lines
  // (they fall back to bill_date), so historical data and same-session creation are unchanged.
  added_at: { type: Date, default: null },
  // ─── Personal cylinders (quantity-only; customer's own cylinders, NOT our inventory) ───
  // Recorded per gas-type line. They never touch Cylinder inventory status.
  personalCylindersIn:  { type: Number, default: 0 }, // received from customer (→ we hold more)
  personalCylindersOut: { type: Number, default: 0 }, // given back to customer (→ we hold fewer)
  // ─── Cross-customer return annotations (all optional; absent on normal line items) ───
  // Set on Customer B's RECEIVED line when B returns a cylinder actually held by Customer A.
  // Value = Customer A (the original holder it was returned on behalf of).
  returned_on_behalf_of:      { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  returned_on_behalf_of_name: { type: String, default: null },
  // Set on Customer A's original GIVEN line once that cylinder is returned via Customer B.
  // returned_via = Customer B who physically returned it; returned_date = when.
  returned_via:      { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
  returned_via_name: { type: String, default: null },
  returned_date:     { type: Date, default: null }
});

const billSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // Lifelong editable — it is matched against the customer's other software, so it must stay
   // changeable. Uniqueness is NOT global any more (GEN-C): it is scoped to
   // (account_code, financial_year), so 1A001 may legitimately return next financial year.
  bill_number: {
    type: String,
    required: true
  },
  // ─── Phase GEN-C: numbering identity ───
  // account_code denormalised from User so a stray document is always traceable to its account,
  // and so the unique index can be enforced without a join.
  account_code: { type: String, default: '', index: true },
  // "2026-27". Derived from bill_date in IST (1 Apr → 31 Mar). Recomputed whenever bill_date
  // changes, which is why a date edit can move a bill into a year where its number is taken.
  financial_year: { type: String, default: '', index: true },
  // The searchable business identity: "<account_code>-<FY4>-<bill_number>", e.g.
  // "K7M2X9Q4-2627-1A001". Derived and kept in sync by the pre-validate hook below — never set
  // by hand. Distinguishes 1A001 of 2026-27 from 1A001 of 2027-28 years after the fact.
  bill_uid: { type: String, default: '', index: true },
  // CUSTOMER = normal bill against a customer; INTERNAL_TRANSFER = moving our own
  // cylinders between sites (no customer, no amounts).
  transaction_category: {
    type: String,
    enum: ['CUSTOMER', 'INTERNAL_TRANSFER'],
    default: 'CUSTOMER'
  },
  // Save-for-later draft (Phase 5): keeps the real bill-number sequence but stores the raw
  // form state in draft_payload; customer/challan/lines may be incomplete until finalized.
  is_draft: {
    type: Boolean,
    default: false,
    index: true
  },
  draft_payload: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  // When a save-for-later draft was actually committed. A draft is written up front but completed
  // later — often after other entries have already been made — and that completion is the moment it
  // takes effect, so the cylinder replay orders it there rather than at its (earlier) bill_date.
  // Null for bills saved outright. Only honoured on the same IST day, so a deliberately backdated
  // draft still keeps its chosen date (see lineEffTime).
  finalized_at: {
    type: Date,
    default: null
  },
  customer_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    // Required for finalized CUSTOMER bills; optional for INTERNAL_TRANSFER and drafts.
    required: function () { return !this.is_draft && this.transaction_category !== 'INTERNAL_TRANSFER'; }
  },
  // CUSTOMER bills: the site the transaction happened at (drafts are scoped by this too).
  // Phase GEN-B1: no enum — locations are per-user and live in LocationProfile. Validity is
  // checked in the service layer via location.service.isValidLocation(); a schema enum here
  // would reject any location a user adds later.
  location: {
    type: String,
    required: function () { return this.transaction_category !== 'INTERNAL_TRANSFER'; }
  },
  // INTERNAL_TRANSFER bills: source and destination sites (must differ — enforced in the service).
  from_location: {
    type: String,
    required: function () { return this.transaction_category === 'INTERNAL_TRANSFER'; }
  },
  to_location: {
    type: String,
    required: function () { return this.transaction_category === 'INTERNAL_TRANSFER'; }
  },
  bill_date: {
    type: Date,
    required: true
  },
  transaction_type: {
    type: String,
    enum: ['GIVEN', 'RECEIVED', 'SWAP', 'TRANSFER'],
    required: true
  },
  // Challan (delivery-note) number — required on real bills; drafts may not have one yet.
  challan_no: {
    type: String,
    required: function () { return !this.is_draft; },
    trim: true,
    default: ''
  },
  // Phase 27: delivery vehicle number. Strictly optional — never blocks a save, blank if unused.
  vehicle_number: {
    type: String,
    trim: true,
    default: ''
  },
  total_given_qty: {
    type: Number,
    default: 0
  },
  total_received_qty: {
    type: Number,
    default: 0
  },
  total_bill_amount: {
    type: Number,
    default: 0
  },
  remarks: String,
  line_items: [billLineItemSchema],
  // Audit trail for edits made via the Transaction History popup (item 11).
  // Same-session corrections (edited right after creation) do NOT add entries here.
  edit_history: {
    type: [{
      edited_at: { type: Date, default: Date.now },
      edited_by: { type: String, default: '' },
      changes:   { type: [String], default: [] },
      // Step-up authorization metadata (Phase 18) — WHO approved this edit and how.
      // Additive alongside the change log; blank on pre-Phase-18 entries.
      authorized_by:  { type: String, default: '' },  // Trusted Person's name
      authorized_via: { type: String, default: '' }   // 'OTP' | 'TOTP'
    }],
    default: []
  },
  // Every verified step-up action on this bill (Phase 18): edits (incl. same-session
  // corrections that don't reach edit_history) and over-limit override at creation.
  authorizations: {
    type: [{
      action:      { type: String, default: '' },  // 'EDIT' | 'OVER_LIMIT_OVERRIDE'
      via:         { type: String, default: '' },  // 'OTP' | 'TOTP'
      person_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'TrustedPerson', default: null },
      person_name: { type: String, default: '' },
      at:          { type: Date, default: Date.now }
    }],
    default: []
  },
  // Quiet traceability for bill-number renames (Phase 8) — deliberately separate from
  // edit_history so changing only the bill number never shows the "Updated" indicator.
  bill_number_history: {
    type: [{
      old_value:  { type: String, default: '' },
      new_value:  { type: String, default: '' },
      changed_at: { type: Date, default: Date.now }
    }],
    default: []
  }
}, {
  timestamps: true
});

// GEN-C: keep the derived numbering fields in step with bill_date and bill_number. Runs on
// every save, including bill-number and bill-date edits.
billSchema.pre('validate', async function () {
  const { financialYear, buildUid } = require('../services/numbering.service');
  // Filled here rather than at each creation site, so a new one cannot forget it. Immutable
  // once set, and the lookup behind this is cached for the life of the process.
  if (!this.account_code && this.user_id) {
    try {
      this.account_code = await require('../services/accountNumbering.service').accountCodeFor(this.user_id);
    } catch { /* leave blank — the migration backfills, and buildUid returns '' meanwhile */ }
  }
  if (this.bill_date) {
    try { this.financial_year = financialYear(this.bill_date); } catch { /* leave as-is */ }
  }
  this.bill_uid = buildUid(this.account_code, this.financial_year, this.bill_number);
});


// GEN-C: findOneAndUpdate / updateOne / updateMany bypass DOCUMENT middleware entirely, so a
// direct write touching bill_date or bill_number would leave financial_year and the uid
// STALE — silently scoping the uniqueness check to the wrong year and making the record
// unfindable by its identity. payment.service.updatePayment does exactly this kind of write.
// Recompute here so there is one rule regardless of how the write arrives.
// NOTE: async hooks must NOT declare a `next` parameter — Mongoose awaits the returned promise
// and passes no callback, so calling next() throws "next is not a function". Errors propagate by
// being thrown.
async function syncNumberingOnQuery() {
  const update = this.getUpdate() || {};
  const $set = update.$set || {};

  // A field can arrive EITHER at the top level ({ bill_date: x }) or inside $set. Both forms
  // reach this hook, and `timestamps: true` guarantees $set already exists (Mongoose puts
  // updatedAt there before middleware runs) — so `update.$set || update` would silently read the
  // timestamp object, find no bill_date, and skip the sync entirely.
  const read = (f) => ($set[f] !== undefined ? $set[f] : update[f]);

  const nextDate = read('bill_date');
  const nextNumber = read('bill_number');
  if (nextDate === undefined && nextNumber === undefined) return;

  // Whatever is NOT being written still has to come from the stored document.
  const current = await this.model
    .findOne(this.getQuery())
    .select('account_code bill_date bill_number')
    .lean();
  if (!current) return;

  const { financialYear, buildUid } = require('../services/numbering.service');
  const date = nextDate !== undefined ? nextDate : current.bill_date;
  const number = nextNumber !== undefined ? nextNumber : current.bill_number;
  const fy = financialYear(date);

  // Written into $set specifically: a plain top-level assignment would be dropped if the caller
  // used operator form.
  update.$set = Object.assign({}, $set, {
    financial_year: fy,
    bill_uid: buildUid(current.account_code, fy, number)
  });
  this.setUpdate(update);
}
billSchema.pre('findOneAndUpdate', syncNumberingOnQuery);
billSchema.pre('updateOne', syncNumberingOnQuery);
billSchema.pre('updateMany', syncNumberingOnQuery);
// Indexes for common queries.
// GEN-C: bill numbers are unique per (account, financial year) — NOT globally as before.
// This is what lets a second CylinderPro client issue their own 1A001, and what lets an account
// that opted into financial-year reset legitimately reuse 1A001 next April.
billSchema.index({ account_code: 1, financial_year: 1, bill_number: 1 }, { unique: true });
billSchema.index({ user_id: 1, customer_id: 1 });   // per-customer history
billSchema.index({ user_id: 1, bill_date: -1 });     // daily report / date filters
billSchema.index({ user_id: 1, createdAt: -1 });     // recent-first listings
billSchema.index({ user_id: 1, is_draft: 1, updatedAt: -1 });  // draft listings
billSchema.index({ user_id: 1, is_draft: 1, bill_date: -1 });  // non-draft date queries
billSchema.index({ bill_number: 1 });                           // bill number sequence lookup
billSchema.index({ 'line_items.serial_number': 1, 'line_items.direction': 1 }); // cylinder holder lookups

billSchema.virtual('bill_id').get(function() {
  return this._id.toString();
});

billSchema.set('toJSON', { virtuals: true });
billSchema.set('toObject', { virtuals: true });

// Auto-update cylinder location/stock_state based on the bill.
// A line item's serial_number is the cylinder's rotational number.
//
// CUSTOMER bills (at doc.location):
//   RECEIVED -> stock_state IN_STOCK, location = the bill's site
//   GIVEN    -> stock_state AT_CUSTOMER, location = the site it was given out from
// RECEIVED is applied BEFORE GIVEN so that a swap round-trip (same rotational
// number received then given again in one bill) nets out to AT_CUSTOMER.
//
// INTERNAL_TRANSFER bills: every serial moves from_location -> to_location;
// stock_state is NOT touched.
//
// Uses the (doc, next) signature so save() BLOCKS until the cylinder update completes,
// keeping updates ordered when several bills are saved back-to-back.
billSchema.post('save', function(doc, next) {
  (async () => {
    const Cylinder = require('./Cylinder');

    // Drafts never touch cylinder state — the hook runs only when the bill is finalized.
    if (doc.is_draft) return;

    if (doc.transaction_category === 'INTERNAL_TRANSFER') {
      const serials = doc.line_items.map(item => item.serial_number).filter(Boolean);
      if (serials.length && doc.to_location) {
        await Cylinder.updateMany(
          { user_id: doc.user_id, rotational_number: { $in: serials } },
          { location: doc.to_location }
        );
      }
      return;
    }

    const receivedSerials = doc.line_items
      .filter(item => item.direction === 'RECEIVED')
      .map(item => item.serial_number);
    // Exclude GIVEN lines already marked returned — those cylinders are back in stock,
    // so re-saving the bill must not flip them to AT_CUSTOMER again.
    const givenSerials = doc.line_items
      .filter(item => item.direction === 'GIVEN' && !item.returned_via)
      .map(item => item.serial_number);

    // A serial on BOTH sides of one bill is a round trip whose final state depends on the
    // travel direction. Inbound (customer swap: was AT_CUSTOMER → received → re-given) must
    // end AT_CUSTOMER — the received-then-given update order below handles that. Outbound
    // (filling vendor, Phase 14: was IN_STOCK → sent for filling → received back filled)
    // must end IN_STOCK — exclude it from the GIVEN flip. Pre-bill state read BEFORE any update.
    const receivedSet = new Set(receivedSerials);
    const dual = givenSerials.filter(s => receivedSet.has(s));
    const outbound = new Set();
    if (dual.length) {
      const pre = await Cylinder.find(
        { user_id: doc.user_id, rotational_number: { $in: dual } },
        { rotational_number: 1, stock_state: 1 }
      );
      pre.forEach(c => { if (c.stock_state === 'IN_STOCK') outbound.add(c.rotational_number); });
    }
    const givenFinal = givenSerials.filter(s => !outbound.has(s));

    if (receivedSerials.length) {
      await Cylinder.updateMany(
        { user_id: doc.user_id, rotational_number: { $in: receivedSerials } },
        doc.location ? { stock_state: 'IN_STOCK', location: doc.location } : { stock_state: 'IN_STOCK' }
      );
    }
    if (givenFinal.length) {
      await Cylinder.updateMany(
        { user_id: doc.user_id, rotational_number: { $in: givenFinal } },
        doc.location ? { stock_state: 'AT_CUSTOMER', location: doc.location } : { stock_state: 'AT_CUSTOMER' }
      );
    }
  })()
    .then(() => next())
    .catch(err => {
      // Don't fail the bill save if cylinder sync has an issue; just log it and continue.
      console.error('Cylinder status sync failed:', err.message);
      next();
    });
});

module.exports = mongoose.model('Bill', billSchema);
