// Shared cylinder-holding calculation — the single source of truth for "how many
// cylinders does this customer currently hold", used by the customers, dashboard,
// and reports routes so they can never drift apart.
//
// Holding is counted PER SERIAL, not as a running quantity total. A serial is held when its
// net is positive:
//   net(serial) = Σ GIVEN.qty   where !returned_via              (given to them and not returned)
//               − Σ RECEIVED.qty where !returned_on_behalf_of    (only their own returns count,
//                                                                 not ones made on another's behalf)
//   held = number of serials with net > 0
//
// Why per-serial and not a plain sum: a customer can legitimately return a cylinder that was
// never recorded as GIVEN to them — issued before the software existed, or handed over informally.
// Summing quantities lets those unmatched returns push the total below zero (a customer physically
// holding 18 cylinders showing "-5"). Clamping per serial keeps the number equal to the actual
// held-cylinder list, which is the physical truth. Unmatched returns still count in totalReceived,
// so the all-time Filled/Empty figures are unaffected.
//
// @param {Array} bills - ONE customer's bills (each with a line_items array). Never mix customers:
//                        netting is per serial, so another customer's return would cancel this
//                        customer's issue. Callers using a projection MUST include
//                        line_items.serial_number, or every line looks serial-less and held is 0.
// @returns {{ totalGiven:number, totalReceived:number, held:number, totalBillAmount:number,
//             heldSerials:string[], breakdown:Array<{gas_type_name,size_label,currently_held}> }}
function computeHoldings(bills) {
  let totalGiven = 0;
  let totalReceived = 0;
  let totalBillAmount = 0;

  const net = {};   // serial -> net quantity
  const meta = {};  // serial -> { gas_type_name, size_label } from its most recent GIVEN

  for (const bill of (bills || [])) {
    for (const item of (bill.line_items || [])) {
      const qty = item.quantity || 0;
      const serial = item.serial_number;
      if (item.direction === 'GIVEN') {
        totalGiven += qty;
        totalBillAmount += item.amount;
        // A GIVEN cylinder marked returned (directly or via another customer) is no longer held.
        if (item.returned_via) {
          totalReceived += qty;
        } else if (serial) {
          net[serial] = (net[serial] || 0) + qty;
          meta[serial] = { gas_type_name: item.gas_type_name || '', size_label: item.size_label || '' };
        }
        // Serial-less lines are personal-cylinder-only lines, which carry quantity 0 — nothing to hold.
      } else if (item.direction === 'RECEIVED') {
        // A cross-customer return belongs to the original holder's count, not this customer's.
        if (item.returned_on_behalf_of) continue;
        totalReceived += qty;
        if (serial) net[serial] = (net[serial] || 0) - qty;
      }
    }
  }

  const heldSerials = Object.keys(net).filter(s => net[s] > 0);

  // Per gas-type/size counts, derived from the same held serials so the breakdown always sums
  // to the headline number.
  const byKey = {};
  for (const s of heldSerials) {
    const { gas_type_name, size_label } = meta[s] || { gas_type_name: '', size_label: '' };
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
