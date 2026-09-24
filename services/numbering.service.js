const crypto = require('crypto');

// ─── Phase GEN-C: per-account number isolation + financial-year series ───
//
// Two independent jobs live here, both pure (no database access) so they can be reasoned about
// and tested in isolation:
//
//   1. ACCOUNT CODE — an 8-character [A-Z0-9] code derived from the account's _id alone. It
//      scopes the uniqueness of bill and receipt numbers to one account, so two
//      CylinderPro clients can each issue "1A001" without colliding. It is DERIVED from the
//      immutable account _id, never from the email — the app has a working email-change flow
//      (routes/profile.js), and a code derived from a mutable field would orphan every record
//      the day a client changed their address.
//
//   2. FINANCIAL YEAR — the Indian FY runs 1 April → 31 March. Accounts may opt into restarting
//      their number series each 1 April; that choice locks permanently once the account has
//      lived through its first 1 April.
//
// NOTE ON DISPLAY: the account code never appears in the UI or on a printed document. Operators
// see and type exactly what they see today — "1A001", "RCP-0001". The code is a stored, indexed
// field that participates in the unique key; it is not concatenated into the number itself, so
// no historical value is ever rewritten and nothing has to be stripped on read (R103).

// 36 symbols: the alphabet the account code is drawn from.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_LEN = 8;

// Deterministic 8-character [A-Z0-9] code for one account, from its _id and nothing else.
//
// Until 24 Sep 2026 this was an HMAC keyed by a NUMBERING_SALT server secret. The secret bought
// nothing the code needed — it is not a credential, it is never shown, and it is stored rather than
// recomputed — but it was one more thing that had to survive a server rebuild. It is now a plain
// SHA-256 of the id. A hash rather than the raw ObjectId bytes, because the low bytes of an
// ObjectId are a per-process constant plus a counter: two accounts created by one server process
// would get codes differing only in their last few characters.
//
// Codes already stored (every account created before the change) came from the salted version and
// stay exactly as they are — this function is only ever called at signup, never on read, so
// re-deriving an old account's code would not match, and nothing ever does (R105).
//
// Reads the hash as a big integer and takes it modulo 36 eight times. Doing this over a 256-bit
// hash rather than one byte per character avoids the modulo bias that mapping each byte through
// % 36 would introduce (256 is not a multiple of 36, so low symbols would come up more often).
function deriveAccountCode(userId) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('deriveAccountCode: an account id is required');

  const digest = crypto.createHash('sha256').update(id).digest();
  let n = BigInt('0x' + digest.toString('hex'));
  const base = BigInt(ALPHABET.length);

  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out = ALPHABET[Number(n % base)] + out;
    n /= base;
  }
  return out;
}

// ─── Financial year (India: 1 April → 31 March), evaluated in IST ───
// The server runs UTC. A bill saved at 02:00 IST on 1 April is 20:30 UTC on 31 March — the
// previous financial year — so every boundary decision here shifts into IST first, exactly as
// bill.service.js already does for effective-time ordering.
const IST_OFFSET_MS = 330 * 60 * 1000;
const toIst = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS);

// A Date → "2026-27". April..December belong to the year that starts them; January..March
// belong to the year before.
function financialYear(date) {
  const p = toIst(date);
  if (isNaN(p.getTime())) throw new Error('financialYear: invalid date');
  const y = p.getUTCFullYear();
  const startYear = p.getUTCMonth() >= 3 ? y : y - 1;   // getUTCMonth: 3 === April
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}

// "2026-27" → { start, end } as real UTC instants: 1 Apr 00:00 IST inclusive, 1 Apr 00:00 IST
// of the following year exclusive.
function financialYearBounds(fy) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(fy || '').trim());
  if (!m) throw new Error(`financialYearBounds: "${fy}" is not a financial year`);
  const startYear = parseInt(m[1], 10);
  return {
    start: new Date(Date.UTC(startYear, 3, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(startYear + 1, 3, 1) - IST_OFFSET_MS)
  };
}

// The first 1 April (00:00 IST) STRICTLY AFTER the given moment — the instant at which an
// account's financial-year choice stops being editable. An account activated 31 Jul 2026 locks
// on 1 Apr 2027; one activated 2 Apr 2026 locks on 1 Apr 2027 as well.
//
// Deliberately measured from the account's own activation date, so a client who buys the
// software later gets their own full window rather than inheriting someone else's deadline.
function firstAprilAfter(activatedAt) {
  const p = toIst(activatedAt);
  if (isNaN(p.getTime())) throw new Error('firstAprilAfter: invalid date');
  const y = p.getUTCFullYear();
  const aprilThisYear = Date.UTC(y, 3, 1);
  const target = p.getTime() < aprilThisYear ? aprilThisYear : Date.UTC(y + 1, 3, 1);
  return new Date(target - IST_OFFSET_MS);
}

// Has this account's financial-year choice locked yet?
function isFyChoiceLocked(activatedAt, now = new Date()) {
  return new Date(now).getTime() >= firstAprilAfter(activatedAt).getTime();
}

// "2026-27" -> "2627". Keeps the identity short and still sorts chronologically.
function fyShort(fy) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(fy || '').trim());
  return m ? m[1].slice(2) + m[2] : '';
}

// The searchable business identity for one bill or receipt:
//
//     <account_code>-<FY4>-<number>        e.g.  K7M2X9Q4-2627-1A001
//                                                K7M2X9Q4-2728-1A001   (same number, next year)
//                                                K7M2X9Q4-2627-RCP-0001
//
// This is what makes a search years later unambiguous: the visible number repeats every
// financial year by design, so the number alone cannot identify a document.
//
// The number is appended VERBATIM and may itself contain hyphens ("BILL-0001", "GST-0042"),
// so anything parsing a uid must split on the FIRST TWO separators only and treat the whole
// remainder as the number.
//
// Returns '' unless all three parts are present — a half-built identity would be worse than
// none, because it could collide with another half-built one.
function buildUid(accountCode, fy, number) {
  const a = String(accountCode || '').trim();
  const f = fyShort(fy);
  const n = String(number || '').trim();
  if (!a || !f || !n) return '';
  return a + '-' + f + '-' + n;
}

// Split a uid back into its parts, or null if it is not one.
function parseUid(uid) {
  const m = /^([A-Z0-9]{8})-(\d{4})-(.+)$/.exec(String(uid || '').trim());
  if (!m) return null;
  const startYear = '20' + m[2].slice(0, 2);
  return {
    account_code: m[1],
    financial_year: startYear + '-' + m[2].slice(2),
    number: m[3]
  };
}

module.exports = {
  ALPHABET,
  CODE_LEN,
  deriveAccountCode,
  financialYear,
  financialYearBounds,
  firstAprilAfter,
  isFyChoiceLocked,
  fyShort,
  buildUid,
  parseUid
};
