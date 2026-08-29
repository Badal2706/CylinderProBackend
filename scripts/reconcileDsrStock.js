// Cross-check the DSR against the Stock Summary, every day, every site.
//
//   node -r dotenv/config scripts/reconcileDsrStock.js
//   FROM=2026-08-01 TO=2026-08-31 node -r dotenv/config scripts/reconcileDsrStock.js
//
// READ ONLY. Runs both reports through their real services and compares them. Writes nothing.
//
// THE TWO REPORTS ARE DELIBERATELY DIFFERENT and must not be made to agree blindly:
//
//   DSR            what was TRANSACTED at a site on a day: one row per bill per gas x size.
//                  Filled = cylinders going out, Empty = cylinders coming in. It counts DOCUMENTS.
//   Stock Summary  what MOVED IN AND OUT OF THE POOLS at a site: a ledger per gas x size, split
//                  filled/empty, where Opening + In - Out = Closing. It counts MOVEMENTS.
//
// So they agree on the part that IS the same fact - customer bills - and legitimately differ on
// four things, each of which this script accounts for explicitly rather than papering over:
//
//   1. FILLS. A fill is a filling-log entry, not a bill. It adds to the plant's filled pool and
//      removes from its empty pool, and appears in NO DSR row.
//   2. TRANSFERS. The DSR shows them as their own rows and the Stock Summary folds them into the
//      pools. At the filling site, out = filled leaving / in = empties returning; between two
//      non-filling sites the DSR cannot classify them at all (R141) and leaves them blank while
//      the Stock Summary still records the movement (R136).
//   3. THE FILLING-VENDOR INVERSION (R55/R137). On a vendor bill, GIVEN is empties going out and
//      RECEIVED is filled coming back - the opposite of a customer. The Stock Summary applies
//      this at the filling site; the DSR's Filled/Empty columns do not.
//   4. PERSONAL CYLINDERS. The DSR has its own PC In / PC Out columns. Personal cylinders are
//      never in the Stock Summary (R31) - they are not our inventory.
//
// What this script asserts is the thing that must be true after allowing for those: for ORDINARY
// CUSTOMER bills, every cylinder the DSR says went out or came in at a site on a day appears as
// the matching movement in that site's Stock Summary for that day.
const mongoose = require('mongoose');

// Which account to act on. EMAIL=... names one explicitly; with nothing set this falls back to the
// single account in the local database, and refuses if there is more than one rather than guessing.
// Deliberately NOT a hardcoded address: this file is published, and an address baked into source is
// both a privacy leak and wrong on every machine but one.
async function resolveUser(User) {
  const wanted = (process.env.EMAIL || '').trim().toLowerCase();
  if (wanted) {
    const u = await User.findOne({ email: wanted });
    if (!u) throw new Error('No account found for ' + wanted);
    return u;
  }
  const all = await User.find({}, { email: 1, name: 1 }).limit(2).lean();
  if (!all.length) throw new Error('No accounts in this database.');
  if (all.length > 1) throw new Error('More than one account here - name one with EMAIL=you@example.com');
  return User.findOne({ _id: all[0]._id });
}


const FROM = process.env.FROM || '2026-08-01';
const TO = process.env.TO || '2026-08-31';
const EMAIL = (process.env.EMAIL || '').trim().toLowerCase();  // blank = the single local account

const pad = (s, n) => String(s).padEnd(n);
const num = (n, w = 3) => String(n).padStart(w);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/cylinder_management');
  const User = require('../models/User');
  const Bill = require('../models/Bill');
  const Customer = require('../models/Customer');
  const FillingLogEntry = require('../models/FillingLogEntry');
  const locationService = require('../services/location.service');
  const report = require('../services/report.service');
  const { istDayRange } = require('../utils/istDay');

  const u = await resolveUser(User);
  const { codes, labels, fillingLocationCode } = await locationService.getUserLocations(u._id);
  const isF = (x) => !!fillingLocationCode && x === fillingLocationCode;

  const vendorIds = new Set(
    (await Customer.find({ user_id: u._id, is_filling_vendor: true }, { _id: 1 }).lean())
      .map(c => String(c._id)));

  const days = [];
  for (let d = new Date(FROM + 'T00:00:00Z'); d <= new Date(TO + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }

  console.log('Account : ' + u.name + '  <' + u.email + '>');
  console.log('Range   : ' + FROM + ' .. ' + TO + '   (' + days.length + ' days x ' + codes.length + ' sites)');
  console.log('Filling : ' + (labels[fillingLocationCode] || '(none)'));
  console.log('='.repeat(104));

  const problems = [];
  const notes = [];
  let daysWithActivity = 0;

  for (const day of days) {
    const { start, end } = istDayRange(day);
    let dayPrinted = false;

    for (const loc of codes) {
      const dsr = await report.getDSR(u._id, { date: day, location: loc });
      const stock = await report.getStockSummary(u._id, { date: day, location: loc });

      // ── What the DSR says, split the way the Stock Summary splits it ──────
      // Only ORDINARY customer bills are directly comparable. Vendor bills and transfers are
      // counted separately below so the difference is explained, not hidden.
      const dsrCust = {};     // "gas|size" -> { out, in }
      const dsrVendor = {};   // vendor bills at this site
      const dsrTransfer = {}; // transfer rows shown in this site's DSR
      let pcIn = 0, pcOut = 0;

      // getDSR does not expose customer ids on rows, so re-read the day's bills for the vendor split.
      const bills = await Bill.find({
        user_id: u._id, is_draft: { $ne: true }, bill_date: { $gte: start, $lte: end }
      }, { customer_id: 1, location: 1, from_location: 1, to_location: 1, transaction_category: 1, line_items: 1 }).lean();

      for (const b of bills) {
        const isTransfer = b.transaction_category === 'INTERNAL_TRANSFER';
        if (isTransfer) {
          if (b.from_location !== loc && b.to_location !== loc) continue;
        } else if (b.location !== loc) continue;

        const isVendor = !isTransfer && b.customer_id && vendorIds.has(String(b.customer_id));
        for (const li of b.line_items || []) {
          pcIn += li.personalCylindersIn || 0;
          pcOut += li.personalCylindersOut || 0;
          if (!li.serial_number) continue;
          const key = (li.gas_type_name || '') + '|' + (li.size_label || '');
          const bag = isTransfer ? dsrTransfer : (isVendor ? dsrVendor : dsrCust);
          if (!bag[key]) bag[key] = { out: 0, in: 0, subOut: 0, subIn: 0 };
          if (isTransfer) {
            // Split by whether the OTHER end is the filling site. A transfer with the plant carries
            // its own meaning (filled going out / empties coming back) and is assertable; one
            // between two non-filling sites does not (R136) and is only reported.
            const other = b.from_location === loc ? b.to_location : b.from_location;
            const withPlant = isF(other);
            if (b.from_location === loc) {
              bag[key].out += li.quantity || 0;
              if (!withPlant) bag[key].subOut += li.quantity || 0;
            } else {
              bag[key].in += li.quantity || 0;
              if (!withPlant) bag[key].subIn += li.quantity || 0;
            }
          } else if (li.direction === 'GIVEN') bag[key].out += li.quantity || 0;
          else if (li.direction === 'RECEIVED') bag[key].in += li.quantity || 0;
        }
      }

      // ── Fills recorded at this site on this day (not a bill at all) ───────
      const fills = {};
      if (isF(loc)) {
        for (const f of await FillingLogEntry.find({ user_id: u._id, date: day }).lean()) {
          const key = (f.gas_type || '') + '|' + (f.capacity || '');
          fills[key] = (fills[key] || 0) + 1;
        }
      }

      const keys = new Set([
        ...Object.keys(dsrCust), ...Object.keys(dsrVendor), ...Object.keys(dsrTransfer), ...Object.keys(fills),
        ...stock.rows.map(r => r.gas_type + '|' + r.capacity)
      ]);

      for (const key of keys) {
        const [gas, cap] = key.split('|');
        const row = stock.rows.find(r => r.gas_type === gas && r.capacity === cap) ||
          { filled: { opening: 0, add: 0, issue: 0, closing: 0 }, empty: { opening: 0, receive: 0, issue: 0, closing: 0 } };
        const c = dsrCust[key] || { out: 0, in: 0 };
        const v = dsrVendor[key] || { out: 0, in: 0 };
        const t = dsrTransfer[key] || { out: 0, in: 0, subOut: 0, subIn: 0 };
        const nFill = fills[key] || 0;

        // ── Expected Stock Summary movements, built from the DSR facts ──────
        // FILLED out = customers taking filled cylinders + (at the plant) filled transferred out.
        // EMPTY  in  = customers returning empties  + (at the plant) empties transferred in.
        // The vendor inversion applies at the filling site only (R137, and the documented
        // asymmetry in RULES.md 8.1).
        let expFilledAdd = nFill, expFilledIssue = c.out, expEmptyRecv = c.in, expEmptyIssue = nFill;
        if (isF(loc)) {
          expFilledIssue += t.out;      // filled leaving the plant for an office
          expEmptyRecv += t.in;         // empties coming back to the plant
          expFilledAdd += v.in;         // vendor returned filled
          expEmptyIssue += v.out;       // we sent empties to the vendor
        } else {
          // At a non-filling site a vendor bill is treated exactly like a customer bill.
          expFilledIssue += v.out;
          expEmptyRecv += v.in;
          // Transfers WITH THE PLANT are assertable here too (R134/R135): filled can only arrive
          // by transfer, empties can only leave by transfer.
          expFilledAdd += (t.in - t.subIn);
          expEmptyIssue += (t.out - t.subOut);
        }

        // A transfer between two non-filling sites is the documented divergence, not an error: the
        // DSR cannot classify it (R141) while the Stock Summary reads the cylinder's actual pool
        // (R136). Only THOSE product-days skip the two pool-direction assertions; everything else
        // at a non-filling site is checked on all four columns, same as the plant.
        const subToSub = !isF(loc) && (t.subOut || t.subIn);

        const mismatches = [];
        if (row.filled.issue !== expFilledIssue) mismatches.push(`filled OUT dsr=${expFilledIssue} stock=${row.filled.issue}`);
        if (row.empty.receive !== expEmptyRecv) mismatches.push(`empty IN dsr=${expEmptyRecv} stock=${row.empty.receive}`);
        if (isF(loc) || !subToSub) {
          if (row.filled.add !== expFilledAdd) mismatches.push(`filled IN dsr=${expFilledAdd} stock=${row.filled.add}`);
          if (row.empty.issue !== expEmptyIssue) mismatches.push(`empty OUT dsr=${expEmptyIssue} stock=${row.empty.issue}`);
        }
        if (mismatches.length && subToSub) {
          notes.push(`${day} ${pad(labels[loc], 18)} ${pad(gas + ' ' + cap, 14)} office-to-office transfer ` +
                     `(out ${t.out} / in ${t.in}) — DSR leaves it unclassified (R141), Stock Summary records ` +
                     `the pool it was actually in (R136): ${mismatches.join('; ')}`);
        } else if (mismatches.length) {
          problems.push(`${day} ${pad(labels[loc], 18)} ${pad(gas + ' ' + cap, 14)} ${mismatches.join('; ')}`);
        }

        // Ledger self-consistency, re-checked here so one run answers both questions.
        if (row.filled.opening + row.filled.add - row.filled.issue !== row.filled.closing) {
          problems.push(`${day} ${pad(labels[loc], 18)} ${pad(gas + ' ' + cap, 14)} FILLED ledger does not balance`);
        }
        if (row.empty.opening + row.empty.receive - row.empty.issue !== row.empty.closing) {
          problems.push(`${day} ${pad(labels[loc], 18)} ${pad(gas + ' ' + cap, 14)} EMPTY ledger does not balance`);
        }
        for (const [k, val] of Object.entries({
          'filled.opening': row.filled.opening, 'filled.add': row.filled.add, 'filled.issue': row.filled.issue,
          'filled.closing': row.filled.closing, 'empty.opening': row.empty.opening, 'empty.receive': row.empty.receive,
          'empty.issue': row.empty.issue, 'empty.closing': row.empty.closing
        })) {
          if (val < 0) problems.push(`${day} ${pad(labels[loc], 18)} ${pad(gas + ' ' + cap, 14)} NEGATIVE ${k}=${val}`);
        }

        // ── The per-day, per-site, per-product line the user asked to see ──
        const anything = c.out || c.in || v.out || v.in || t.out || t.in || nFill;
        if (anything) {
          if (!dayPrinted) { console.log('\n' + day); dayPrinted = true; daysWithActivity++; }
          const bits = [];
          if (c.out) bits.push(`given ${c.out}`);
          if (c.in) bits.push(`returned ${c.in}`);
          if (v.out) bits.push(`to vendor ${v.out}`);
          if (v.in) bits.push(`from vendor ${v.in}`);
          if (t.out) bits.push(`transferred out ${t.out}`);
          if (t.in) bits.push(`transferred in ${t.in}`);
          if (nFill) bits.push(`filled ${nFill}`);
          console.log('   ' + pad(labels[loc], 18) + pad(gas + ' ' + cap, 14) +
            'DSR: ' + pad(bits.join(', '), 44) +
            'STOCK  filled +' + num(row.filled.add) + '/-' + num(row.filled.issue) +
            '   empty +' + num(row.empty.receive) + '/-' + num(row.empty.issue) +
            (mismatches.length ? (subToSub ? '   [see notes]' : '   <<< MISMATCH') : '   ok'));
        }
      }
    }
  }

  console.log('\n' + '='.repeat(104));
  if (notes.length) {
    console.log('\nEXPECTED DIVERGENCES (documented, not errors)');
    notes.forEach(n => console.log('  - ' + n));
  }
  console.log('\nDays with activity: ' + daysWithActivity);
  if (problems.length) {
    console.log('\nPROBLEMS FOUND: ' + problems.length);
    problems.forEach(p => console.log('  !! ' + p));
    process.exitCode = 1;
  } else {
    console.log('\nNO PROBLEMS. Every DSR movement is matched by the Stock Summary, every ledger');
    console.log('balances (Opening + In - Out = Closing), and no figure is negative.');
  }
  await mongoose.disconnect();
})().catch(e => { console.error('FAILED: ' + (e && e.message ? e.message : e)); process.exit(1); });
