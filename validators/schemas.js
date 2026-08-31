// ─── Phase 30: input-validation schemas (zod) ───
// Design constraints that keep this from breaking the LIVE frontend:
//   * The frontend spreads whole form objects ({...formData}) and sends numeric fields as STRINGS
//     from <input> values, which the services already Number()/parseFloat(). So numeric fields
//     accept number OR numeric-string (rejecting genuine junk like "abc"), and every schema uses
//     .passthrough() so extra spread keys are never rejected.
//   * Validation runs as a GATE ONLY (see middleware/validate.js) — it never overwrites req.body,
//     so services receive exactly what they did before. This adds rejection of malformed/oversized
//     input without any coercion or behavior change to valid payloads.
//   * Format fields (GSTIN, phone, challan_no, bill_number, rotational number) are validated for
//     length/charset only — never for prefix — so challan_no free-editability and bill_number
//     lifelong-editability are untouched.
const { z } = require('zod');

// A scalar that may arrive as a number or a numeric string (frontend <input> values). Rejects
// non-numeric text but preserves the current string-or-number behavior the services rely on.
const numericLike = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a number')
]);
const optNumericLike = z.union([numericLike, z.literal('')]).optional().nullable();

// Optional free-text string with a max length; accepts '', null, or undefined.
const optStr = (max) => z.string().max(max, `must be ${max} characters or fewer`).optional().nullable();
// Required non-empty string with a max length.
const reqStr = (max, label) => z.string().min(1, `${label} is required`).max(max, `${label} must be ${max} characters or fewer`);

// Phone: digits plus the usual separators (+, -, spaces, parens). Lenient — the data includes
// landline formats like "0265-2345678" and the "0" bulk-import artifact.
const phone = z.string().max(30).regex(/^[0-9+\-()\s]*$/, 'contains invalid characters').optional().nullable();
// GSTIN: length/charset only. NOTE (flagged): the strict 15-char GSTIN format is intentionally NOT
// enforced — existing customers include blanks, "URP", and legacy/non-conforming values, and the
// challan already falls back to "URP". Enforcing the strict format here would reject saved records.
const gstin = z.string().max(20).regex(/^[A-Za-z0-9]*$/, 'must be letters and digits only').optional().nullable();
// Email: light format check only, blank allowed — same leniency as `phone`/`gstin` above. The
// business email is letterhead text, not a login, so a legacy or unusual value must never be
// rejected on save; anything containing a single @ with text either side passes.
const email = z.string().max(200).regex(/^$|^[^@\s]+@[^@\s]+$/, 'must be a valid email address').optional().nullable();

// Customers — create requires a company name; everything else optional/lenient.
const customerCreate = z.object({
  company_name: reqStr(200, 'Company name'),
  customer_type: optStr(20),
  contact_person: optStr(200),
  phone_primary: z.string().max(30).regex(/^[0-9+\-()\s]*$/, 'contains invalid characters').optional().nullable(),
  phone_alternate: phone,
  address: optStr(1000),
  gst_number: gstin,
  security_deposit: optNumericLike,
  holding_limit: optNumericLike,
  opening_balance: optNumericLike,
  is_filling_vendor: z.boolean().optional(),
  is_active: z.union([z.boolean(), z.number(), z.string()]).optional(),
  additional_contacts: z.array(z.any()).max(50).optional().nullable()
}).passthrough();

// Update: same shape but company_name optional (partial edits allowed).
const customerUpdate = customerCreate.partial().passthrough();

// Cylinders — rotational number + gas + capacity are the required identity fields.
const cylinderCreate = z.object({
  rotational_number: reqStr(50, 'Rotational number'),
  gas_type: reqStr(50, 'Gas type'),
  capacity: reqStr(50, 'Capacity'),
  location: optStr(50),
  stock_state: optStr(30),
  under_maintenance: z.union([z.boolean(), z.number(), z.string()]).optional()
}).passthrough();
const cylinderUpdate = cylinderCreate.partial().passthrough();

// Payments — customer + a positive amount (the >0 rule stays in the service).
const paymentCreate = z.object({
  customer_id: reqStr(64, 'Customer'),
  amount_received: numericLike,
  discount: optNumericLike,
  payment_mode: optStr(30),
  cheque_number: optStr(60),
  upi_transaction_id: optStr(120),
  reference: optStr(120),
  remarks: optStr(1000),
  date: optStr(40)
}).passthrough();

// F-11 Purity Test Certificate — a bounded outer guard only. Every content field is free text
// that prints exactly as typed (see the model's comment on why purity/capacity/qty are strings),
// so there is nothing to coerce here: only the customer is required, and the rest is
// length-capped. The certificate NUMBER is deliberately absent — it is assigned server-side and a
// client-supplied one is ignored.
const purityCertificateCreate = z.object({
  customer_id: reqStr(64, 'Customer'),
  customer_name: optStr(200),
  customer_address: optStr(1000),
  date: optStr(40),
  gas_type: optStr(80),
  purity_percent: optStr(60),
  sub_line: optStr(300),
  declaration_text: optStr(2000),
  cylinder_owner: optStr(200),
  cylinder_water_capacity_ltrs: optStr(60),
  qty: optStr(60),
  filling_date: optStr(40),
  delivery_date: optStr(40),
  cylinder_serial_no: optStr(200),
  challan_ref: optStr(120),
  impurities: z.array(z.object({
    name: optStr(120),
    ppm_text: optStr(60)
  }).passthrough()).max(60, 'too many impurity rows').optional().nullable()
}).passthrough();

// Business profile — includes the Phase-30 logo data-URL guard (type prefix + length cap).
const businessProfile = z.object({
  business_name: optStr(200),
  business_address: optStr(1000),
  business_phone: phone,
  gst_number: gstin,
  // Phase GEN-A letterhead lines — free text, length-bounded only. They print exactly as typed.
  certification_line: optStr(300),
  business_email: email,
  products_line: optStr(300),
  contact_lines: z.array(z.string().max(300, 'a contact line must be 300 characters or fewer'))
    .max(20, 'too many contact lines').optional().nullable(),
  // F-11: the certificate series prefix, and the contact line printed under the business name in
  // a certificate's signature block. Both free text, length-bounded only.
  certificate_prefix: optStr(20),
  footer_contact_line: optStr(300),
  // The printed notes / terms block. Free text in any language (Gujarati, here) plus the flags
  // for which documents carry it. Bounded only by length: it prints exactly as typed.
  print_notes: z.object({
    heading: optStr(120),
    body: optStr(4000),
    footer: optStr(1000),
    show_on: z.object({
      challan: z.boolean().optional().nullable(),
      holding_statement: z.boolean().optional().nullable(),
      purity_certificate: z.boolean().optional().nullable(),
      reports: z.boolean().optional().nullable()
    }).optional().nullable()
  }).optional().nullable(),
  logo_scale: optNumericLike,
  // Phase GEN-C: whether the bill/receipt series restarts each 1 April. Whether the caller is
  // still ALLOWED to change it is a business rule, enforced in profile.service, not here.
  fy_reset_numbering: z.boolean().optional().nullable(),
  logo: z.string()
    .max(1_500_000, 'logo image is too large')
    .refine(v => v === '' || /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/.test(v),
      'logo must be an image data URL')
    .optional().nullable()
}).passthrough();

// Bills — thin outer guard only. Deep business validation (serials, states, totals, personal
// cylinders) stays in bill.service.js. Here we just bound the free-text identity fields WITHOUT
// touching editability: challan_no length only (no prefix rule), bill_number/vehicle length only.
// challan_no is length-only here (optional); the "challan required" rule stays in bill.service.js
// so this schema can never reject a payload the service would accept (customer bills AND transfers
// both flow through createBill). bill_number/vehicle length-only — free editability untouched.
const billCreate = z.object({
  challan_no: optStr(50),
  bill_number: optStr(50),
  vehicle_number: optStr(20)
}).passthrough();
// Edits may change only some fields; keep it fully partial.
const billUpdate = z.object({
  challan_no: z.string().max(50).optional().nullable(),
  bill_number: optStr(50),
  vehicle_number: optStr(20)
}).passthrough();

// Import endpoints: only guard that `rows` is a bounded array — per-row validation stays in the
// import services (which already skip/report bad rows).
const importRows = z.object({
  rows: z.array(z.any()).max(20000, 'too many rows in one import')
}).passthrough();

// Phase GEN-B2 — adding a location. The CODE is generated server-side from the label and is
// permanent (R83); only the label and the editable side-fields arrive from the client.
const locationCreate = z.object({
  // reqStr allows whitespace-only; the service trims and rejects too, but catching it here gives
  // a clean 400 instead of relying on the deeper check.
  label: reqStr(80, 'Location name').refine(v => v.trim().length > 0, 'Location name is required'),
  is_filling_location: z.boolean().optional(),
  manager_name: optStr(200),
  contact_number: optStr(300),
  challan_prefix: optStr(20)
}).passthrough();

module.exports = {
  locationCreate,
  customerCreate, customerUpdate,
  cylinderCreate, cylinderUpdate,
  paymentCreate,
  businessProfile,
  purityCertificateCreate,
  billCreate, billUpdate,
  importRows
};
