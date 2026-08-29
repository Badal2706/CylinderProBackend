// Has the missing receive-location rule already been exercised in real data?
//
// Giving checks that the cylinder is in stock AT the bill's location (bill.service.js ~790).
// Receiving does not: it returns early the moment the cylinder is AT_CUSTOMER, without asking
// WHERE it was given from. So a cylinder issued from Palanpur can be received on a Chandisar
// bill, and on save its location is rewritten to the receiving bill's site — stock teleports
// between sites with no transfer record, which is exactly what the Stock Summary and DSR read.
//
// This walks every serialized line in bill order and flags each RECEIVED whose matching open
// GIVEN was at a different location. Read-only.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

(async () => {
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.PROBE_URI || process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });

  const User = require('../models/User');
  const Bill = require('../models/Bill');
  const Customer = require('../models/Customer');
  const locationService = require('../services/location.service');

  const user = await User.findOne({ email: /gurugases/i }).select('_id').lean() || await User.findOne().select('_id').lean();
  const uid = user._id;
  const { labels } = await locationService.getUserLocations(uid);
  const L = (c) => labels[c] || c || '(none)';

  const bills = await Bill.find({ user_id: uid, is_draft: { $ne: true } },
    { bill_number: 1, bill_date: 1, createdAt: 1, location: 1, from_location: 1, to_location: 1,
      customer_id: 1, transaction_category: 1,
      'line_items.serial_number': 1, 'line_items.direction': 1 })
    .sort({ bill_date: 1, createdAt: 1 }).lean();

  const open = {};            // serial -> { loc, bill_number, date, customer_id }
  const crossSite = [];

  for (const b of bills) {
    if (b.transaction_category === 'INTERNAL_TRANSFER') {
      // A transfer legitimately moves in-stock cylinders; it also relocates any open holding.
      for (const li of (b.line_items || [])) {
        if (li.serial_number && open[li.serial_number]) open[li.serial_number].loc = b.to_location;
      }
      continue;
    }
    for (const li of (b.line_items || [])) {
      const s = li.serial_number;
      if (!s) continue;
      if (li.direction === 'GIVEN') {
        open[s] = { loc: b.location, bill_number: b.bill_number, date: b.bill_date, customer_id: b.customer_id };
      } else if (li.direction === 'RECEIVED') {
        const g = open[s];
        if (g && g.loc && b.location && g.loc !== b.location) {
          crossSite.push({
            serial: s,
            given_at: g.loc, given_bill: g.bill_number, given_date: g.date,
            recv_at: b.location, recv_bill: b.bill_number, recv_date: b.bill_date,
            customer_id: b.customer_id
          });
        }
        delete open[s];
      }
    }
  }

  console.log(`scanned ${bills.length} bills\n`);
  console.log(`RECEIVED at a DIFFERENT site than it was GIVEN from: ${crossSite.length}\n`);

  if (crossSite.length) {
    const names = {};
    for (const r of crossSite.slice(0, 40)) {
      if (r.customer_id && !names[r.customer_id]) {
        const c = await Customer.findById(r.customer_id).select('company_name').lean();
        names[r.customer_id] = c ? c.company_name : '?';
      }
    }
    console.log('  serial   given at            on bill    date         received at          on bill    date         customer');
    console.log('  ' + '-'.repeat(115));
    for (const r of crossSite.slice(0, 40)) {
      console.log('  ' + String(r.serial).padEnd(9) +
        L(r.given_at).padEnd(20) + String(r.given_bill).padEnd(11) +
        new Date(r.given_date).toISOString().slice(0, 10).padEnd(13) +
        L(r.recv_at).padEnd(21) + String(r.recv_bill).padEnd(11) +
        new Date(r.recv_date).toISOString().slice(0, 10).padEnd(13) +
        (names[r.customer_id] || '').slice(0, 26));
    }
    if (crossSite.length > 40) console.log(`  … and ${crossSite.length - 40} more`);

    const pairs = {};
    for (const r of crossSite) {
      const k = `${L(r.given_at)} -> ${L(r.recv_at)}`;
      pairs[k] = (pairs[k] || 0) + 1;
    }
    console.log('\n  by route:');
    for (const [k, n] of Object.entries(pairs).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(48)} ${n}`);

    const byYear = {};
    for (const r of crossSite) {
      const y = new Date(r.recv_date).toISOString().slice(0, 7);
      byYear[y] = (byYear[y] || 0) + 1;
    }
    console.log('\n  by month received:');
    for (const [k, n] of Object.entries(byYear).sort()) console.log(`    ${k}  ${n}`);
  }

  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
