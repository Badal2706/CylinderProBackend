// Backfill `seq` on history rows that share one instant for the same cylinder and bill.
//
// A swap logs two lines for a cylinder at the same moment (out and back). With no tiebreak they
// came out of the sort in an arbitrary order, so a vendor round trip could read "received filled"
// BEFORE "given empty for filling" — backwards from what happened. seq orders the pair: the
// direction that decides where the cylinder ends up reads last (vendor → RECEIVED last; ordinary
// customer → GIVEN last). Idempotent. DRY=1 previews.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const Bill = require('../models/Bill');
const Customer = require('../models/Customer');
const CylinderHistory = require('../models/CylinderHistory');

const DRY = process.env.DRY === '1';

(async () => {
  await connectDB();

  const vendors = new Set((await Customer.find({ is_filling_vendor: true }, { _id: 1 }).lean()).map(v => String(v._id)));

  // Bills where some serial appears on both sides.
  const bills = await Bill.find({ transaction_category: { $ne: 'INTERNAL_TRANSFER' }, is_draft: { $ne: true } },
    { bill_number: 1, customer_id: 1, line_items: 1, user_id: 1 }).lean();

  let updated = 0;
  const samples = [];
  for (const b of bills) {
    const given = new Set(), received = new Set();
    for (const li of (b.line_items || [])) {
      const s = (li.serial_number || '').trim();
      if (!s) continue;
      if (li.direction === 'GIVEN') given.add(s);
      else if (li.direction === 'RECEIVED') received.add(s);
    }
    const dual = [...given].filter(s => received.has(s));
    if (!dual.length) continue;

    const isVendor = vendors.has(String(b.customer_id));
    for (const serial of dual) {
      // vendor: out empty first, back filled second. customer: returns first, takes second.
      const wanted = { GIVEN: isVendor ? 0 : 1, RECEIVED: isVendor ? 1 : 0 };
      for (const dir of ['GIVEN', 'RECEIVED']) {
        const q = { user_id: b.user_id, rotational_number: serial, document_ref: b.bill_number, event_type: dir, seq: { $ne: wanted[dir] } };
        const n = DRY
          ? await CylinderHistory.countDocuments(q)
          : (await CylinderHistory.updateMany(q, { $set: { seq: wanted[dir] } })).modifiedCount;
        if (n && samples.length < 8) samples.push(`${b.bill_number} cyl ${serial} ${dir} -> seq ${wanted[dir]}${isVendor ? ' (vendor)' : ''}`);
        updated += n;
      }
    }
  }

  console.log(`${DRY ? '[DRY] ' : ''}history rows re-sequenced: ${updated}`);
  samples.forEach(s => console.log('  ' + s));
  if (DRY) console.log('(DRY run — no changes written.)');

  await mongoose.connection.close();
  process.exit(0);
})().catch(e => { console.error('SEQ BACKFILL ERROR', e); process.exit(1); });
