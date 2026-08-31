const mongoose = require('mongoose');

// One business profile per user — shown on bill headers / printed PDFs.
const businessProfileSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  // Phase GEN-A: no business-identity default may live in code — a blank default is what keeps
  // one client's name from appearing on another client's letterhead. Seeded per user by
  // scripts/migrateGenA_branding.js instead.
  business_name: { type: String, default: '' },
  business_address: { type: String, default: '' },
  business_phone: { type: String, default: '' },
  gst_number: { type: String, default: '' },
  // Phase GEN-A: letterhead lines previously hardcoded in the print template. Each prints
  // EXACTLY as typed (case and line breaks preserved) and is omitted entirely when blank.
  certification_line: { type: String, default: '' },
  business_email: { type: String, default: '' },
  products_line: { type: String, default: '' },
  // Contact box on the letterhead: one entry per block of text, printed in order, each verbatim
  // (a newline typed in the field is a newline on the page). Deliberately NOT read from
  // LocationProfile.contact_number — the number a site is administered by and the number printed
  // on a challan are allowed to differ. An ordered array rather than three named fields so a
  // fourth site (F-02) needs no schema change.
  contact_lines: { type: [String], default: [] },
  // ─── F-11: Purity Test Certificate ───
  // The series prefix, e.g. "GI" -> "GI/TC/2026-27/1". Blank by default and blank is a valid
  // setting: the segment is dropped entirely rather than printing a leading slash ("TC/2026-27/1").
  // Blank, not a sensible-looking guess, for the same reason as every other GEN-A identity field —
  // a default here would print one client's initials on another client's certificate.
  certificate_prefix: { type: String, default: '' },
  // The contact line printed beneath the business name in a certificate's signature block
  // ("For / GURU Industries / <this line>"). Separate from contact_lines, which is the letterhead
  // contact BOX at the top of the page — a certificate signs off with one line, not three.
  footer_contact_line: { type: String, default: '' },
  // ─── Printed notes / terms block (the "નોંધ:" section at the foot of a challan) ───
  // Free text, in whatever language and wording the business uses. Held as plain multi-line
  // strings rather than a structured list because these are terms a proprietor edits by hand,
  // not data anything computes with: one note per line, printed verbatim, blank lines dropped.
  //
  // BLANK BY DEFAULT, like every other GEN-A identity field. A default here would print one
  // client's trading terms on another client's challan, which is worse than printing nothing.
  // When heading, body and footer are all empty the whole block is omitted — no stray heading.
  print_notes: {
    // e.g. "નોંધ:" — printed above the body, omitted when blank.
    heading: { type: String, default: '' },
    // One note per line. Rendered as-is; a leading "*" is the user's, not ours to add.
    body: { type: String, default: '' },
    // Printed under the notes in bold — the English jurisdiction/inspection lines on Guru's
    // challan live here. Separate from `body` so it can keep its own emphasis.
    footer: { type: String, default: '' },
    // Which printed documents carry the block. Off everywhere except the challan by default:
    // terms belong on a delivery document, not on a status statement or a lab certificate,
    // and silently adding them to all four would change documents nobody asked to change.
    show_on: {
      challan:            { type: Boolean, default: true },
      holding_statement:  { type: Boolean, default: false },
      purity_certificate: { type: Boolean, default: false },
      reports:            { type: Boolean, default: false }
    }
  },
  // Printed logo size as a percentage of its normal size. 100 = today's appearance. The logo
  // scales on its own; letterhead text size is unaffected.
  logo_scale: { type: Number, default: 100 },
  // Optional logo stored as a data URL (data:image/png;base64,...). Kept small.
  logo: { type: String, default: '' },
  // ─── Phase GEN-C: financial-year numbering reset ───
  // true  = bill and receipt series restart at 1A001 / RCP-0001 every 1 April.
  // false = one continuous series for the life of the account (the default, and the
  //         pre-GEN-C behaviour).
  // LOCKS PERMANENTLY once the account has lived through its first 1 April, measured from the
  // account's own activation date — see numbering.service.isFyChoiceLocked. Locking is enforced
  // in profile.service, not here, so the migration can still write it.
  fy_reset_numbering: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('BusinessProfile', businessProfileSchema);
