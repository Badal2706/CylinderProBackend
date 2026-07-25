// Phase 18 self-verification. Run from CylinderProBackend: node scripts/verifyPhase18.js
// Exercises every gate end-to-end against the live dev API; Mongo is used only for
// time-travel (3-day lock) on the throwaway test tenant.
require('dotenv').config();
const mongoose = require('mongoose');
const { authenticator } = require('otplib');

const API = 'http://localhost:3001/api';
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ' — ' + detail : ''}`); };
let token = '';
const api = async (method, path, body, extraHeaders = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null; try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/cylinder_management');
  const db = mongoose.connection.db;

  const email = `verify18_${Date.now()}@test.local`;
  let r = await api('POST', '/auth/signup', { name: 'Verify18 Bot', email, password: 'verify123' });
  token = r.data.token;
  check('Signup test user', r.ok && !!token, email);
  const uid = new mongoose.Types.ObjectId(String(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id));

  // Trusted person + TOTP (first add is ungated — no one can approve yet).
  r = await api('POST', '/trusted-people', { name: 'Approver A', email: 'a18@test.local' });
  check('First trusted person adds WITHOUT approval (no approvers exist yet)', r.ok, JSON.stringify(r.data && r.data.error));
  const pA = r.data.person;
  await api('POST', `/trusted-people/${pA.person_id}/verify-email`, { code: r.data.dev_code });
  r = await api('POST', `/trusted-people/${pA.person_id}/totp/enroll`);
  const secretA = r.data.secret;
  await api('POST', `/trusted-people/${pA.person_id}/totp/confirm`, { code: authenticator.generate(secretA) });
  const su = async () => (await api('POST', '/step-up/totp/verify', { code: authenticator.generate(secretA) })).data.step_up_token;

  // Masters + bill fixtures
  const g = (await api('GET', '/masters/gas-types')).data;
  const s = (await api('GET', '/masters/cylinder-sizes')).data;
  const ox = g.find(x => x.gas_type_name === 'Oxygen');
  const s7 = s.find(x => x.size_label === '7 m3');
  const cust = (await api('POST', '/customers', { company_name: 'Verify18 Cust', contact_person: 'C', phone_primary: '9999999981', address: 'x', holding_limit: 5 })).data.customer_id;
  for (const n of ['V18-01', 'V18-02', 'V18-03']) {
    await api('POST', '/cylinders', { rotational_number: n, gas_type: 'Oxygen', capacity: '7 m3', location: 'AT_PLANT_CHANDISAR', stock_state: 'IN_STOCK' });
  }
  r = await api('POST', '/bills', {
    customer_id: cust, customer_type: 'REGULAR', bill_date: new Date().toISOString(),
    transaction_type: 'GIVEN', location: 'AT_PLANT_CHANDISAR', challan_no: 'V18-C1',
    given_items: [{ gas_type_id: ox._id, cylinder_size_id: s7._id, serial_numbers: ['V18-01'], quantity: 1, rate: 100 }]
  });
  const billId = r.data.bill_id;
  check('Normal in-limit bill saves with NO approval needed', r.ok);

  // ── Step 2/3: edit + delete gating ──
  const editBody = {
    bill_date: new Date().toISOString().slice(0, 10), challan_no: 'V18-C1-EDIT', transaction_type: 'GIVEN', logEdit: true,
    line_items: [{ direction: 'GIVEN', gas_type_id: ox._id, cylinder_size_id: s7._id, serial_number: 'V18-01', rate: 120 }]
  };
  r = await api('PUT', `/bills/${billId}`, editBody);
  check('Edit bill WITHOUT approval → 403 blocked', !r.ok && r.status === 403, JSON.stringify(r.data && r.data.error));
  r = await api('PUT', `/bills/${billId}`, editBody, { 'x-step-up-token': await su() });
  check('Edit bill WITH approval → succeeds', r.ok, JSON.stringify(r.data && r.data.error));
  r = await api('PUT', `/bills/${billId}`, { bill_number: 'V18-RENAMED', logEdit: true });
  check('Bill-number-only edit stays ungated (quiet Phase 8 path)', r.ok);
  let bill = (await api('GET', `/bills/${billId}`)).data;
  const eh = (bill.edit_history || []).find(h => h.authorized_by);
  check('edit_history entry carries approver + method ALONGSIDE the change log',
    !!eh && eh.authorized_by === 'Approver A' && eh.authorized_via === 'TOTP' && (eh.changes || []).length > 0,
    eh && `${eh.authorized_by}/${eh.authorized_via}: ${(eh.changes || []).join('; ')}`);
  check('bill.authorizations records the EDIT approval',
    (bill.authorizations || []).some(a => a.action === 'EDIT' && a.person_name === 'Approver A'));

  r = await api('DELETE', `/bills/${billId}`);
  check('Delete bill WITHOUT approval → 403 blocked', !r.ok && r.status === 403, JSON.stringify(r.data && r.data.error));
  r = await api('DELETE', `/bills/${billId}`, null, { 'x-step-up-token': await su() });
  check('Delete bill WITH approval → succeeds', r.ok);

  // ── Step 4: 3-day window is the OUTER boundary — approval never bypasses it ──
  r = await api('POST', '/bills', {
    customer_id: cust, customer_type: 'REGULAR', bill_date: new Date().toISOString(),
    transaction_type: 'GIVEN', location: 'AT_PLANT_CHANDISAR', challan_no: 'V18-OLD',
    given_items: [{ gas_type_id: ox._id, cylinder_size_id: s7._id, serial_numbers: ['V18-02'], quantity: 1, rate: 100 }]
  });
  const oldBillId = r.data.bill_id;
  await db.collection('bills').updateOne({ _id: new mongoose.Types.ObjectId(String(oldBillId)) }, { $set: { createdAt: new Date(Date.now() - 4 * 86400000) } });
  r = await api('PUT', `/bills/${oldBillId}`, { ...editBody, challan_no: 'V18-OLD-EDIT', line_items: [{ direction: 'GIVEN', gas_type_id: ox._id, cylinder_size_id: s7._id, serial_number: 'V18-02', rate: 120 }] }, { 'x-step-up-token': await su() });
  check('Editing a 4-day-old bill fails EVEN WITH valid approval (3-day lock holds)', !r.ok && r.status === 400, JSON.stringify(r.data && r.data.error));
  r = await api('DELETE', `/bills/${oldBillId}`, null, { 'x-step-up-token': await su() });
  check('Deleting a 4-day-old bill fails EVEN WITH valid approval', !r.ok && r.status === 400);

  // ── Step 5: over-limit override + Save-for-Later fallback ──
  const cust2 = (await api('POST', '/customers', { company_name: 'Verify18 Tight', contact_person: 'T', phone_primary: '9999999982', address: 'x', holding_limit: 0 })).data.customer_id;
  const overBill = {
    customer_id: cust2, customer_type: 'REGULAR', bill_date: new Date().toISOString(),
    transaction_type: 'GIVEN', location: 'AT_PLANT_CHANDISAR', challan_no: 'V18-OVER',
    given_items: [{ gas_type_id: ox._id, cylinder_size_id: s7._id, serial_numbers: ['V18-03'], quantity: 1, rate: 100 }]
  };
  r = await api('POST', '/bills', overBill);
  check('Over-limit save WITHOUT approval stays hard-blocked', !r.ok && r.status === 400, JSON.stringify(r.data && r.data.error));
  r = await api('POST', '/bills/drafts', { location: 'AT_PLANT_CHANDISAR', payload: { customerType: 'REGULAR', customer_id: cust2, transactionType: 'GIVEN', challanNo: 'V18-OVER', givenItems: [] } });
  check('Save-for-Later still works with NO verification (fallback intact)', r.ok);
  r = await api('POST', '/bills', { ...overBill, step_up_token: await su() });
  const overBillId = r.data && r.data.bill_id;
  check('Over-limit save WITH approval succeeds', r.ok, JSON.stringify(r.data && r.data.error));
  bill = (await api('GET', `/bills/${overBillId}`)).data;
  check('Over-limit bill records OVER_LIMIT_OVERRIDE authorization (who + method)',
    (bill.authorizations || []).some(a => a.action === 'OVER_LIMIT_OVERRIDE' && a.person_name === 'Approver A' && a.via === 'TOTP'));

  // ── Steps 6/7: profile-section saves gated; viewing open ──
  r = await api('GET', '/profile/business');
  check('Viewing Business Info needs NO approval', r.ok);
  r = await api('PUT', '/profile/business', { business_name: 'V18 Biz' });
  check('Saving Business Info WITHOUT approval → 403', !r.ok && r.status === 403);
  r = await api('PUT', '/profile/business', { business_name: 'V18 Biz' }, { 'x-step-up-token': await su() });
  check('Saving Business Info WITH approval → succeeds', r.ok);
  r = await api('GET', '/profile/locations');
  check('Viewing Location Profiles needs NO approval', r.ok);
  r = await api('PUT', '/profile/locations/AT_PLANT_CHANDISAR', { manager_name: 'V18 Mgr', contact_number: '1', challan_prefix: 'V-' });
  check('Saving a Location Profile WITHOUT approval → 403', !r.ok && r.status === 403);
  r = await api('PUT', '/profile/locations/AT_PLANT_CHANDISAR', { manager_name: 'V18 Mgr', contact_number: '1', challan_prefix: 'V-' }, { 'x-step-up-token': await su() });
  check('Saving a Location Profile WITH approval → succeeds', r.ok);

  // Masters (global catalog): use a throwaway gas so real catalogs are untouched.
  r = await api('POST', '/masters/gas-types', { gas_type_name: 'Verify18Gas' });
  check('Adding a gas type WITHOUT approval → 403', !r.ok && r.status === 403);
  r = await api('POST', '/masters/gas-types', { gas_type_name: 'Verify18Gas' }, { 'x-step-up-token': await su() });
  const v18gas = r.data;
  check('Adding a gas type WITH approval → succeeds', r.ok);
  r = await api('DELETE', `/masters/gas-types/${v18gas.gas_type_id || v18gas._id}`);
  check('Removing a gas type WITHOUT approval → 403', !r.ok && r.status === 403);
  r = await api('DELETE', `/masters/gas-types/${v18gas.gas_type_id || v18gas._id}`, null, { 'x-step-up-token': await su() });
  check('Removing a gas type WITH approval → succeeds (catalog restored)', r.ok, JSON.stringify(r.data && r.data.error));

  // Trusted People list management: gated now that Approver A is active.
  r = await api('POST', '/trusted-people', { name: 'Person B', email: 'b18@test.local' });
  check('Adding a 2nd trusted person WITHOUT approval → 403 (an approver exists)', !r.ok && r.status === 403);
  r = await api('POST', '/trusted-people', { name: 'Person B', email: 'b18@test.local' }, { 'x-step-up-token': await su() });
  const pB = r.data && r.data.person;
  check('Adding a 2nd trusted person WITH approval → succeeds', r.ok);
  r = await api('DELETE', `/trusted-people/${pB.person_id}`);
  check('Removing a trusted person WITHOUT approval → 403', !r.ok && r.status === 403);
  r = await api('DELETE', `/trusted-people/${pB.person_id}`, null, { 'x-step-up-token': await su() });
  check('Removing a trusted person WITH approval → succeeds', r.ok);

  // ── Step 8: audit trail ──
  r = await api('GET', '/profile/audit-log');
  const log = r.data || [];
  const actions = new Set(log.map(x => x.action));
  const wanted = ['BILL_EDIT', 'BILL_DELETE', 'OVER_LIMIT_OVERRIDE', 'PROFILE_SAVE', 'MASTERS_CHANGE', 'TRUSTED_PEOPLE_CHANGE'];
  check('Audit log records every gated action type', wanted.every(w => actions.has(w)), [...actions].join(', '));
  check('Every audit entry names the approver and method',
    log.length > 0 && log.every(x => x.person_name === 'Approver A' && x.via === 'TOTP'), `${log.length} entries`);

  // ── Cleanup ──
  r = await api('DELETE', '/profile/delete-account', { password: 'verify123' });
  check('Cleanup: test account deleted', r.ok);
  const leftovers = await db.collection('auditlogs').countDocuments({ user_id: uid })
    + await db.collection('trustedpeople').countDocuments({ user_id: uid })
    + await db.collection('gastypes').countDocuments({ gas_type_name: 'Verify18Gas' });
  check('Cleanup: no audit/trusted-people/gas leftovers', leftovers === 0, `leftovers=${leftovers}`);

  await mongoose.disconnect();
  const failed = results.filter(x => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ' — FAILURES: ' + failed.map(f => f.name).join('; ') : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });
