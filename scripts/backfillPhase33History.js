// Phase 33 — reconstruct REAL per-cylinder history from existing data.
//
// Replaces the single "Initial record" seed (migratePhase33.js) with genuine timelines rebuilt
// by replaying every non-draft bill chronologically:
//   • one "added" entry per cylinder, dated to when it entered CylinderPro (its createdAt)
//   • GIVEN / RECEIVED events from customer bills (real date, customer, bill number)
//   • TRANSFER events from internal-transfer bills (from → to, bill number)
//   • FILLED events from the historical filling log
// before/after location & stock_state are tracked by forward-replay so each event shows the
// transition it caused. "Performed by" resolves from the CURRENT location manager (history never
// recorded the operator). The rolling 15-most-recent cap is applied per cylinder, exactly like
// the live feature. Purely observational — never writes a cylinder's location/stock_state.
//
// Idempotent: wipes CylinderHistory first, then rebuilds. Safe to re-run.
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/mongodb');
const Bill = require('../models/Bill');
const Cylinder = require('../models/Cylinder');
const Customer = require('../models/Customer');
const FillingLogEntry = require('../models/FillingLogEntry');
const LocationProfile = require('../models/LocationProfile');
const CylinderHistory = require('../models/CylinderHistory');
const { LOCATION_LABELS } = require('../config/locations');

const CAP = 15;
const CHANDISAR = 'AT_PLANT_CHANDISAR';

(async () => {
  await connectDB();

  // ── Lookups ──
  const cyls = await Cylinder.find({}, { rotational_number: 1, user_id: 1, createdAt: 1, location: 1, stock_state: 1 }).lean();
  const cylByRot = {}; // per user: rot -> cylinder
  cyls.forEach(c => { cylByRot[`${c.user_id}|${c.rotational_number}`] = c; });

  const customers = await Customer.find({}, { company_name: 1 }).lean();
  const custName = {}; customers.forEach(c => { custName[String(c._id)] = c.company_name || ''; });

  const profiles = await LocationProfile.find({}, { user_id: 1, location: 1, manager_name: 1 }).lean();
  const mgr = {}; // `${user}|${location}` -> manager name
  profiles.forEach(p => { mgr[`${p.user_id}|${p.location}`] = p.manager_name || ''; });
  const managerOf = (user, loc) => mgr[`${user}|${loc}`] || '';

  // events[`${user}|${cylId}`] = [ {event...} ]
  const events = {};
  const push = (user, cyl, ev) => {
    const key = `${user}|${cyl._id}`;
    (events[key] || (events[key] = [])).push({
      user_id: cyl.user_id, cylinder_id: cyl._id, rotational_number: cyl.rotational_number, ...ev
    });
  };

  // Running state per cylinder during forward replay (unknown before its first event).
  const track = {}; // rot-key -> { location, stock_state }
  const stateOf = (k) => (track[k] || (track[k] = { location: '', stock_state: '' }));

  // ── Replay bills chronologically ──
  const bills = await Bill.find({ is_draft: { $ne: true } })
    .sort({ bill_date: 1, createdAt: 1 })
    .lean();

  let customerEvents = 0, transferEvents = 0;
  for (const b of bills) {
    const user = b.user_id;
    const items = (b.line_items || []).filter(li => (li.serial_number || '').trim());
    // Within a customer bill, apply RECEIVED before GIVEN (swap round-trips end AT_CUSTOMER),
    // matching the live post-save hook. Transfer bills carry only TRANSFER lines.
    const order = { RECEIVED: 0, GIVEN: 1, TRANSFER: 2 };
    items.sort((x, y) => (order[x.direction] ?? 3) - (order[y.direction] ?? 3));

    for (const li of items) {
      const rot = li.serial_number.trim();
      const cyl = cylByRot[`${user}|${rot}`];
      if (!cyl) continue; // serial no longer maps to a cylinder — skip
      const k = `${user}|${rot}`;
      const st = stateOf(k);
      const from_location = st.location, from_state = st.stock_state;

      if (b.transaction_category === 'INTERNAL_TRANSFER' || li.direction === 'TRANSFER') {
        const fromLabel = LOCATION_LABELS[b.from_location] || b.from_location || '';
        const toLabel = LOCATION_LABELS[b.to_location] || b.to_location || '';
        st.location = b.to_location; // stock_state unchanged by a transfer
        push(user, cyl, {
          event_type: 'TRANSFER',
          description: `Transferred from ${fromLabel} to ${toLabel}`,
          from_location: from_location || b.from_location || '', to_location: b.to_location || '',
          from_state, to_state: st.stock_state,
          document_ref: b.bill_number || '',
          performed_by: managerOf(user, b.from_location), performed_at_location: b.from_location || '',
          event_at: b.bill_date
        });
        transferEvents++;
      } else if (li.direction === 'GIVEN') {
        const name = custName[String(b.customer_id)] || 'customer';
        const label = LOCATION_LABELS[b.location] || b.location || '';
        st.location = b.location; st.stock_state = 'AT_CUSTOMER';
        push(user, cyl, {
          event_type: 'GIVEN',
          description: `Given filled to ${name} at ${label}`,
          from_location, to_location: b.location || '', from_state, to_state: 'AT_CUSTOMER',
          customer_name: custName[String(b.customer_id)] || '', document_ref: b.bill_number || '',
          performed_by: managerOf(user, b.location), performed_at_location: b.location || '',
          event_at: b.bill_date
        });
        customerEvents++;
      } else if (li.direction === 'RECEIVED') {
        const name = custName[String(b.customer_id)] || 'customer';
        const label = LOCATION_LABELS[b.location] || b.location || '';
        st.location = b.location; st.stock_state = 'IN_STOCK';
        push(user, cyl, {
          event_type: 'RECEIVED',
          description: `Received empty from ${name} at ${label}`,
          from_location, to_location: b.location || '', from_state, to_state: 'IN_STOCK',
          customer_name: custName[String(b.customer_id)] || '', document_ref: b.bill_number || '',
          performed_by: managerOf(user, b.location), performed_at_location: b.location || '',
          event_at: b.bill_date
        });
        customerEvents++;
      }
    }
  }

  // ── Historical fills (log-only) ──
  const fills = await FillingLogEntry.find({}, { user_id: 1, rotational_number: 1, date: 1 }).lean();
  let fillEvents = 0;
  for (const f of fills) {
    const rot = (f.rotational_number || '').trim();
    if (!rot) continue;
    const cyl = cylByRot[`${f.user_id}|${rot}`];
    if (!cyl) continue;
    push(f.user_id, cyl, {
      event_type: 'FILLED',
      description: `Filled at Chandisar Plant on ${f.date}`,
      performed_by: managerOf(f.user_id, CHANDISAR), performed_at_location: CHANDISAR,
      event_at: new Date(f.date)
    });
    fillEvents++;
  }

  // ── "Added" event per cylinder — dated to the earliest of createdAt / its first event, and
  // carrying the migration SNAPSHOT (to_location/to_state): the cylinder's state just before its
  // first real event (inferred from that event), or its current state if it was never transacted.
  // This snapshot is what the Phase 34 pre-software confirmation checks a backdated entry against.
  for (const c of cyls) {
    const key = `${c.user_id}|${c._id}`;
    const evs = events[key] || [];
    let earliest = new Date(c.createdAt).getTime();
    let firstEv = null;
    for (const e of evs) {
      const t = new Date(e.event_at).getTime();
      earliest = Math.min(earliest, t);
      if (!firstEv || t < new Date(firstEv.event_at).getTime()) firstEv = e;
    }
    let snapLoc = c.location, snapState = c.stock_state; // never-transacted → current is exact
    if (firstEv) {
      if (firstEv.event_type === 'TRANSFER') { snapLoc = firstEv.from_location || c.location; snapState = 'IN_STOCK'; }
      else if (firstEv.event_type === 'GIVEN') { snapLoc = firstEv.to_location || c.location; snapState = 'IN_STOCK'; }
      else if (firstEv.event_type === 'RECEIVED') { snapLoc = firstEv.to_location || c.location; snapState = 'AT_CUSTOMER'; }
      // FILLED first is rare and doesn't change state → keep the current-state fallback.
    }
    push(c.user_id, c, {
      event_type: 'MIGRATED',
      description: 'Cylinder added to CylinderPro',
      to_location: snapLoc, to_state: snapState,
      performed_at_location: snapLoc || '',
      event_at: new Date(earliest)
    });
  }

  // ── Cap to the 15 most recent per cylinder, then bulk insert ──
  await CylinderHistory.deleteMany({});
  let toInsert = [];
  let totalKept = 0, cappedCyls = 0;
  const flush = async () => { if (toInsert.length) { await CylinderHistory.insertMany(toInsert, { ordered: false }); toInsert = []; } };
  for (const key of Object.keys(events)) {
    const list = events[key].sort((a, b) => new Date(a.event_at) - new Date(b.event_at));
    let kept = list;
    if (list.length > CAP) { kept = list.slice(list.length - CAP); cappedCyls++; }
    totalKept += kept.length;
    toInsert.push(...kept);
    if (toInsert.length >= 2000) await flush();
  }
  await flush();

  console.log('Phase 33 history backfill complete:');
  console.log(`  bills replayed:        ${bills.length}`);
  console.log(`  customer events:       ${customerEvents}`);
  console.log(`  transfer events:       ${transferEvents}`);
  console.log(`  fill events:           ${fillEvents}`);
  console.log(`  cylinders:             ${cyls.length}  (each got an "added" entry)`);
  console.log(`  history rows written:  ${totalKept}`);
  console.log(`  cylinders hitting cap: ${cappedCyls} (kept most recent ${CAP})`);
  await mongoose.connection.close();
  process.exit(0);
})().catch(e => { console.error('BACKFILL ERROR', e); process.exit(1); });
