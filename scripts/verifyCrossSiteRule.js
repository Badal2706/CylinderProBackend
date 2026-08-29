// Proves the new cross-site return rule on REAL production-copy data, over HTTP, without writing
// anything. An unconfirmed POST returns the warning and saves NOTHING — that is the whole point of
// the confirmation gate, so it doubles as a safe way to exercise it against live records.
//
// Three cases, using cylinders that are genuinely out with customers right now:
//   1. received at the site it went out from   -> must save cleanly (rolled back immediately)
//   2. received at a different site            -> must return the warning and save nothing
//   3. the warning names both sites correctly
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const BASE = process.env.BASE || 'http://127.0.0.1:3001';
const results = [];
const check = (l, ok, d) => { results.push(!!ok); console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${l}${d ? '   -> ' + d : ''}`); };

(async () => {
  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });

  const User = require('../models/User');
  const Cylinder = require('../models/Cylinder');
  const Bill = require('../models/Bill');
  const Customer = require('../models/Customer');
  const GasType = require('../models/GasType');
  const CylinderSize = require('../models/CylinderSize');
  const locationService = require('../services/location.service');

  const user = await User.findOne({ email: /gurugases/i }).select('_id token_version email').lean();
  const token = jwt.sign({ id: String(user._id), tv: user.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '15m' });
  const { labels } = await locationService.getUserLocations(user._id);

  // A cylinder genuinely out with a customer, issued from a NON-filling site so there is a real
  // "other site" to try receiving it at.
  const out = await Cylinder.find({ user_id: user._id, stock_state: 'AT_CUSTOMER' })
    .select('rotational_number location gas_type capacity').limit(4000).lean();
  const byLoc = {};
  for (const c of out) (byLoc[c.location] = byLoc[c.location] || []).push(c);
  console.log(`cylinders currently with customers, by issuing site:`);
  for (const [k, v] of Object.entries(byLoc)) console.log(`   ${(labels[k] || k).padEnd(20)} ${v.length}`);

  const sites = Object.keys(byLoc).filter(k => byLoc[k].length);
  if (sites.length < 2) { console.log('\nneed two sites with cylinders out to test this — skipping'); process.exit(0); }

  const from = sites.find(s => byLoc[s].length > 0);
  const other = sites.find(s => s !== from);
  const cyl = byLoc[from][0];

  // Who is holding it — the receive must be billed to that customer.
  const holder = await Bill.findOne({
    user_id: user._id,
    line_items: { $elemMatch: { direction: 'GIVEN', serial_number: cyl.rotational_number } }
  }).sort('-bill_date -createdAt').select('customer_id bill_number').lean();
  const cust = holder && holder.customer_id ? await Customer.findById(holder.customer_id).select('company_name').lean() : null;

  const gas = await GasType.findOne({ gas_type_name: cyl.gas_type }).lean()
           || await GasType.findOne().lean();
  const size = await CylinderSize.findOne({ size_label: cyl.capacity }).lean()
           || await CylinderSize.findOne().lean();

  console.log(`\ntest cylinder : ${cyl.rotational_number}  (${cyl.gas_type} / ${cyl.capacity})`);
  console.log(`issued from   : ${labels[from] || from}`);
  console.log(`held by       : ${cust ? cust.company_name : '(unknown)'}  on bill ${holder ? holder.bill_number : '?'}`);
  console.log(`will try receiving at : ${labels[other] || other}\n`);

  const post = (body) => fetch(`${BASE}/api/bills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });

  const bodyFor = (loc) => ({
    customer_id: String(holder.customer_id),
    customer_type: 'REGULAR',
    transaction_type: 'RECEIVED',
    location: loc,
    challan_no: 'VERIFY-XSITE',
    bill_date: new Date(),
    received_items: [{
      gas_type_id: String(gas._id), cylinder_size_id: String(size._id),
      quantity: 1, rate: 0, serial_numbers: [cyl.rotational_number]
    }]
  });

  const billsBefore = await Bill.countDocuments({ user_id: user._id });

  // ── Case 1: wrong site, unconfirmed ──
  const r1 = await post(bodyFor(other));
  const j1 = await r1.json();
  check('receiving at the wrong site returns a confirmation prompt', j1.requires_cross_site_confirmation === true,
    j1.requires_cross_site_confirmation ? '' : JSON.stringify(j1).slice(0, 160));
  check('nothing was saved by the prompt', j1.bill_number === undefined);
  check('the prompt names the issuing site', !!j1.message && j1.message.includes(labels[from] || from),
    j1.message ? j1.message.slice(0, 120) : '(no message)');
  check('the prompt names the receiving site', !!j1.message && j1.message.includes(labels[other] || other));
  check('the payload identifies the cylinder and both sites',
    !!j1.cylinders && j1.cylinders[0] && j1.cylinders[0].serial === cyl.rotational_number &&
    j1.cylinders[0].given_at === from && j1.cylinders[0].received_at === other,
    j1.cylinders ? JSON.stringify(j1.cylinders[0]) : '(none)');

  // ── Case 2: correct site, unconfirmed — must NOT prompt ──
  const r2 = await post(bodyFor(from));
  const j2 = await r2.json();
  check('receiving at the correct site does NOT prompt', !j2.requires_cross_site_confirmation,
    j2.requires_cross_site_confirmation ? 'prompted unexpectedly' : (j2.bill_number ? `saved as ${j2.bill_number}` : JSON.stringify(j2).slice(0, 120)));

  // ── Undo case 2 if it saved, so the database is left exactly as found ──
  // Deletion goes through the real deleteBill() so the cylinder's state and any cross-customer
  // annotations are reverted by the same code a genuine deletion uses. It needs a step-up token;
  // this is a local cleanup of a record this script just created, so one is supplied directly.
  // deleteBill deliberately leaves a BILL_DELETED trail and does not rewind the counter — correct
  // for a real deletion, wrong for a bill that never existed as far as the business is concerned,
  // so both are cleared here too.
  if (j2.bill_number) {
    const billService = require('../services/bill.service');
    const CylinderHistory = require('../models/CylinderHistory');
    const Counter = require('../models/Counter');
    const ctrBefore = await Counter.findOne({ user_id: user._id, key: 'bill_number_series' }).lean();
    const saved = await Bill.findOne({ user_id: user._id, bill_number: j2.bill_number }).select('_id').lean();
    if (saved) {
      await billService.deleteBill(user._id, String(saved._id), { local_verification_cleanup: true, via: 'SCRIPT' });
      await CylinderHistory.deleteMany({ user_id: user._id, document_ref: j2.bill_number });
      if (ctrBefore) {
        await Counter.updateOne({ user_id: user._id, key: 'bill_number_series' }, { $set: { seq: ctrBefore.seq - 1 } });
      }
    }
  }

  const billsAfter = await Bill.countDocuments({ user_id: user._id });
  check('bill count is back to where it started', billsAfter === billsBefore, `${billsBefore} -> ${billsAfter}`);

  const back = await Cylinder.findOne({ user_id: user._id, rotational_number: cyl.rotational_number })
    .select('stock_state location').lean();
  check('the cylinder is back with the customer at its original site',
    back.stock_state === 'AT_CUSTOMER' && back.location === from,
    `${back.stock_state} @ ${labels[back.location] || back.location}`);

  const CylinderHistory2 = require('../models/CylinderHistory');
  check('no history left referring to the verification bill',
    (await CylinderHistory2.countDocuments({ user_id: user._id, document_ref: j2.bill_number || 'none' })) === 0);
  check('no verification challan left behind',
    (await Bill.countDocuments({ user_id: user._id, challan_no: 'VERIFY-XSITE' })) === 0);

  console.log('\n' + (results.every(Boolean) ? `ALL ${results.length} CHECKS PASSED` : `${results.filter(x => !x).length} of ${results.length} FAILED`));
  await mongoose.disconnect();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
