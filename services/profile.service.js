const archiverLib = require('archiver');
// archiver v8 exports named members ({ Archiver, create, ... }); older versions export a
// callable function. Support both so the ZIP export works regardless of installed version.
const createArchive = (opts) =>
  (typeof archiverLib === 'function' ? archiverLib('zip', opts) : archiverLib.create('zip', opts));
const XLSX = require('xlsx');
const User = require('../models/User');
const BusinessProfile = require('../models/BusinessProfile');
const Customer = require('../models/Customer');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const Cylinder = require('../models/Cylinder');
const LocationProfile = require('../models/LocationProfile');
const RentalCharge = require('../models/RentalCharge');
const HttpError = require('../utils/HttpError');
const { LOCATIONS } = require('../config/locations');

// DD/MM/YYYY for exports
const ddmmyyyy = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()}`;
};

const STRONG_PASSWORD = (pw) =>
  typeof pw === 'string' && pw.length >= 8 && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);

async function getAccount(userId) {
  const user = await User.findById(userId).select('-password -token_version');
  if (!user) throw new HttpError(404, 'User not found');
  return {
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    active_location: user.active_location || 'AT_PLANT_CHANDISAR',
    member_since: user.createdAt,
    last_login: user.last_login || null
  };
}

// ─── Location profiles (Phase 2) ───
// Fixed set of 3 per user (one per site). Lazily seeds any missing records so the
// migration script and brand-new signups both end up with the full set.
async function getLocationProfiles(userId) {
  const existing = await LocationProfile.find({ user_id: userId });
  const have = new Set(existing.map(p => p.location));
  const missing = LOCATIONS.filter(l => !have.has(l));
  if (missing.length) {
    // Insert one at a time and tolerate races on the unique (user_id, location) index.
    for (const location of missing) {
      try { existing.push(await LocationProfile.create({ user_id: userId, location })); }
      catch (e) { if (e.code !== 11000) throw e; }
    }
  }
  const user = await User.findById(userId).select('active_location');
  const profiles = LOCATIONS.map(l => {
    const p = existing.find(x => x.location === l) || {};
    return {
      location: l,
      manager_name: p.manager_name || '',
      contact_number: p.contact_number || '',
      challan_prefix: p.challan_prefix || ''
    };
  });
  return { active_location: (user && user.active_location) || 'AT_PLANT_CHANDISAR', profiles };
}

// Only manager/contact/prefix are editable — `location` identifies the record and is immutable.
async function updateLocationProfile(userId, location, { manager_name, contact_number, challan_prefix }) {
  if (!LOCATIONS.includes(location)) throw new HttpError(400, 'Unknown location');
  const update = {};
  if (manager_name !== undefined) update.manager_name = String(manager_name).trim();
  if (contact_number !== undefined) update.contact_number = String(contact_number).trim();
  if (challan_prefix !== undefined) update.challan_prefix = String(challan_prefix).trim();

  const profile = await LocationProfile.findOneAndUpdate(
    { user_id: userId, location },
    { $set: update, $setOnInsert: { user_id: userId, location } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return {
    message: 'Location profile saved',
    profile: {
      location: profile.location,
      manager_name: profile.manager_name || '',
      contact_number: profile.contact_number || '',
      challan_prefix: profile.challan_prefix || ''
    }
  };
}

// Phase 20: one shared Save commits all three location profiles together.
async function updateLocationProfilesBatch(userId, profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) throw new HttpError(400, 'A profiles array is required');
  for (const p of profiles) {
    if (!p || !LOCATIONS.includes(p.location)) throw new HttpError(400, `Unknown location "${p && p.location}"`);
  }
  for (const p of profiles) {
    await updateLocationProfile(userId, p.location, p);
  }
  return { message: 'All location profiles saved', saved: profiles.map(p => p.location) };
}

// Switching only changes UI defaults — it never touches Bill/Cylinder/Customer data.
async function setActiveLocation(userId, location) {
  if (!LOCATIONS.includes(location)) throw new HttpError(400, 'Unknown location');
  await User.updateOne({ _id: userId }, { active_location: location });
  return { message: 'Active location updated', active_location: location };
}

async function updateAccount(userId, { name, phone, email, current_password }) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');

  if (typeof name === 'string' && name.trim()) user.name = name.trim();
  if (typeof phone === 'string') user.phone = phone.trim();

  let emailChanged = false;
  if (email && email.toLowerCase() !== user.email) {
    // 400 (not 401) — a missing/wrong password here must never trigger the client's
    // expired-session auto-logout.
    if (!current_password || !(await user.comparePassword(current_password))) {
      throw new HttpError(400, 'Current password is required to change email');
    }
    const exists = await User.findOne({ email: email.toLowerCase(), _id: { $ne: user._id } });
    if (exists) throw new HttpError(400, 'That email is already in use');
    user.email = email.toLowerCase();
    user.email_verified = false; // a new address must be verified again
    emailChanged = true;
  }

  // Phase 20: the bootstrap Trusted Person mirrors Account Information — sync BEFORE saving
  // the user so a conflict (e.g. email already on the list) aborts the whole save.
  await require('./trustedPeople.service').syncBootstrap(userId, {
    name: user.name,
    email: emailChanged ? user.email : undefined
  });

  await user.save();
  return { message: 'Profile updated', name: user.name, email: user.email, phone: user.phone || '' };
}

async function changePassword(userId, { current_password, new_password, confirm_password }) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');

  // 400 (not 401) — a wrong current password must never trigger the client's
  // expired-session auto-logout; the session itself is fine.
  if (!current_password || !(await user.comparePassword(current_password))) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  if (!STRONG_PASSWORD(new_password)) {
    throw new HttpError(400, 'New password must be at least 8 characters and include a number and a special character');
  }
  if (new_password !== confirm_password) {
    throw new HttpError(400, 'New password and confirmation do not match');
  }

  user.password = new_password; // hashed by pre-save hook
  await user.save();
  return { message: 'Password changed successfully' };
}

async function getBusinessProfile(userId) {
  let profile = await BusinessProfile.findOne({ user_id: userId });
  if (!profile) profile = { business_name: '', business_address: '', business_phone: '', gst_number: '', logo: '' };
  return {
    business_name: profile.business_name || '',
    business_address: profile.business_address || '',
    business_phone: profile.business_phone || '',
    gst_number: profile.gst_number || '',
    logo: profile.logo || ''
  };
}

async function updateBusinessProfile(userId, { business_name, business_address, business_phone, gst_number, logo }) {
  const update = {};
  if (business_name !== undefined) update.business_name = business_name;
  if (business_address !== undefined) update.business_address = business_address;
  if (business_phone !== undefined) update.business_phone = business_phone;
  if (gst_number !== undefined) update.gst_number = gst_number;
  if (logo !== undefined) update.logo = logo;

  const profile = await BusinessProfile.findOneAndUpdate(
    { user_id: userId },
    { $set: update, $setOnInsert: { user_id: userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return { message: 'Business profile saved', profile };
}

async function logoutAll(userId) {
  await User.updateOne({ _id: userId }, { $inc: { token_version: 1 } });
  return { message: 'All sessions logged out' };
}

// Phase 21: deletion needs BOTH the password AND an owner-only step-up approval — several
// people may know the shared password, but only the bootstrap owner can authorize this.
async function deleteAccount(userId, password, stepUpToken) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  // 400 (not 401) — a wrong password must never trigger the client's expired-session auto-logout.
  if (!password || !(await user.comparePassword(password))) {
    throw new HttpError(400, 'Incorrect password');
  }
  await require('./stepup.service').requireOwnerStepUp(userId, stepUpToken, 'Deleting the account');

  await Promise.all([
    Customer.deleteMany({ user_id: userId }),
    Bill.deleteMany({ user_id: userId }),
    Payment.deleteMany({ user_id: userId }),
    Cylinder.deleteMany({ user_id: userId }),
    BusinessProfile.deleteMany({ user_id: userId }),
    LocationProfile.deleteMany({ user_id: userId }),
    RentalCharge.deleteMany({ user_id: userId }),
    require('../models/FillingLogEntry').deleteMany({ user_id: userId }),
    require('../models/LocationPcStock').deleteMany({ user_id: userId }),
    require('../models/TrustedPerson').deleteMany({ user_id: userId }),
    require('../models/OtpToken').deleteMany({ user_id: userId }),
    require('../models/AuditLog').deleteMany({ user_id: userId })
  ]);
  await User.deleteOne({ _id: userId });

  return { message: 'Your account has been deleted.' };
}

// Streams a ZIP of xlsx files for all of the user's data directly to `res`.
// Intentional exception to "services never touch req/res": headers/streaming must be set
// up before the archive starts writing, so this function owns the response for this route.
async function exportData(userId, res) {
  const uid = userId;

  const [customers, bills, payments, cylinders] = await Promise.all([
    Customer.find({ user_id: uid }).lean(),
    Bill.find({ user_id: uid }).populate('customer_id').populate('line_items.gas_type_id').populate('line_items.cylinder_size_id').lean(),
    Payment.find({ user_id: uid }).populate('customer_id').populate('bill_id').lean(),
    Cylinder.find({ user_id: uid }).lean()
  ]);

  // --- Build row sets ---
  const customerRows = customers.map((c, i) => ({
    'Sr.': i + 1,
    'Company Name': c.company_name || '',
    'Contact Person': c.contact_person || '',
    'Primary Contact': c.phone_primary || '',
    'Telephone': c.phone_alternate || '',
    'Additional Contacts': (c.additional_contacts || []).map(x => x.name ? `${x.name}: ${x.number}` : x.number).join('; '),
    'Address': c.address || '',
    'GST Number': c.gst_number || '',
    'Holding Limit': c.holding_limit || 0,
    'Security Deposit': c.security_deposit || 0,
    'Created': ddmmyyyy(c.createdAt)
  }));

  const billRows = [];
  bills.forEach(b => {
    (b.line_items || []).forEach(li => {
      billRows.push({
        'Bill No': b.bill_number || '',
        'Date': ddmmyyyy(b.bill_date),
        'Customer': b.customer_id ? b.customer_id.company_name : '',
        'Type': b.transaction_type || '',
        'Challan No': b.challan_no || '',
        'Direction': li.direction || '',
        'Gas Type': li.gas_type_name || (li.gas_type_id ? li.gas_type_id.gas_type_name : ''),
        'Size': li.size_label || (li.cylinder_size_id ? li.cylinder_size_id.size_label : ''),
        'Serial No': li.serial_number || '',
        'Qty': li.quantity || 0,
        'Rate': li.rate || 0,
        'Amount': li.amount || 0
      });
    });
  });

  const paymentRows = payments.map((p, i) => ({
    'Sr.': i + 1,
    'Receipt No': p.receipt_number || '',
    'Date': ddmmyyyy(p.date),
    'Customer': p.customer_id ? p.customer_id.company_name : '',
    'Bill No': p.bill_id ? p.bill_id.bill_number : '',
    'Challan No': p.challan_no || '',
    'Amount Received': p.amount_received || 0,
    'Discount': p.discount || 0,
    'Net': (p.amount_received || 0) - (p.discount || 0),
    'Mode': p.payment_mode === 'ONLINE' || p.payment_mode === 'UPI' ? 'UPI Transfer' : (p.payment_mode || ''),
    'Cheque No': p.payment_mode === 'CHEQUE' ? (p.cheque_number || '') : '',
    'UPI Txn ID': (p.payment_mode === 'UPI' || p.payment_mode === 'ONLINE') ? (p.upi_transaction_id || '') : '',
    'Remarks': p.remarks || ''
  }));

  const cylinderRows = cylinders.map((c, i) => ({
    'Sr.': i + 1,
    'Rotational No': c.rotational_number || '',
    'Physical No': c.physical_number || '',
    'Gas Type': c.gas_type || '',
    'Capacity': c.capacity || '',
    'Location': c.location || '',
    'Stock State': c.stock_state === 'AT_CUSTOMER' ? 'At Customer' : 'In Stock'
  }));

  // Aging report: at-customer cylinders with latest GIVEN details + days out
  const inRotation = cylinders.filter(c => c.stock_state === 'AT_CUSTOMER');
  const agingRows = inRotation.map((c, i) => {
    // Find the most recent GIVEN line for this rotational number not yet returned
    let latest = null;
    bills.forEach(b => {
      (b.line_items || []).forEach(li => {
        if (li.direction === 'GIVEN' && li.serial_number === c.rotational_number && !li.returned_via) {
          if (!latest || new Date(b.bill_date) > new Date(latest.date)) {
            latest = { date: b.bill_date, customer: b.customer_id ? b.customer_id.company_name : '', bill: b.bill_number, challan: b.challan_no, rate: li.rate };
          }
        }
      });
    });
    const daysOut = latest ? Math.floor((Date.now() - new Date(latest.date).getTime()) / 86400000) : '';
    return {
      'Sr.': i + 1,
      'Rotational No': c.rotational_number || '',
      'Physical No': c.physical_number || '',
      'Gas Type': c.gas_type || '',
      'Capacity': c.capacity || '',
      'Customer': latest ? latest.customer : '(no given record)',
      'Date Given': latest ? ddmmyyyy(latest.date) : '',
      'Days Out': daysOut,
      'Bill No': latest ? latest.bill : '',
      'Challan No': latest ? (latest.challan || '') : ''
    };
  });

  const sheetToBuffer = (rows, sheetName) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: 'No records' }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Data').substring(0, 31));
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };

  const stamp = ddmmyyyy(new Date()).replace(/\//g, '-');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="CylinderPro_Export_${stamp}.zip"`);

  const archive = createArchive({ zlib: { level: 9 } });
  archive.on('error', (err) => { throw err; });
  archive.pipe(res);

  archive.append(sheetToBuffer(customerRows, 'Customers'), { name: 'Customers.xlsx' });
  archive.append(sheetToBuffer(billRows, 'Transactions'), { name: 'Transactions.xlsx' });
  archive.append(sheetToBuffer(paymentRows, 'Payments'), { name: 'Payments.xlsx' });
  archive.append(sheetToBuffer(cylinderRows, 'Cylinders'), { name: 'Cylinder_Inventory.xlsx' });
  archive.append(sheetToBuffer(agingRows, 'Aging'), { name: 'Aging_Report.xlsx' });

  await archive.finalize();
}

module.exports = {
  getAccount,
  updateAccount,
  changePassword,
  getBusinessProfile,
  updateBusinessProfile,
  getLocationProfiles,
  updateLocationProfile,
  updateLocationProfilesBatch,
  setActiveLocation,
  logoutAll,
  deleteAccount,
  exportData
};
