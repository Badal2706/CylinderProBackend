// Per-account catalogs (24 Sep 2026) — the tenancy guarantees, pinned.
//
// Before this change the gas/size catalogs were ONE global set: one account's "Helium" appeared in
// everyone's dropdowns, a delete removed a size from everyone, the delete guards counted every
// account's cylinders, and bill validation accepted any account's gas type id. Each property below
// is one of those, now held per account.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-production';

const mongoose = require('mongoose');
const User = require('../models/User');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const GasCapacity = require('../models/GasCapacity');
const Cylinder = require('../models/Cylinder');
const Customer = require('../models/Customer');
const LocationProfile = require('../models/LocationProfile');
const masters = require('../services/masters.service');
const billSvc = require('../services/bill.service');
const backup = require('../services/backup.service');
const N = require('../services/numbering.service');
const acct = require('../services/accountNumbering.service');
const stripInternalIds = require('../middleware/stripInternalIds');
const { GAS_CAPACITIES } = require('../config/gasCapacities');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_catalogs_${Date.now()}`;
const CH = 'AT_PLANT_CHANDISAR';
const GASES = Object.keys(GAS_CAPACITIES).length;
const SIZES = new Set(Object.values(GAS_CAPACITIES).flat()).size;

let A, B;

async function account(label) {
  const u = await User.create({ name: label, email: `${label}@catalog.test`, password: 'Test1234!' });
  await User.collection.updateOne({ _id: u._id }, { $set: { account_code: N.deriveAccountCode(u._id) } });
  await LocationProfile.create({ user_id: u._id, location: CH, label: 'Plant', is_filling_location: true });
  await masters.seedDefaultCatalog(u._id);
  acct._clearCache();
  return u;
}

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  // the per-account unique indexes are what make "two accounts may both have Oxygen" true
  await Promise.all([GasType.syncIndexes(), CylinderSize.syncIndexes(), GasCapacity.syncIndexes(), User.syncIndexes()]);
  A = await account('alpha');
  B = await account('beta');
});
afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

describe('each account has its own catalog', () => {
  test('signup seeding gives each account the full default set, and nothing else', async () => {
    for (const u of [A, B]) {
      expect(await GasType.countDocuments({ user_id: u._id })).toBe(GASES);
      expect(await GasCapacity.countDocuments({ user_id: u._id })).toBe(GASES);
      expect(await CylinderSize.countDocuments({ user_id: u._id })).toBe(SIZES);
    }
    expect(await GasType.countDocuments({ user_id: { $exists: false } })).toBe(0);
  });

  test('reads return only the caller\'s rows', async () => {
    const a = await masters.listGasTypes(A._id);
    const b = await masters.listGasTypes(B._id);
    expect(a).toHaveLength(GASES);
    expect(a.every(g => String(g.user_id) === String(A._id))).toBe(true);
    expect(b.every(g => String(g.user_id) === String(B._id))).toBe(true);
    expect(Object.keys(await masters.getGasCapacities(A._id))).toHaveLength(GASES);
  });

  test('one account adding a gas type does not add it to another', async () => {
    await masters.createGasType(A._id, 'Krypton');
    expect((await masters.listGasTypes(A._id)).map(g => g.gas_type_name)).toContain('Krypton');
    expect((await masters.listGasTypes(B._id)).map(g => g.gas_type_name)).not.toContain('Krypton');
    expect(Object.keys(await masters.getGasCapacities(B._id))).not.toContain('Krypton');
  });

  test('two accounts may use the same name; one account may not use it twice', async () => {
    await expect(masters.createGasType(B._id, 'Krypton')).resolves.toBeTruthy();
    await expect(masters.createGasType(A._id, 'Krypton')).rejects.toThrow(/duplicate key/i);
    await expect(masters.createCylinderSize(A._id, '99 m3')).resolves.toBeTruthy();
    await expect(masters.createCylinderSize(B._id, '99 m3')).resolves.toBeTruthy();
    await expect(masters.createCylinderSize(A._id, '99 m3')).rejects.toThrow(/duplicate key/i);
  });
});

describe('one account can never change another\'s catalog', () => {
  test('deleting another account\'s gas type by id is "not found", and it survives', async () => {
    const bOxygen = await GasType.findOne({ user_id: B._id, gas_type_name: 'Oxygen' }).lean();
    await expect(masters.deleteGasType(A._id, bOxygen._id)).rejects.toThrow(/not found/i);
    expect(await GasType.exists({ _id: bOxygen._id })).toBeTruthy();
  });

  test('deleting another account\'s size by id is "not found", and it survives', async () => {
    const bSize = await CylinderSize.findOne({ user_id: B._id, size_label: '7 m3' }).lean();
    await expect(masters.deleteCylinderSize(A._id, bSize._id)).rejects.toThrow(/not found/i);
    expect(await CylinderSize.exists({ _id: bSize._id })).toBeTruthy();
  });

  test('the in-use guard counts only the caller\'s own cylinders', async () => {
    // A holds an Oxygen 7 m3 cylinder; B holds none.
    await Cylinder.create({ user_id: A._id, rotational_number: 'SC-1', gas_type: 'Oxygen', capacity: '7 m3',
      location: CH, stock_state: 'IN_STOCK' });

    // A's own Oxygen is still in use by A's cylinder…
    const aOxy = await GasType.findOne({ user_id: A._id, gas_type_name: 'Oxygen' }).lean();
    await expect(masters.deleteGasType(A._id, aOxy._id)).rejects.toThrow(/still use it/i);
    await expect(masters.removeSizeFromGas(A._id, 'Oxygen', '7 m3')).rejects.toThrow(/use it/i);

    // …but A's cylinder no longer blocks B from editing B's catalog (it used to).
    await expect(masters.removeSizeFromGas(B._id, 'Oxygen', '7 m3')).resolves.toBeTruthy();
    expect((await masters.getGasCapacities(A._id)).Oxygen).toContain('7 m3');   // A untouched
    const bOxy = await GasType.findOne({ user_id: B._id, gas_type_name: 'Oxygen' }).lean();
    await expect(masters.deleteGasType(B._id, bOxy._id)).resolves.toBeTruthy();
    expect(await GasType.exists({ _id: aOxy._id })).toBeTruthy();                // A untouched
  });
});

describe('bills only accept the caller\'s own catalog ids', () => {
  test('a bill in one account cannot use another account\'s gas type id', async () => {
    const cust = await Customer.create({ user_id: A._id, company_name: 'A Customer', phone_primary: '9', holding_limit: 50 });
    const bGas = await GasType.findOne({ user_id: B._id, gas_type_name: 'Nitrogen' }).lean();
    const bSize = await CylinderSize.findOne({ user_id: B._id, size_label: '7 m3' }).lean();
    await expect(billSvc.createBill(A._id, {
      customer_id: String(cust._id), bill_date: new Date('2026-06-15T10:00:00+05:30'), transaction_type: 'GIVEN',
      challan_no: 'C1', location: CH,
      given_items: [{ gas_type_id: String(bGas._id), cylinder_size_id: String(bSize._id), quantity: 0, rate: 100, personalCylindersIn: 1 }]
    })).rejects.toThrow(/valid gas type and size/i);
  });
});

describe('a backup carries only its own account\'s catalog', () => {
  test('the catalogs are per-account in the backup manifest', async () => {
    for (const key of ['gastypes', 'gascapacities', 'cylindersizes']) {
      expect(backup.COLLECTIONS.find(c => c.key === key).scope).toBe('user');
    }
    expect(backup.COLLECTIONS.some(c => c.scope === 'global')).toBe(false);
  });

  test('the manifest counts only the exporting account\'s catalog rows', async () => {
    const m = await backup.buildManifest(A._id);
    expect(m.counts.gastypes).toBe(await GasType.countDocuments({ user_id: A._id }));
    expect(m.counts.gastypes).toBeLessThan(await GasType.countDocuments({}));
  });
});

describe('internal identity never reaches the browser', () => {
  // A minimal stand-in for an Express response.
  function fakeRes() {
    const headers = {};
    return {
      headers, sent: null,
      get(h) { return headers[h.toLowerCase()]; },
      set(h, v) { headers[h.toLowerCase()] = v; },
      send(body) { this.sent = body; return this; }
    };
  }

  test('account_code and every *_uid are removed at any depth; everything else is untouched', () => {
    const res = fakeRes();
    stripInternalIds({}, res, () => {});
    res.json({
      _id: 'b1', bill_number: '1A001', account_code: 'JRT2YGX5', bill_uid: 'JRT2YGX5-2627-1A001',
      line_items: [{ serial_number: 'R-1', rate: 100 }],
      data: [{ receipt_number: 'RCP-1', receipt_uid: 'x' }, { certificate_number: 'TC/1', certificate_uid: 'y' }],
      nested: { account_code: 'JRT2YGX5', keep: 0, empty: '', nothing: null }
    });
    expect(res.get('Content-Type')).toBe('application/json');
    const out = JSON.parse(res.sent);
    expect(res.sent).not.toMatch(/account_code|bill_uid|receipt_uid|certificate_uid|JRT2YGX5/);
    expect(out).toEqual({
      _id: 'b1', bill_number: '1A001',
      line_items: [{ serial_number: 'R-1', rate: 100 }],
      data: [{ receipt_number: 'RCP-1' }, { certificate_number: 'TC/1' }],
      nested: { keep: 0, empty: '', nothing: null }
    });
  });

  test('serialises exactly as res.json would for anything without those fields', () => {
    const res = fakeRes();
    stripInternalIds({}, res, () => {});
    const body = { a: 1, when: new Date('2026-09-24T00:00:00Z'), list: [1, 'two', null], deep: { x: { y: true } } };
    res.json(body);
    expect(res.sent).toBe(JSON.stringify(body));
  });
});
