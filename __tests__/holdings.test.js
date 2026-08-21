const { computeHoldings } = require('../services/holdings.service');

const line = (direction, serial, extra = {}) => ({
  direction, serial_number: serial, quantity: 1, amount: 0,
  gas_type_name: 'Oxygen', size_label: '7 m3', ...extra
});

// "Currently Holding" must equal the held-cylinder list the UI shows. It is counted per serial,
// so an unmatched return — a cylinder handed back that was never recorded as GIVEN (issued before
// the software, or informally) — cannot drive the figure below what the customer physically holds.
describe('computeHoldings — per-serial holding', () => {
  test('unmatched returns do not push the count negative', () => {
    const bills = [{ line_items: [
      line('GIVEN', 'A'), line('GIVEN', 'B'),
      line('RECEIVED', 'A'),            // matched return -> A no longer held
      line('RECEIVED', 'X'),            // never given to them (pre-software issue)
      line('RECEIVED', 'Y'), line('RECEIVED', 'Z')
    ] }];
    const r = computeHoldings(bills);
    expect(r.held).toBe(1);             // only B — NOT 2 - 4 = -2
    expect(r.heldSerials).toEqual(['B']);
    // All-time figures still count every movement, so the Filled/Empty totals are unaffected.
    expect(r.totalGiven).toBe(2);
    expect(r.totalReceived).toBe(4);
  });

  test('breakdown sums to the headline held count', () => {
    const bills = [{ line_items: [
      line('GIVEN', 'A'), line('GIVEN', 'B'),
      line('GIVEN', 'C', { gas_type_name: 'Argon' }),
      line('RECEIVED', 'Q', { gas_type_name: 'Argon' }) // unmatched Argon return
    ] }];
    const r = computeHoldings(bills);
    expect(r.held).toBe(3);
    expect(r.breakdown.reduce((t, b) => t + b.currently_held, 0)).toBe(r.held);
    const argon = r.breakdown.find(b => b.gas_type_name === 'Argon');
    expect(argon.currently_held).toBe(1); // not 1 - 1 = 0, and never negative
  });

  test('cross-customer returns still follow the existing flags', () => {
    const bills = [{ line_items: [
      line('GIVEN', 'A', { returned_via: 'someone-else' }),        // returned on their behalf -> not held
      line('GIVEN', 'B'),
      line('RECEIVED', 'C', { returned_on_behalf_of: 'other' })    // not their own return -> ignored
    ] }];
    const r = computeHoldings(bills);
    expect(r.held).toBe(1);
    expect(r.heldSerials).toEqual(['B']);
    expect(r.totalReceived).toBe(1); // only the returned_via GIVEN counts
  });
});
