// How far behind is the local copy? Read-only on both sides.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

(async () => {
  const uri = process.env.PROBE_URI || process.env.MONGODB_URI;
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });

  const Bill = require('../models/Bill');
  const Payment = require('../models/Payment');
  const Cylinder = require('../models/Cylinder');
  const Customer = require('../models/Customer');
  const CylinderHistory = require('../models/CylinderHistory');
  const FillingLogEntry = require('../models/FillingLogEntry');

  const last = await Bill.findOne().sort('-createdAt').select('bill_number bill_date createdAt').lean();
  const lastFill = await FillingLogEntry.findOne().sort('-createdAt').select('date createdAt').lean();
  const since26 = await Bill.countDocuments({ bill_date: { $gt: new Date('2026-08-26T23:59:59.999+05:30') } });
  const fillsSince26 = await FillingLogEntry.countDocuments({ date: { $gt: '2026-08-26' } });

  console.log(`[${process.env.TAG || 'db'}] ${mongoose.connection.name}`);
  console.log(`  bills          ${await Bill.countDocuments({})}`);
  console.log(`  payments       ${await Payment.countDocuments({})}`);
  console.log(`  cylinders      ${await Cylinder.countDocuments({})}`);
  console.log(`  customers      ${await Customer.countDocuments({})}`);
  console.log(`  history        ${await CylinderHistory.countDocuments({})}`);
  console.log(`  filling log    ${await FillingLogEntry.countDocuments({})}`);
  console.log(`  latest bill    ${last ? `${last.bill_number}  bill_date ${new Date(last.bill_date).toISOString().slice(0, 10)}  created ${new Date(last.createdAt).toISOString().slice(0, 16)}` : '(none)'}`);
  console.log(`  latest fill    ${lastFill ? `${lastFill.date}  created ${new Date(lastFill.createdAt).toISOString().slice(0, 16)}` : '(none)'}`);
  console.log(`  bills AFTER the 26th   ${since26}`);
  console.log(`  fills AFTER the 26th   ${fillsSince26}`);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
