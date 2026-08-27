// Phase GEN-B1 — the single place that answers "which locations does this user have, what are they
// called, and which one fills cylinders".
//
// Everything that used to read the static LOCATIONS / LOCATION_LABELS arrays, or compare against
// the literal 'AT_PLANT_CHANDISAR', goes through here instead.
//
// NO CROSS-REQUEST CACHING. Every call reads LocationProfile fresh. A cache here would serve a
// stale label or a stale filling-location the moment someone edits a location, and a stale
// filling-location silently misclassifies transfers in DSR and Stock Summary — a wrong report is
// far more expensive than the query it would save. (Callers may hold the result for the duration
// of one request; that is fine and is what the report services do.)
const LocationProfile = require('../models/LocationProfile');
const { LOCATIONS, LOCATION_LABELS } = require('../config/locations');

/**
 * @returns {Promise<{codes: string[], labels: Object<string,string>, fillingLocationCode: string|null, profiles: Array}>}
 *   codes  - every location code configured for this user, in stable order
 *   labels - code -> display name
 *   fillingLocationCode - the site that fills, or null when the user has none configured
 */
// The pre-GEN-B1 world: three fixed sites with Chandisar filling. Used ONLY as a fallback for an
// account whose registry has not been created or migrated yet — see below.
const LEGACY_FILLING = 'AT_PLANT_CHANDISAR';

async function getUserLocations(userId) {
  const profiles = await LocationProfile.find({ user_id: userId }).lean();

  // ── Backward compatibility, deliberately narrow ──
  // No records at all (a brand-new account before profile.service seeds it, or a test fixture):
  // fall back to the seed list read-only, so a read path never has to write.
  if (!profiles.length) {
    const labels = {};
    LOCATIONS.forEach(l => { labels[l] = LOCATION_LABELS[l] || l; });
    return { codes: [...LOCATIONS], labels, fillingLocationCode: LEGACY_FILLING, profiles: [] };
  }

  const codes = [];
  const labels = {};
  let fillingLocationCode = null;

  for (const p of profiles) {
    if (!p.location) continue;
    codes.push(p.location);
    labels[p.location] = p.label || LOCATION_LABELS[p.location] || p.location;
    if (p.is_filling_location) fillingLocationCode = p.location;
  }

  // Records exist but NONE carries the is_filling_location field: this account predates the
  // GEN-B1 migration. Anchor on the historical filling site so reports keep classifying transfers
  // exactly as they did before, instead of silently marking every transfer "unclassified" during
  // the window between deploying the code and running the migration.
  //
  // The test is "field absent", not "field false" — once the migration has run, an explicit
  // `false` everywhere means the user genuinely has NO filling location, and that choice is
  // respected: fillingLocationCode stays null and transfers become unclassified by design.
  const migrated = profiles.some(p => p.is_filling_location !== undefined && p.is_filling_location !== null);
  if (!fillingLocationCode && !migrated && codes.includes(LEGACY_FILLING)) {
    fillingLocationCode = LEGACY_FILLING;
  }

  // Stable order: the seed sites first in their historical order, then anything added later,
  // alphabetically. Reports and dropdowns depend on a predictable order.
  codes.sort((a, b) => {
    const ia = LOCATIONS.indexOf(a), ib = LOCATIONS.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  return { codes, labels, fillingLocationCode, profiles };
}

/** Is `code` one of this user's configured locations? Blank/missing is always false. */
async function isValidLocation(userId, code) {
  if (!code || typeof code !== 'string') return false;
  const { codes } = await getUserLocations(userId);
  return codes.includes(code);
}

/** Is `code` the user's filling location? False when they have none configured. */
async function isFillingLocation(userId, code) {
  if (!code) return false;
  const { fillingLocationCode } = await getUserLocations(userId);
  return !!fillingLocationCode && fillingLocationCode === code;
}

/**
 * Display name for a code. Falls back to the code itself rather than printing "undefined" —
 * a location that no longer exists must still render readably in old history text.
 */
async function labelFor(userId, code) {
  if (!code) return '';
  const { labels } = await getUserLocations(userId);
  return labels[code] || LOCATION_LABELS[code] || code;
}

module.exports = { getUserLocations, isValidLocation, isFillingLocation, labelFor };
