// Phase GEN-C: the pure numbering helpers — account-code derivation and financial-year maths.
// No database: everything here is deterministic and side-effect free.

const mongoose = require('mongoose');
const N = require('../services/numbering.service');

describe('GEN-C account code', () => {
  const A = '6a6c5c5aa23b6b1b12125624';   // the live account's id shape
  const B = '6a6c5c5aa23b6b1b12125625';   // differs in the final character only

  test('is 8 characters drawn from A-Z0-9', () => {
    expect(N.deriveAccountCode(A)).toMatch(/^[A-Z0-9]{8}$/);
    expect(N.deriveAccountCode(A)).toHaveLength(8);
  });

  test('is deterministic — the same account always derives the same code', () => {
    expect(N.deriveAccountCode(A)).toBe(N.deriveAccountCode(A));
    // An ObjectId and its string form must not disagree, or a code would depend on call site.
    expect(N.deriveAccountCode(new mongoose.Types.ObjectId(A))).toBe(N.deriveAccountCode(A));
  });

  test('two accounts differing by one character get unrelated codes', () => {
    const a = N.deriveAccountCode(A);
    const b = N.deriveAccountCode(B);
    expect(a).not.toBe(b);
    // Avalanche: a one-character input change should not leave most of the output intact.
    const shared = [...a].filter((ch, i) => ch === b[i]).length;
    expect(shared).toBeLessThan(4);
  });

  // Since 24 Sep 2026 the code is a plain SHA-256 of the id: no server secret. These pin that.
  test('needs no secret — NUMBERING_SALT has no effect, set or unset', () => {
    const original = process.env.NUMBERING_SALT;
    try {
      delete process.env.NUMBERING_SALT;
      const unset = N.deriveAccountCode(A);
      process.env.NUMBERING_SALT = 'anything-at-all';
      expect(N.deriveAccountCode(A)).toBe(unset);
    } finally {
      if (original === undefined) delete process.env.NUMBERING_SALT; else process.env.NUMBERING_SALT = original;
    }
  });

  test('the derivation is pinned — a change to it must be deliberate', () => {
    // Existing accounts keep the code stored at their signup, so changing this would not break
    // them — but every account created afterwards would draw from a different scheme.
    expect(N.deriveAccountCode(A)).toBe('151MBMSK');
  });

  test('ids minted back-to-back by one process do not get near-identical codes', () => {
    // The low bytes of an ObjectId are a per-process constant plus a counter, so encoding the raw
    // id would give neighbouring accounts codes differing in their last characters. Hashing first
    // is why they come out unrelated.
    const codes = Array.from({ length: 50 }, () => N.deriveAccountCode(new mongoose.Types.ObjectId()));
    expect(new Set(codes).size).toBe(50);
    for (let i = 1; i < codes.length; i++) {
      const shared = [...codes[i]].filter((ch, k) => ch === codes[i - 1][k]).length;
      expect(shared).toBeLessThan(4);
    }
  });

  test('rejects an empty account id', () => {
    expect(() => N.deriveAccountCode('')).toThrow(/account id/i);
    expect(() => N.deriveAccountCode(null)).toThrow(/account id/i);
  });

  test('the symbol distribution is not visibly biased', () => {
    // 4000 accounts × 8 characters = 32000 symbols over a 36-symbol alphabet: ~889 each.
    // A per-byte % 36 mapping would skew the first 4 symbols upward by ~13%; this catches that.
    const counts = {};
    for (let i = 0; i < 4000; i++) {
      for (const ch of N.deriveAccountCode(new mongoose.Types.ObjectId())) {
        counts[ch] = (counts[ch] || 0) + 1;
      }
    }
    const seen = Object.values(counts);
    expect(Object.keys(counts).length).toBe(36);          // every symbol reachable
    expect(Math.max(...seen) / Math.min(...seen)).toBeLessThan(1.35);
  });
});

describe('GEN-C financial year', () => {
  test('April starts a new year, March ends the previous one', () => {
    expect(N.financialYear('2026-04-01T00:00:00+05:30')).toBe('2026-27');
    expect(N.financialYear('2027-03-31T23:59:59+05:30')).toBe('2026-27');
    expect(N.financialYear('2026-03-31T23:59:59+05:30')).toBe('2025-26');
    expect(N.financialYear('2026-12-31T12:00:00+05:30')).toBe('2026-27');
    expect(N.financialYear('2027-01-01T00:00:00+05:30')).toBe('2026-27');
  });

  test('the boundary is IST, not UTC — this is the bug that would corrupt a year-end bill', () => {
    // 02:00 IST on 1 April is 20:30 UTC on 31 March. Judged in UTC this lands in the OLD year.
    expect(N.financialYear('2026-04-01T02:00:00+05:30')).toBe('2026-27');
    expect(new Date('2026-04-01T02:00:00+05:30').toISOString()).toBe('2026-03-31T20:30:00.000Z');

    // And the reverse: 23:30 IST on 31 March is already 1 April in UTC.
    expect(N.financialYear('2026-03-31T23:30:00+05:30')).toBe('2025-26');
    expect(new Date('2026-03-31T23:30:00+05:30').toISOString()).toBe('2026-03-31T18:00:00.000Z');
  });

  test('bounds are half-open and round-trip with financialYear', () => {
    const { start, end } = N.financialYearBounds('2026-27');
    expect(start.toISOString()).toBe('2026-03-31T18:30:00.000Z');   // 1 Apr 00:00 IST
    expect(end.toISOString()).toBe('2027-03-31T18:30:00.000Z');
    expect(N.financialYear(start)).toBe('2026-27');                  // start is INSIDE
    expect(N.financialYear(new Date(end.getTime() - 1))).toBe('2026-27');
    expect(N.financialYear(end)).toBe('2027-28');                    // end is OUTSIDE
  });

  test('rejects a malformed financial year', () => {
    expect(() => N.financialYearBounds('2026')).toThrow();
    expect(() => N.financialYearBounds('2026-2027')).toThrow();
    expect(() => N.financialYearBounds('')).toThrow();
  });
});

describe('GEN-C financial-year choice lock', () => {
  test('the live account (created 31 Jul 2026) locks on 1 Apr 2027', () => {
    const activated = new Date('2026-07-31T00:00:00Z');
    expect(N.firstAprilAfter(activated).toISOString()).toBe('2027-03-31T18:30:00.000Z');
    // Today, in this project's timeline, the choice is still open.
    expect(N.isFyChoiceLocked(activated, new Date('2026-08-27T00:00:00Z'))).toBe(false);
    expect(N.isFyChoiceLocked(activated, new Date('2027-03-31T00:00:00Z'))).toBe(false);
    expect(N.isFyChoiceLocked(activated, new Date('2027-04-01T00:00:00+05:30'))).toBe(true);
  });

  test('an account activated just BEFORE 1 April locks that same April', () => {
    const activated = new Date('2027-03-20T00:00:00+05:30');
    expect(N.firstAprilAfter(activated).toISOString()).toBe('2027-03-31T18:30:00.000Z');
    expect(N.isFyChoiceLocked(activated, new Date('2027-04-02T00:00:00+05:30'))).toBe(true);
  });

  test('an account activated just AFTER 1 April gets a full year', () => {
    const activated = new Date('2027-04-02T00:00:00+05:30');
    expect(N.firstAprilAfter(activated).toISOString()).toBe('2028-03-31T18:30:00.000Z');
    expect(N.isFyChoiceLocked(activated, new Date('2028-03-31T00:00:00+05:30'))).toBe(false);
    expect(N.isFyChoiceLocked(activated, new Date('2028-04-01T00:00:00+05:30'))).toBe(true);
  });

  test('each account gets its OWN deadline, never another account\'s', () => {
    const older = new Date('2026-07-31T00:00:00Z');
    const newer = new Date('2027-06-01T00:00:00Z');
    const at = new Date('2027-09-01T00:00:00Z');
    expect(N.isFyChoiceLocked(older, at)).toBe(true);    // already lived through 1 Apr 2027
    expect(N.isFyChoiceLocked(newer, at)).toBe(false);   // its first 1 April is 2028
  });

  test('activation exactly at 1 April 00:00 IST waits for the NEXT one', () => {
    const activated = new Date('2027-04-01T00:00:00+05:30');
    // "strictly after" — an account created the instant the year turns has not lived through it.
    expect(N.firstAprilAfter(activated).toISOString()).toBe('2028-03-31T18:30:00.000Z');
  });
});
