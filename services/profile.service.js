const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const archiverLib = require('archiver');
// Create a zip Archiver across archiver major versions. v7 and earlier export a callable factory
// (`archiver('zip', opts)`). v8 is ESM-first and, under CommonJS require(), yields a namespace
// object `{ Archiver, JsonArchive, TarArchive, ZipArchive }` — NOT callable and with no `.create`
// (the previous code assumed a `.create` that never existed, which is what threw
// "archiverLib.create is not a function"). For v8 the archive is built with `new Archiver('zip')`.
const createArchive = (opts) => {
  if (typeof archiverLib === 'function') return archiverLib('zip', opts);                 // v7 and earlier
  if (archiverLib && typeof archiverLib.Archiver === 'function') return new archiverLib.Archiver('zip', opts); // v8
  if (archiverLib && typeof archiverLib.default === 'function') return archiverLib.default('zip', opts);       // esm interop
  if (archiverLib && typeof archiverLib.create === 'function') return archiverLib.create('zip', opts);         // just in case
  throw new Error('Unsupported "archiver" version: no known way to create a zip archive.');
};
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
const { LOCATIONS, LOCATION_LABELS, DEFAULT_NEW_ACCOUNT_LOCATION } = require('../config/locations');
const locationService = require('./location.service');

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
    // A user who has never picked a site operates as their account's first one. Resolved from
    // their own registry — the literal that used to sit here named one client's plant.
    active_location: user.active_location || await locationService.defaultLocationCode(userId),
    member_since: user.createdAt,
    last_login: user.last_login || null
  };
}

// ─── Location profiles (Phase 2, reshaped in GEN-C) ───
// Seeds ONE generic site into a brand-new account, and never touches an account that already has
// a registry.
//
// It used to top up any "missing" location from config/locations.js, which had two faults. It
// handed every new client Guru Industries' three sites — someone else's plants, which they could
// rename but not delete (F-07). And because the check was per-location rather than
// all-or-nothing, changing the seed list would have silently ADDED a location to every existing
// account, including the live one.
// ─── Has a site been put to work yet? ───
//
// A location's NAME is freely editable right up until the site starts being used, and frozen
// afterwards. The reason is the same one that freezes a bill number once it is printed: the name
// is stamped onto challans, cylinder history sentences ("Raju bhai at Chandisar Plant changed…")
// and every report header. Renaming a site that already has records would silently rewrite what
// those documents say happened, at a site that no longer goes by that name.
//
// "In use" means exactly what an operator would mean by it: a transaction has been recorded there,
// or a cylinder is sitting there. The location CODE is permanent regardless (R83) — this is only
// about the display name.
async function locationUsage(userId, code) {
  const Bill = require('../models/Bill');
  const Cylinder = require('../models/Cylinder');
  const [bills, cylinders] = await Promise.all([
    Bill.countDocuments({ user_id: userId,
      $or: [{ location: code }, { from_location: code }, { to_location: code }] }),
    Cylinder.countDocuments({ user_id: userId, location: code })
  ]);
  return { bills, cylinders, in_use: bills > 0 || cylinders > 0 };
}

async function getLocationProfiles(userId) {
  const existing = await LocationProfile.find({ user_id: userId });

  // All-or-nothing on purpose: an account with ANY registry is left exactly as it is.
  if (!existing.length) {
    try {
      existing.push(await LocationProfile.create({
        user_id: userId,
        location: DEFAULT_NEW_ACCOUNT_LOCATION.code,
        label: DEFAULT_NEW_ACCOUNT_LOCATION.label,
        // Something must fill, or DSR, Stock Summary and the filling log have no anchor.
        is_filling_location: true,
        // …and something must service faulty cylinders, or none could ever be flagged. A one-site
        // account is both; either can be moved independently afterwards.
        is_maintenance_location: true
      }));
    } catch (e) { if (e.code !== 11000) throw e; }   // tolerate a race on (user_id, location)
  }
  const user = await User.findById(userId).select('active_location');
  // Ordered by the registry, not by the static array — a location added later still appears.
  // RESOLVED, not raw. getUserLocations applies the pre-migration fallbacks (an account whose
  // records carry no is_filling_location field at all still reports its historical filling site).
  // Reading the raw document fields here instead meant the settings screen — and now every
  // heading and tooltip that names the filling or maintenance site — showed "none" on an account
  // that had simply not had the GEN-B1 migration run against it yet, while the reports it feeds
  // were using the fallback and disagreeing with it.
  const { codes, labels, fillingLocationCode, maintenanceLocationCode } =
    await locationService.getUserLocations(userId);
  const profiles = await Promise.all(codes.map(async (l) => {
    const p = existing.find(x => x.location === l) || {};
    // The UI needs to know whether the name is still editable, and WHY it is not — "3 bills" is
    // an answer an operator can act on; a disabled box with no explanation is not.
    const usage = await locationUsage(userId, l);
    return {
      location: l,
      label: labels[l] || l,
      is_filling_location: l === fillingLocationCode,
      is_maintenance_location: l === maintenanceLocationCode,
      manager_name: p.manager_name || '',
      contact_number: p.contact_number || '',
      challan_prefix: p.challan_prefix || '',
      renameable: !usage.in_use,
      usage: { bills: usage.bills, cylinders: usage.cylinders }
    };
  }));
  return {
    active_location: (user && user.active_location) || codes[0] || '',
    profiles
  };
}

// ─── Phase GEN-B2: reassigning which location fills ───
//
// Moving the filling flag is TWO writes (clear the old, set the new) and the partial unique index
// forbids the intermediate state where both are true. So the order is forced: clear first, then
// set. A crash between them leaves the user with ZERO filling locations — degraded (transfers go
// unclassified) but never corrupt, and self-healing on retry.
//
// A transaction removes even that window, so we use one wherever the deployment supports it.
// Production Atlas is a replica set and does. A plain local mongod is standalone and does NOT —
// so this falls back rather than making the feature untestable on a developer machine.
const TX_UNSUPPORTED = /does not support (retryable writes|transactions)|Transaction numbers are only allowed|IllegalOperation|replica set member or mongos/i;

async function applyFillingSwap(userId, location, session) {
  const opts = session ? { session } : {};
  // Clear first: the unique index would reject a moment where two rows are flagged.
  await LocationProfile.updateMany(
    { user_id: userId, is_filling_location: true, location: { $ne: location } },
    { $set: { is_filling_location: false } }, opts
  );
  await LocationProfile.updateOne(
    { user_id: userId, location },
    { $set: { is_filling_location: true } }, opts
  );
}

async function setFillingLocation(userId, location) {
  const current = (await locationService.getUserLocations(userId)).fillingLocationCode;
  if (current === location) return;                       // already the filling site — nothing to do

  let session;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => { await applyFillingSwap(userId, location, session); });
    return;
  } catch (e) {
    if (!TX_UNSUPPORTED.test(e.message || '')) throw e;
    // Standalone mongod (local dev): fall back to the ordered pair of writes described above.
    console.warn('setFillingLocation: transactions unavailable on this deployment — ' +
                 'falling back to ordered writes (clear old, then set new).');
  } finally {
    if (session) session.endSession();
  }

  try {
    await applyFillingSwap(userId, location);
  } catch (e) {
    // Best effort: if setting the new one failed we may have left nobody flagged. Put the
    // previous one back so the account is never worse off than before the attempt.
    if (current) {
      try {
        await LocationProfile.updateOne({ user_id: userId, location: current }, { $set: { is_filling_location: true } });
      } catch { /* leave it to the user to re-pick; zero filling locations is a legal state */ }
    }
    throw e;
  }
}

// The maintenance site moves by exactly the same two-write dance as the filling site, and for the
// same reason: the partial unique index forbids the moment where two rows are flagged. Kept as a
// separate pair rather than parameterising setFillingLocation, because the recovery path names the
// flag it is restoring and a generic version reads worse than the duplication saves.
async function applyMaintenanceSwap(userId, location, session) {
  const opts = session ? { session } : {};
  await LocationProfile.updateMany(
    { user_id: userId, is_maintenance_location: true, location: { $ne: location } },
    { $set: { is_maintenance_location: false } }, opts
  );
  await LocationProfile.updateOne(
    { user_id: userId, location },
    { $set: { is_maintenance_location: true } }, opts
  );
}

async function setMaintenanceLocation(userId, location) {
  const current = (await locationService.getUserLocations(userId)).maintenanceLocationCode;
  if (current === location) return;

  let session;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => { await applyMaintenanceSwap(userId, location, session); });
    return;
  } catch (e) {
    if (!TX_UNSUPPORTED.test(e.message || '')) throw e;
    console.warn('setMaintenanceLocation: transactions unavailable on this deployment — ' +
                 'falling back to ordered writes (clear old, then set new).');
  } finally {
    if (session) session.endSession();
  }

  try {
    await applyMaintenanceSwap(userId, location);
  } catch (e) {
    if (current) {
      try {
        await LocationProfile.updateOne({ user_id: userId, location: current }, { $set: { is_maintenance_location: true } });
      } catch { /* zero maintenance locations is a legal state; the user re-picks */ }
    }
    throw e;
  }
}

// Turn a human label into a permanent, unique code for this user. The code is what every Cylinder,
// Bill and CylinderHistory row will reference forever (R83), so it is derived once at creation and
// never regenerated when the label is later edited.
async function generateLocationCode(userId, label) {
  const slug = String(label || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'LOCATION';
  const base = `AT_${slug}`.slice(0, 60);
  const { codes } = await locationService.getUserLocations(userId);
  const taken = new Set(codes);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new HttpError(400, 'Could not generate a unique code for that location name');
}

// Only manager/contact/prefix/label/filling-flag are editable — `location` identifies the record
// and is immutable (R83).
async function updateLocationProfile(userId, location, { manager_name, contact_number, challan_prefix, label, is_filling_location, is_maintenance_location }) {
  // Validated against THIS user's registry, which is what replaces the schema enum removed in
  // GEN-B1. Seeding runs first so a brand-new account still resolves its three sites.
  await getLocationProfiles(userId);
  if (!(await locationService.isValidLocation(userId, location))) throw new HttpError(400, 'Unknown location');

  const update = {};
  if (manager_name !== undefined) update.manager_name = String(manager_name).trim();
  if (contact_number !== undefined) update.contact_number = String(contact_number).trim();
  if (challan_prefix !== undefined) update.challan_prefix = String(challan_prefix).trim();
  if (label !== undefined) {
    const l = String(label).trim();
    if (!l) throw new HttpError(400, 'Location name cannot be blank');
    // Enforced HERE, not only in the UI: a disabled input is a courtesy, the rule is the server's.
    // Re-sending the SAME name is not a rename — the settings form posts every card on every save,
    // so a locked site must still be able to have its manager or challan prefix edited.
    const current = await LocationProfile.findOne({ user_id: userId, location }).select('label').lean();
    const currentLabel = (current && current.label) || '';
    if (l !== currentLabel) {
      const usage = await locationUsage(userId, location);
      if (usage.in_use) {
        const parts = [];
        if (usage.bills) parts.push(`${usage.bills} transaction${usage.bills === 1 ? '' : 's'}`);
        if (usage.cylinders) parts.push(`${usage.cylinders} cylinder${usage.cylinders === 1 ? '' : 's'}`);
        throw new HttpError(400,
          `"${currentLabel}" cannot be renamed — it already has ${parts.join(' and ')}. ` +
          'The name is printed on challans and written into cylinder history, so it is fixed once ' +
          'the site is in use. Add a new location instead.');
      }
    }
    update.label = l;
  }

  // The filling flag is NOT a plain field write — moving it has to clear the previous holder in
  // the same breath, or the unique index rejects the update. Done before the $set below so a
  // failed swap aborts the whole save.
  if (is_filling_location === true) {
    await setFillingLocation(userId, location);
  } else if (is_filling_location === false) {
    // Explicitly standing down: allowed, and leaves the user with no filling location (R85).
    await LocationProfile.updateOne({ user_id: userId, location }, { $set: { is_filling_location: false } });
  }

  // Same treatment for the workshop flag, for the same index reason.
  if (is_maintenance_location === true) {
    await setMaintenanceLocation(userId, location);
  } else if (is_maintenance_location === false) {
    await LocationProfile.updateOne({ user_id: userId, location }, { $set: { is_maintenance_location: false } });
  }

  // `label` is required, so an upsert must always carry one — otherwise a race that inserts here
  // would fail validation. But it may only appear in ONE operator: naming it in both $set and
  // $setOnInsert makes MongoDB reject the whole write with "Updating the path 'label' would create
  // a conflict at 'label'". That made EVERY rename fail, which is why the location name looked
  // un-editable even though the endpoint accepted the field.
  const onInsert = { user_id: userId, location };
  if (update.label === undefined) onInsert.label = LOCATION_LABELS[location] || location;

  const profile = await LocationProfile.findOneAndUpdate(
    { user_id: userId, location },
    { $set: update, $setOnInsert: onInsert },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return {
    message: 'Location profile saved',
    profile: {
      location: profile.location,
      label: profile.label || location,
      is_filling_location: !!profile.is_filling_location,
      is_maintenance_location: !!profile.is_maintenance_location,
      manager_name: profile.manager_name || '',
      contact_number: profile.contact_number || '',
      challan_prefix: profile.challan_prefix || ''
    }
  };
}

// Phase 20: one shared Save commits all three location profiles together.
async function updateLocationProfilesBatch(userId, profiles) {
  if (!Array.isArray(profiles) || profiles.length === 0) throw new HttpError(400, 'A profiles array is required');
  await getLocationProfiles(userId);   // seed first so a fresh account validates
  for (const p of profiles) {
    if (!p || !(await locationService.isValidLocation(userId, p.location))) {
      throw new HttpError(400, `Unknown location "${p && p.location}"`);
    }
  }
  // Caught here rather than letting the per-location loop below apply them in turn, where the
  // last one would silently win.
  if (profiles.filter(p => p.is_filling_location === true).length > 1) {
    throw new HttpError(400, 'Only one location can be the filling location');
  }
  if (profiles.filter(p => p.is_maintenance_location === true).length > 1) {
    throw new HttpError(400, 'Only one location can be the maintenance location');
  }
  for (const p of profiles) {
    await updateLocationProfile(userId, p.location, p);
  }
  return { message: 'All location profiles saved', saved: profiles.map(p => p.location) };
}

// Phase GEN-B2: add a site. The code is generated once and permanent; everything else is editable
// afterwards. Creating a location changes nothing about existing cylinders, bills or reports — it
// only makes a new value selectable.
async function createLocationProfile(userId, { label, is_filling_location, is_maintenance_location, manager_name, contact_number, challan_prefix }) {
  const name = String(label || '').trim();
  if (!name) throw new HttpError(400, 'A location name is required');

  await getLocationProfiles(userId);   // make sure the seed sites exist before we check for clashes

  const { codes, labels } = await locationService.getUserLocations(userId);
  if (codes.some(c => String(labels[c] || '').trim().toLowerCase() === name.toLowerCase())) {
    throw new HttpError(400, `You already have a location called "${name}"`);
  }

  const code = await generateLocationCode(userId, name);

  let profile;
  try {
    profile = await LocationProfile.create({
      user_id: userId,
      location: code,
      label: name,
      is_filling_location: false,          // set via the swap below, never inline
      is_maintenance_location: false,      // ditto
      manager_name: String(manager_name || '').trim(),
      contact_number: String(contact_number || '').trim(),
      challan_prefix: String(challan_prefix || '').trim()
    });
  } catch (e) {
    if (e.code === 11000) throw new HttpError(400, 'That location already exists');
    throw e;
  }

  if (is_filling_location === true) {
    await setFillingLocation(userId, code);
    profile.is_filling_location = true;
  }
  if (is_maintenance_location === true) {
    await setMaintenanceLocation(userId, code);
    profile.is_maintenance_location = true;
  }

  return {
    message: `Location "${name}" added`,
    profile: {
      location: profile.location,
      label: profile.label,
      is_filling_location: !!profile.is_filling_location,
      is_maintenance_location: !!profile.is_maintenance_location,
      manager_name: profile.manager_name || '',
      contact_number: profile.contact_number || '',
      challan_prefix: profile.challan_prefix || ''
    }
  };
}

// Switching only changes UI defaults — it never touches Bill/Cylinder/Customer data.
async function setActiveLocation(userId, location) {
  await getLocationProfiles(userId);   // seed first so a fresh account validates
  if (!(await locationService.isValidLocation(userId, location))) throw new HttpError(400, 'Unknown location');
  await User.updateOne({ _id: userId }, { active_location: location });
  return { message: 'Active location updated', active_location: location };
}

async function updateAccount(userId, { name, phone, email, current_password }) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');

  if (typeof name === 'string' && name.trim()) user.name = name.trim();
  if (typeof phone === 'string') user.phone = phone.trim();

  // Phase 26: this endpoint no longer changes the email. An address is only ever written to
  // the account after a 6-digit code sent to THAT address has been entered correctly, which is
  // what requestEmailChange/confirmEmailChange below implement. Guarding here rather than
  // silently ignoring the field means a stale client can't quietly skip verification.
  const emailChanged = false;
  if (email && email.toLowerCase() !== user.email) {
    throw new HttpError(400,
      'Changing your email needs verification — use the "Verify new email" step so we can send a code to the new address.');
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

// ─── Phase 26: email change, gated on proving control of the NEW inbox ───
//
// Step 1. Validate the change and send a code TO THE NEW ADDRESS. Nothing is written to the
// user document here — not the email, not email_verified, and no authenticator rotation is
// started. Abandoning at this point therefore leaves the account exactly as it was.
// The returned token carries the pending address so the client can't substitute a different
// one between the two calls.
async function requestEmailChange(userId, { email, current_password }) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');

  const next = String(email || '').toLowerCase().trim();
  if (!next) throw new HttpError(400, 'A new email address is required');
  if (next === user.email) throw new HttpError(400, 'That is already your account email');

  // 400 (not 401) — a wrong password must never trip the client's expired-session auto-logout.
  if (!current_password || !(await user.comparePassword(current_password))) {
    throw new HttpError(400, 'Current password is required to change email');
  }
  const exists = await User.findOne({ email: next, _id: { $ne: user._id } });
  if (exists) throw new HttpError(400, 'That email is already in use');

  const otp = require('./otp.service');
  await otp.sendOtp({
    userId, purpose: 'USER_EMAIL_VERIFY', email: next,
    context: `change your CylinderPro account email to ${next}`
  });

  const pending_token = jwt.sign(
    { id: String(userId), purpose: 'email_change', email: next },
    process.env.JWT_SECRET,
    { expiresIn: 900 }
  );
  return {
    message: `We sent a 6-digit code to ${next}. Enter it to confirm the change.`,
    pending_email: next,
    pending_token
  };
}

// Step 2. Correct code → the email is persisted, and only then does the authenticator rotation
// begin (Phase 25 behaviour from here on: the OLD TOTP secret stays valid until the user
// confirms the new QR, so 2FA is never disabled).
async function confirmEmailChange(userId, { pending_token, code }) {
  let payload;
  try {
    payload = jwt.verify(pending_token, process.env.JWT_SECRET);
  } catch {
    throw new HttpError(400, 'This email change expired — start again.');
  }
  if (payload.purpose !== 'email_change' || String(payload.id) !== String(userId)) {
    throw new HttpError(400, 'Invalid email-change token');
  }

  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  const previousEmail = user.email;

  // Throws on a wrong/expired/exhausted code — the email stays unwritten.
  const otp = require('./otp.service');
  await otp.verifyOtp({ userId, purpose: 'USER_EMAIL_VERIFY', email: payload.email, code });

  // Re-check uniqueness: the address could have been claimed while the code was in flight.
  const exists = await User.findOne({ email: payload.email, _id: { $ne: user._id } });
  if (exists) throw new HttpError(400, 'That email is already in use');

  user.email = payload.email;
  user.email_verified = true; // proven by the code we just checked

  // The bootstrap Trusted Person mirrors Account Information — sync before saving so a
  // conflict aborts the whole change rather than half-applying it.
  // verified:true — the code we just checked was sent to THIS address, so the bootstrap entry
  // must not have its authenticator wiped; the rotation below stages the replacement instead.
  await require('./trustedPeople.service')
    .syncBootstrap(userId, { name: user.name, email: user.email, verified: true });
  await user.save();

  // The licence this account was created with names the address it may create an account for. Keep
  // it on the address now in use, or a deleted account could only be re-created at the OLD one.
  // history[] keeps the address each binding was made under. A failure here must not undo a verified
  // email change — it is logged, and the licence keeps its previous address.
  try {
    await require('./licence.service').syncEmailForUser(userId, user.email);
  } catch (e) {
    console.error('Licence email sync after email change failed:', e.message);
  }

  let totp_rotation = null;
  try {
    totp_rotation = await require('./totp.service')
      .beginRotationForAccountEmail(userId, previousEmail, user.email);
  } catch (e) {
    // A rotation failure must not undo a verified email change; surface it in the log so the
    // user can rotate manually from Trusted People instead.
    console.error('TOTP rotation after email change failed:', e.message);
  }

  return {
    message: 'Email verified and updated.',
    name: user.name, email: user.email, phone: user.phone || '',
    totp_rotation
  };
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
  // A user with no profile yet gets blanks, never a hardcoded business identity (Phase GEN-A).
  if (!profile) {
    profile = {
      business_name: '', business_address: '', business_phone: '', gst_number: '',
      certification_line: '', business_email: '', products_line: '', products_lines: [], contact_lines: [],
      certificate_tagline_lines: [],
      certificate_prefix: '', footer_contact_line: '',
      logo_scale: 100, logo: '', fy_reset_numbering: false
    };
  }

  // Phase GEN-C: the financial-year choice, and whether it can still be changed. The deadline is
  // this account's OWN first 1 April, measured from when it was created — a client who buys the
  // software later gets their own full window rather than inheriting someone else's.
  const numbering = require('./numbering.service');
  const user = await User.findById(userId).select('createdAt').lean();
  const activatedAt = (user && user.createdAt) || new Date();
  const lockDate = numbering.firstAprilAfter(activatedAt);
  const locked = numbering.isFyChoiceLocked(activatedAt);

  return {
    business_name: profile.business_name || '',
    business_address: profile.business_address || '',
    business_phone: profile.business_phone || '',
    gst_number: profile.gst_number || '',
    certification_line: profile.certification_line || '',
    business_email: profile.business_email || '',
    // RESOLVED, not raw. An account whose migration has not run yet still has its tagline in the
    // old single-string field; reading it here means the letterhead is already correct before the
    // migration, and the migration only makes it explicit. Once products_lines has any entry it
    // wins outright — including an empty array the user saved deliberately.
    products_lines: Array.isArray(profile.products_lines) && profile.products_lines.length
      ? profile.products_lines.map(String)
      : (profile.products_line ? [String(profile.products_line)] : []),
    contact_lines: Array.isArray(profile.contact_lines) ? profile.contact_lines.map(String) : [],
    // Certificate-only. NO fallback to products_lines: the whole point of the field is that the two
    // documents stop being coupled, and a fallback would couple them again for any account that
    // leaves this blank. scripts/migrateCertificateTagline.js copies the old value across once.
    certificate_tagline_lines: Array.isArray(profile.certificate_tagline_lines)
      ? profile.certificate_tagline_lines.map(String) : [],
    // F-11
    certificate_prefix: profile.certificate_prefix || '',
    footer_contact_line: profile.footer_contact_line || '',
    // Normalised on the way out so the settings form and every print path can rely on the shape
    // existing, even for a profile saved before this field did.
    print_notes: {
      heading: (profile.print_notes && profile.print_notes.heading) || '',
      body:    (profile.print_notes && profile.print_notes.body) || '',
      footer:  (profile.print_notes && profile.print_notes.footer) || '',
      show_on: {
        challan:            !!(profile.print_notes && profile.print_notes.show_on && profile.print_notes.show_on.challan),
        holding_statement:  !!(profile.print_notes && profile.print_notes.show_on && profile.print_notes.show_on.holding_statement),
        purity_certificate: !!(profile.print_notes && profile.print_notes.show_on && profile.print_notes.show_on.purity_certificate),
        reports:            !!(profile.print_notes && profile.print_notes.show_on && profile.print_notes.show_on.reports)
      }
    },
    logo_scale: Number(profile.logo_scale) > 0 ? Number(profile.logo_scale) : 100,
    logo: profile.logo || '',
    // GEN-C numbering
    fy_reset_numbering: !!profile.fy_reset_numbering,
    fy_choice_locked: locked,
    fy_lock_date: lockDate,
    account_code: '' // never exposed: it is a backend identity, not something an operator sees
  };
}

async function updateBusinessProfile(userId, {
  business_name, business_address, business_phone, gst_number,
  certification_line, business_email, products_line, products_lines, contact_lines, logo_scale, logo,
  certificate_tagline_lines,
  certificate_prefix, footer_contact_line, print_notes,
  fy_reset_numbering
}) {
  const update = {};

  // ─── Phase GEN-C: the financial-year numbering choice ───
  // Changeable ONLY until this account has lived through its first 1 April. After that the
  // series has a year of real documents behind it, and flipping the rule would either duplicate
  // numbers already issued or silently skip a year — so it is frozen permanently.
  if (fy_reset_numbering !== undefined && fy_reset_numbering !== null) {
    const numbering = require('./numbering.service');
    const user = await User.findById(userId).select('createdAt').lean();
    const activatedAt = (user && user.createdAt) || new Date();
    const current = await BusinessProfile.findOne({ user_id: userId }).select('fy_reset_numbering').lean();
    const wanted = !!fy_reset_numbering;

    // Re-saving the same value is not a change — the Settings form posts the whole card, so a
    // locked account must still be able to edit its letterhead.
    if (wanted !== !!(current && current.fy_reset_numbering)) {
      if (numbering.isFyChoiceLocked(activatedAt)) {
        const on = new Date(numbering.firstAprilAfter(activatedAt)).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
        throw new HttpError(400,
          `The financial-year numbering choice was locked on ${on}, the first 1 April after this account was created. ` +
          'It cannot be changed once a full year of bills has been issued under it.');
      }
      update.fy_reset_numbering = wanted;
    }
  }
  if (business_name !== undefined) update.business_name = business_name;
  if (business_address !== undefined) update.business_address = business_address;
  if (business_phone !== undefined) update.business_phone = business_phone;
  if (gst_number !== undefined) update.gst_number = gst_number;
  if (certification_line !== undefined) update.certification_line = certification_line;
  if (business_email !== undefined) update.business_email = business_email;
  if (products_line !== undefined) update.products_line = products_line;
  // Same rule as contact_lines: trailing blanks are dropped so an empty box never prints an empty
  // line, but a blank BETWEEN two filled lines is kept as a deliberate spacer.
  if (products_lines !== undefined) {
    const arr = (Array.isArray(products_lines) ? products_lines : []).map(v => String(v == null ? '' : v));
    while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
    update.products_lines = arr;
  }
  if (certificate_tagline_lines !== undefined) {
    const arr = (Array.isArray(certificate_tagline_lines) ? certificate_tagline_lines : []).map(v => String(v == null ? '' : v));
    while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
    update.certificate_tagline_lines = arr;
  }
  // Trailing blank boxes are dropped so an unused site never prints an empty line, but a blank
  // BETWEEN two filled sites is kept — that is a deliberate spacer.
  if (contact_lines !== undefined) {
    const arr = (Array.isArray(contact_lines) ? contact_lines : []).map(v => String(v == null ? '' : v));
    while (arr.length && !arr[arr.length - 1].trim()) arr.pop();
    update.contact_lines = arr;
  }
  // Clamped rather than rejected: a stray value must never make the logo vanish or blow the
  // header past one page.
  if (logo_scale !== undefined) {
    const n = Number(logo_scale);
    update.logo_scale = Number.isFinite(n) ? Math.min(400, Math.max(25, Math.round(n))) : 100;
  }
  // F-11. The prefix is trimmed because it is concatenated into a document number — a trailing
  // space would print as "GI /TC/...". The footer line is stored verbatim like every other
  // letterhead field, so a deliberate layout survives.
  if (certificate_prefix !== undefined) update.certificate_prefix = String(certificate_prefix == null ? '' : certificate_prefix).trim();
  if (footer_contact_line !== undefined) update.footer_contact_line = footer_contact_line;

  // Printed notes block. Written as a whole object so a partial save can never leave the flags
  // pointing at text that has since changed. Text is stored VERBATIM apart from trimming trailing
  // whitespace: it is Gujarati prose the proprietor typed, and "tidying" it would corrupt it.
  if (print_notes !== undefined && print_notes !== null) {
    const n = print_notes || {};
    const so = n.show_on || {};
    const cap = (v, max) => String(v == null ? '' : v).replace(/\s+$/, '').slice(0, max);
    update.print_notes = {
      heading: cap(n.heading, 120),
      body:    cap(n.body, 4000),
      footer:  cap(n.footer, 1000),
      show_on: {
        challan:            !!so.challan,
        holding_statement:  !!so.holding_statement,
        purity_certificate: !!so.purity_certificate,
        reports:            !!so.reports
      }
    };
  }
  if (logo !== undefined) update.logo = logo;

  const profile = await BusinessProfile.findOneAndUpdate(
    { user_id: userId },
    { $set: update, $setOnInsert: { user_id: userId } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return { message: 'Business profile saved', profile };
}

// Phase GEN-C: confirm the account password on its own, so the UI can reject a wrong one
// BEFORE sending the operator through an owner-approval flow. Previously the password was only
// checked at the very end, so a typo meant completing the whole approval and only then being
// told. Deliberately reveals nothing beyond valid/invalid.
async function verifyPassword(userId, password) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, 'User not found');
  // 400, not 401 — a wrong password must never trip the client's expired-session auto-logout.
  if (!password || !(await user.comparePassword(password))) {
    throw new HttpError(400, 'Incorrect password');
  }
  return { verified: true };
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

  // The purge list is DERIVED from backup.service.COLLECTIONS — the same list the backup and
  // restore paths walk — plus the login/approval records a backup deliberately excludes. It used
  // to be hand-written here, and had silently fallen behind: CylinderHistory, Counter and
  // RestoreJob were all missed, so a deleted account left thousands of orphaned history rows and
  // its bill counter behind. Deriving it means a new collection cannot be forgotten again.
  const backupSvc = require('./backup.service');
  const targets = backupSvc.COLLECTIONS
    .filter(c => c.scope === 'user')
    .map(c => c.model)
    .concat(['TrustedPerson', 'OtpToken', 'RestoreJob']);

  const removed = {};
  for (const name of targets) {
    const r = await require(`../models/${name}`).deleteMany({ user_id: userId });
    if (r.deletedCount) removed[name] = r.deletedCount;
  }

  // Free the licence this account was created with, so the client can sign up again with the same
  // number. A licence left pointing at a deleted user is permanently stuck: the unique index still
  // counts it as taken, and nothing would ever release it. Done BEFORE the User row goes, purely
  // so the lookup key still exists.
  let licence_released = null;
  try {
    licence_released = await require('./licence.service').releaseForUser(userId);
  } catch (e) { console.error('Licence release failed:', e.message); }

  await User.deleteOne({ _id: userId });

  return { message: 'Your account has been deleted.', removed, licence_released };
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
    // "Net" is the cash figure alone, matching the Payments screen and the Excel export.
    'Net': p.amount_received || 0,
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
  locationUsage,
  getLocationProfiles,
  createLocationProfile,
  updateLocationProfile,
  updateLocationProfilesBatch,
  setActiveLocation,
  logoutAll,
  deleteAccount,
  exportData,
  verifyPassword,
  requestEmailChange,
  confirmEmailChange
};
