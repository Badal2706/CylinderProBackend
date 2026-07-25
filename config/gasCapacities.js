// Single backend source of truth for the gas-type → valid-capacity catalog.
// MUST stay in sync with GAS_CAPACITIES in frontend/app.js (same data, same order).
// Required by config/mongodb.js (seed) and the bulk-import routes (validation), so there is
// exactly ONE backend copy.
const GAS_CAPACITIES = {
  'Oxygen':            ['1.5 m3', '6 m3', '7 m3', '10 m3'],
  'Nitrogen':          ['1.5 m3', '6 m3', '7 m3', '10 m3'],
  'Argon':             ['7 m3', '10 m3'],
  'CO2':               ['2 KG', '4.5 KG', '6 KG', '9 KG', '15 KG', '18 KG', '22 KG', '30 KG', '45 KG'],
  'Nitrous Oxide':     ['2 KG', '17 m3', '30 KG'],
  'Acetylene':         ['7 m3'],
  'Helium':            ['1.5 m3', '7 m3', '10 m3'],
  'HCL':               ['5 KG', '32 KG'],
  'MIX':               ['7 m3']
};

// Map-parameterized normalizers (Phase 10): the runtime catalog lives in the GasCapacity
// collection and is user-managed, so callers pass the live { gas: [sizes] } map. The static
// GAS_CAPACITIES above remains only as the first-run seed (config/mongodb.js, migratePhase10).
function normalizeGasTypeIn(map, name) {
  const k = String(name == null ? '' : name).trim().toLowerCase();
  const hit = Object.keys(map).find(g => g.toLowerCase() === k);
  return hit || null;
}

function normalizeCapacityIn(map, gasCanonical, cap) {
  if (!gasCanonical || !map[gasCanonical]) return null;
  const target = String(cap == null ? '' : cap).trim().toLowerCase().replace(/\s+/g, ' ');
  return map[gasCanonical].find(c => c.toLowerCase().replace(/\s+/g, ' ') === target) || null;
}

// Static-map convenience wrappers (legacy callers / seeding).
function normalizeGasType(name) { return normalizeGasTypeIn(GAS_CAPACITIES, name); }
function normalizeCapacity(gasCanonical, cap) { return normalizeCapacityIn(GAS_CAPACITIES, gasCanonical, cap); }

module.exports = { GAS_CAPACITIES, normalizeGasType, normalizeCapacity, normalizeGasTypeIn, normalizeCapacityIn };
