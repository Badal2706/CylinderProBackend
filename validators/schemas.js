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

// Business profile — includes the Phase-30 logo data-URL guard (type prefix + length cap).
const businessProfile = z.object({
  business_name: optStr(200),
  business_address: optStr(1000),
  business_phone: phone,
  gst_number: gstin,
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

module.exports = {
  customerCreate, customerUpdate,
  cylinderCreate, cylinderUpdate,
  paymentCreate,
  businessProfile,
  billCreate, billUpdate,
  importRows
};
