const { computeHoldings } = require('../services/holdings.service');

const line = (direction, serial, extra = {}) => ({
  direction, serial_number: serial, quantity: 1, amount: 0,
  gas_type_name: 'Oxygen', size_label: '7 m3', ...extra
});
// One bill on a given day. createdAt matches so ordering is unambiguous.
const bill = (day, items) => ({
  bill_date: new Date(`2026-07-${day}T09:00:00Z`),
  createdAt: new Date(`2026-07-${day}T09:00:00Z`),
  finalized_at: null,
  line_items: items
});

// "Currently Holding" must equal the held-cylinder list the UI shows. It is decided per serial by
// that cylinder's LATEST event, never by a running total — totals are order-blind, so a stray
// return would cancel out an issue made later.
describe('computeHoldings — latest event per serial decides', () => {
  test('an unmatched return does not cancel a cylinder issued afterwards', () => {
    const bills = [
      // X is returned although it was never recorded as issued (pre-software / informal handover).
      bill('01', [line('RECEIVED', 'X')]),
      // ...and is then genuinely issued to them. They hold it.
      bill('05', [line('GIVEN', 'X')])
    ];
    const r = computeHoldings(bills);
    expect(r.held).toBe(1);
    expect(r.heldSerials).toEqual(['X']);
    // All-time figures still count every movement.
    expect(r.totalGiven).toBe(1);
    expect(r.totalReceived).toBe(1);
  });

  test('a return after an issue clears the holding', () => {
    const bills = [
      bill('01', [line('GIVEN', 'A'), line('GIVEN', 'B')]),
      bill('05', [line('RECEIVED', 'A')])
    ];
    const r = computeHoldings(bills);
    expect(r.held).toBe(1);
    expect(r.heldSerials).toEqual(['B']);
  });

  test('unmatched returns never make the count negative', () => {
    const bills = [bill('01', [line('RECEIVED', 'X'), line('RECEIVED', 'Y'), line('RECEIVED', 'Z')])];
    expect(computeHoldings(bills).held).toBe(0);
  });

  test('breakdown sums to the headline held count', () => {
    const bills = [bill('01', [
      line('GIVEN', 'A'), line('GIVEN', 'B'),
      line('GIVEN', 'C', { gas_type_name: 'Argon' })
    ])];
    const r = computeHoldings(bills);
    expect(r.held).toBe(3);
    expect(r.breakdown.reduce((t, b) => t + b.currently_held, 0)).toBe(r.held);
    expect(r.breakdown.find(b => b.gas_type_name === 'Argon').currently_held).toBe(1);
  });

  test('a customer swapping the same serial keeps it; a filling vendor returns it', () => {
    // One bill listing the serial on both sides — a round trip.
    const bills = [bill('01', [line('RECEIVED', 'S'), line('GIVEN', 'S')])];
    // Ordinary customer: they handed one back and took one out — still with them.
    expect(computeHoldings(bills).held).toBe(1);
    // Filling vendor: it went out empty and came back filled — it is ours again.
    expect(computeHoldings(bills, { isVendor: true }).held).toBe(0);
  });

  test('cross-customer flags still apply', () => {
    const bills = [bill('01', [
      line('GIVEN', 'A', { returned_via: 'someone-else' }),        // returned on their behalf
      line('GIVEN', 'B'),
      line('RECEIVED', 'C', { returned_on_behalf_of: 'other' })    // not their own return
    ])];
    const r = computeHoldings(bills);
    expect(r.held).toBe(1);
    expect(r.heldSerials).toEqual(['B']);
    expect(r.totalReceived).toBe(1); // only the returned_via GIVEN counts
  });

  test('a draft counts from when it was committed', () => {
    const bills = [
      // Receive entered at 09:00.
      { bill_date: new Date('2026-07-10T09:00:00Z'), createdAt: new Date('2026-07-10T09:00:00Z'), finalized_at: null,
        line_items: [line('RECEIVED', 'D')] },
      // Draft dated 08:00 but committed at 10:00 — the later commit is the real order.
      { bill_date: new Date('2026-07-10T08:00:00Z'), createdAt: new Date('2026-07-10T08:05:00Z'),
        finalized_at: new Date('2026-07-10T10:00:00Z'), line_items: [line('GIVEN', 'D')] }
    ];
    expect(computeHoldings(bills).heldSerials).toEqual(['D']);
  });
});
