const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const GasCapacity = require('../models/GasCapacity');
const Cylinder = require('../models/Cylinder');
const HttpError = require('../utils/HttpError');

// Every catalog belongs to ONE account (24 Sep 2026). Each function here takes the account id first
// and reads and writes only that account's entries -- including the in-use guards, which count only
// that account's cylinders. Before, the catalogs were one global set, so one tenant's "Helium" was
// in everyone's dropdowns and one tenant's delete removed a size from everyone.

// Fixed business ordering for gas types (Phase 14): these first, in exactly this order,
// then any user-added types in the order they were originally created.
const FIXED_GAS_ORDER = ['Oxygen', 'Nitrogen', 'Argon', 'CO2', 'Nitrous Oxide', 'Acetylene', 'Helium', 'HCL'];
function orderGasTypes(docs) {
  const rank = (name) => {
    const i = FIXED_GAS_ORDER.indexOf(name);
    return i === -1 ? FIXED_GAS_ORDER.length : i;
  };
  return [...docs].sort((a, b) => {
    const ra = rank(a.gas_type_name), rb = rank(b.gas_type_name);
    if (ra !== rb) return ra - rb;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0); // original add order
  });
}

async function listGasTypes(userId) {
  return orderGasTypes(await GasType.find({ user_id: userId, is_active: true }));
}

async function createGasType(userId, gas_type_name) {
  if (!gas_type_name) {
    throw new HttpError(400, 'Gas type name is required');
  }
  const gasType = new GasType({ user_id: userId, gas_type_name });
  await gasType.save();
  // Each gas type carries its own scoped size list (Phase 10).
  await GasCapacity.updateOne(
    { user_id: userId, gas_type_name },
    { $setOnInsert: { user_id: userId, gas_type_name, sizes: [] } },
    { upsert: true }
  );
  return { gas_type_id: gasType._id, message: 'Gas type added successfully' };
}

async function listCylinderSizes(userId) {
  return CylinderSize.find({ user_id: userId, is_active: true }).sort('size_label');
}

async function createCylinderSize(userId, size_label) {
  if (!size_label) {
    throw new HttpError(400, 'Size label is required');
  }
  const size = new CylinderSize({ user_id: userId, size_label });
  await size.save();
  return { size_id: size._id, message: 'Cylinder size added successfully' };
}

// ─── Guarded deletes (Phase 9) ───
// A master value can only be removed while none of THIS account's cylinders still references it.
// Historical bills are safe regardless: their line items carry gas/size name snapshots (Phase 9).
async function deleteGasType(userId, gasTypeId) {
  const gasType = await GasType.findOne({ _id: gasTypeId, user_id: userId });
  if (!gasType) throw new HttpError(404, 'Gas type not found');
  const inUse = await Cylinder.countDocuments({ user_id: userId, gas_type: gasType.gas_type_name });
  if (inUse > 0) {
    throw new HttpError(400, `Cannot remove "${gasType.gas_type_name}" — ${inUse} cylinder(s) in inventory still use it.`);
  }
  await GasType.deleteOne({ _id: gasType._id, user_id: userId });
  await GasCapacity.deleteOne({ user_id: userId, gas_type_name: gasType.gas_type_name });
  return { message: `Gas type "${gasType.gas_type_name}" removed` };
}

// ─── Per-gas scoped size catalog (Phase 10) ───
// The GasCapacity collection (gas → its own sizes) is the runtime source of truth for
// which sizes each gas offers. Returns a plain { gasName: [sizes] } map, lazily creating
// an empty entry for any active gas type that doesn't have one yet.
async function getGasCapacities(userId) {
  const [gasesRaw, caps] = await Promise.all([
    GasType.find({ user_id: userId, is_active: true }),
    GasCapacity.find({ user_id: userId })
  ]);
  const gases = orderGasTypes(gasesRaw); // fixed business order (Phase 14) — drives every dropdown
  const byGas = {}; caps.forEach(c => { byGas[c.gas_type_name] = c.sizes; });
  const map = {};
  for (const g of gases) {
    if (byGas[g.gas_type_name] === undefined) {
      await GasCapacity.updateOne(
        { user_id: userId, gas_type_name: g.gas_type_name },
        { $setOnInsert: { user_id: userId, gas_type_name: g.gas_type_name, sizes: [] } },
        { upsert: true }
      );
      byGas[g.gas_type_name] = [];
    }
    map[g.gas_type_name] = byGas[g.gas_type_name];
  }
  return map;
}

async function addSizeToGas(userId, gasName, size_label) {
  const label = String(size_label || '').trim();
  if (!label) throw new HttpError(400, 'Size label is required');
  const gas = await GasType.findOne({ user_id: userId, gas_type_name: gasName, is_active: true });
  if (!gas) throw new HttpError(404, `Gas type "${gasName}" not found`);
  await GasCapacity.updateOne(
    { user_id: userId, gas_type_name: gas.gas_type_name },
    { $addToSet: { sizes: label } },
    { upsert: true }
  );
  // Bill line items reference sizes by id — make sure a flat CylinderSize doc exists.
  await CylinderSize.updateOne(
    { user_id: userId, size_label: label },
    { $setOnInsert: { user_id: userId, size_label: label, is_active: true } },
    { upsert: true }
  );
  return { message: `Size "${label}" added to ${gas.gas_type_name}` };
}

// Per-pair delete guard (Phase 10): only cylinders of THIS gas at THIS size block removal —
// another gas using the same size label is irrelevant. The flat CylinderSize doc is kept
// (other gases and historical line-item ids may still reference it).
async function removeSizeFromGas(userId, gasName, size_label) {
  const label = String(size_label || '').trim();
  if (!label) throw new HttpError(400, 'Size label is required');
  const inUse = await Cylinder.countDocuments({ user_id: userId, gas_type: gasName, capacity: label });
  if (inUse > 0) {
    throw new HttpError(400, `Cannot remove "${label}" from ${gasName} — ${inUse} ${gasName} cylinder(s) in inventory use it.`);
  }
  const r = await GasCapacity.updateOne({ user_id: userId, gas_type_name: gasName }, { $pull: { sizes: label } });
  if (!r.matchedCount) throw new HttpError(404, `Gas type "${gasName}" not found`);
  return { message: `Size "${label}" removed from ${gasName}` };
}

async function deleteCylinderSize(userId, sizeId) {
  const size = await CylinderSize.findOne({ _id: sizeId, user_id: userId });
  if (!size) throw new HttpError(404, 'Cylinder size not found');
  const inUse = await Cylinder.countDocuments({ user_id: userId, capacity: size.size_label });
  if (inUse > 0) {
    throw new HttpError(400, `Cannot remove "${size.size_label}" — ${inUse} cylinder(s) in inventory still use it.`);
  }
  await CylinderSize.deleteOne({ _id: size._id, user_id: userId });
  return { message: `Cylinder size "${size.size_label}" removed` };
}

// ─── A new account's starting catalog ───
// Each account gets its own copy of the defaults in config/gasCapacities.js, written once at
// signup. It replaces the old boot-time seed, which upserted ONE global catalog on every server
// start. After this the account owns its catalog outright: nothing re-adds a default it deletes.
//
// Deliberately the config defaults, not another account's current catalog -- copying a live
// account's list would hand every new client that business's own additions.
//
// `session` lets signup write this inside the transaction that creates the account, so an account
// can never exist without a catalog (its dropdowns would be empty).
async function seedDefaultCatalog(userId, { session = null } = {}) {
  const { GAS_CAPACITIES } = require('../config/gasCapacities');
  const gases = Object.keys(GAS_CAPACITIES);
  const sizes = [...new Set(Object.values(GAS_CAPACITIES).flat())];
  await GasType.insertMany(gases.map(g => ({ user_id: userId, gas_type_name: g, is_active: true })), { session });
  await GasCapacity.insertMany(gases.map(g => ({ user_id: userId, gas_type_name: g, sizes: GAS_CAPACITIES[g] })), { session });
  await CylinderSize.insertMany(sizes.map(sz => ({ user_id: userId, size_label: sz, is_active: true })), { session });
  return { gastypes: gases.length, gascapacities: gases.length, cylindersizes: sizes.length };
}

module.exports = {
  listGasTypes, createGasType, listCylinderSizes, createCylinderSize,
  deleteGasType, deleteCylinderSize,
  getGasCapacities, addSizeToGas, removeSizeFromGas,
  seedDefaultCatalog
};
