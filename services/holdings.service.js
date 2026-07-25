// Shared cylinder-holding calculation — the single source of truth for "how many
// cylinders does this customer currently hold", used by the customers, dashboard,
// and reports routes so they can never drift apart.
//
// Correctly accounts for cross-customer returns:
//   held = Σ GIVEN.qty
//        − Σ GIVEN.qty  where returned_via         (this customer's cylinder was returned via someone else)
//        − Σ RECEIVED.qty where !returned_on_behalf_of  (count only this customer's own returns,
//                                                        not cylinders they returned on another's behalf)
//
// @param {Array} bills - the customer's bills (each with a line_items array)
// @returns {{ totalGiven:number, totalReceived:number, held:number, totalBillAmount:number }}
function computeHoldings(bills) {
  let totalGiven = 0;
  let totalReceived = 0;
  let totalBillAmount = 0;

  for (const bill of (bills || [])) {
    for (const item of (bill.line_items || [])) {
      if (item.direction === 'GIVEN') {
        totalGiven += item.quantity;
        totalBillAmount += item.amount;
        // A GIVEN cylinder marked returned (directly or via another customer) is no longer held.
        if (item.returned_via) totalReceived += item.quantity;
      } else if (item.direction === 'RECEIVED') {
        // A cross-customer return belongs to the original holder's count, not this customer's.
        if (!item.returned_on_behalf_of) totalReceived += item.quantity;
      }
    }
  }

  return { totalGiven, totalReceived, held: totalGiven - totalReceived, totalBillAmount };
}

module.exports = { computeHoldings };
