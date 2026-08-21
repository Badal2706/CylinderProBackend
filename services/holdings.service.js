const { lineEffTime } = require('./cylinderState.service');

// Shared cylinder-holding calculation — the single source of truth for "how many
// cylinders does this customer currently hold", used by the customers, dashboard,
// and reports routes so they can never drift apart.
//
// Holding is decided PER SERIAL by that cylinder's LATEST event with this customer:
//   · latest is GIVEN (not since returned) → they hold it
//   · latest is RECEIVED                   → they don't
//
// Why the latest event and not a running total: totals are order-blind. A customer can return a
// cylinder that was never recorded as issued to them (handed over before the software, or
// informally), and that stray return would cancel out a genuine issue made later — a cylinder
// given out today would silently vanish from their holding list because of a return months ago.
// Reading the last event instead makes this agree with the cylinder's own inventory state, which
// is derived the same way.
//
// Same-bill round trips (a serial on both sides of one swap) are ordered by who the other party is,
// exactly as the state replay does it: a filling vendor sends it back to us, so RECEIVED is the
// later of the two; an ordinary customer keeps it, so GIVEN is.
//
// @param {Array} bills - ONE customer's bills. Never mix customers: the latest event is per serial,
//                        so another customer's return would be read as this one's.
//                        Callers using a projection MUST include line_items.serial_number,
//                        bill_date, createdAt, finalized_at and line_items.added_at — without them
//                        events cannot be ordered.
// @param {Object} opts  - { isVendor } true when this customer is a filling vendor.
// @returns {{ totalGiven:number, totalReceived:number, held:number, totalBillAmount:number,
//             heldSerials:string[], breakdown:Array<{gas_type_name,size_label,currently_held}> }}
function computeHoldings(bills, opts = {}) {
  const isVendor = !!opts.isVendor;
  let totalGiven = 0;
  let totalReceived = 0;
  let totalBillAmount = 0;

  const events = [];
  for (const bill of (bills || [])) {
    for (const item of (bill.line_items || [])) {
      const qty = item.quantity || 0;
      const serial = item.serial_number;
      if (item.direction === 'GIVEN') {
        totalGiven += qty;
        totalBillAmount += item.amount;
        // Already handed back (directly or via another customer) — no longer held.
        if (item.returned_via) { totalReceived += qty; continue; }
        if (serial) {
          events.push({
            serial, dir: 'GIVEN', t: lineEffTime(bill, item), c: bill.createdAt,
            seq: isVendor ? 0 : 1,
            gas_type_name: item.gas_type_name || '', size_label: item.size_label || ''
          });
        }
      } else if (item.direction === 'RECEIVED') {
        // A cross-customer return belongs to the original holder's count, not this customer's.
        if (item.returned_on_behalf_of) continue;
        totalReceived += qty;
        if (serial) {
          events.push({ serial, dir: 'RECEIVED', t: lineEffTime(bill, item), c: bill.createdAt, seq: isVendor ? 1 : 0 });
        }
      }
    }
  }

  // Chronological; the last event for each serial is the one that counts.
  events.sort((a, b) => (a.t - b.t) || (new Date(a.c) - new Date(b.c)) || (a.seq - b.seq));
  const latest = {};
  for (const e of events) latest[e.serial] = e;

  const heldSerials = Object.keys(latest).filter(s => latest[s].dir === 'GIVEN');

  // Per gas-type/size counts, derived from the same held serials so the breakdown always sums
  // to the headline number.
  const byKey = {};
  for (const s of heldSerials) {
    const { gas_type_name, size_label } = latest[s];
    const key = `${gas_type_name}-${size_label}`;
    if (!byKey[key]) byKey[key] = { gas_type_name, size_label, currently_held: 0 };
    byKey[key].currently_held++;
  }

  return {
    totalGiven,
    totalReceived,
    held: heldSerials.length,
    totalBillAmount,
    heldSerials,
    breakdown: Object.values(byKey)
  };
}

module.exports = { computeHoldings };
