const mongoose = require('mongoose');
const Cylinder = require('../models/Cylinder');
const User = require('../models/User');
const { createCylinder } = require('../services/cylinder.service');

const TEST_DB = 'mongodb://localhost:27017/cylinder_management_test_cyl';

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

describe('Cylinder — giving validation', () => {
  let userId;

  beforeAll(async () => {
    const user = await User.create({
      name: 'Cylinder Test User',
      email: 'cyltest@test.com',
      password: 'Test1234!'
    });
    userId = user._id;
  });

  test('creating a cylinder without under_maintenance defaults to false', async () => {
    const result = await createCylinder(userId, {
      rotational_number: 'TEST-001',
      gas_type: 'Nitrogen',
      capacity: '7 m3',
      location: 'AT_PLANT_CHANDISAR',
      stock_state: 'IN_STOCK'
    });

    const cyl = await Cylinder.findById(result.cylinder_id);
    expect(cyl.stock_state).toBe('IN_STOCK');
    expect(cyl.under_maintenance).toBe(false);
    expect(cyl.maintenance_since).toBeNull();
  });

  test('creating a cylinder with under_maintenance=true sets the flag and date', async () => {
    const result = await createCylinder(userId, {
      rotational_number: 'TEST-002',
      gas_type: 'Nitrogen',
      capacity: '7 m3',
      location: 'AT_PLANT_CHANDISAR',
      stock_state: 'IN_STOCK',
      under_maintenance: true
    });

    const cyl = await Cylinder.findById(result.cylinder_id);
    expect(cyl.under_maintenance).toBe(true);
    expect(cyl.maintenance_since).toBeInstanceOf(Date);
  });

  test('IN_STOCK cylinder without maintenance is givable (bill validation simulation)', async () => {
    const cyl = await Cylinder.findOne({ user_id: userId, rotational_number: 'TEST-001' });

    const stock = cyl.stock_state;
    const isSwapRoundTrip = false;

    const stockOk = stock === 'IN_STOCK' || isSwapRoundTrip;
    expect(stockOk).toBe(true);

    const maintenanceOk = !cyl.under_maintenance;
    expect(maintenanceOk).toBe(true);

    const billLocation = 'AT_PLANT_CHANDISAR';
    const locationOk = cyl.location === billLocation;
    expect(locationOk).toBe(true);

    expect(stockOk && maintenanceOk && locationOk).toBe(true);
  });

  test('UNDER_MAINTENANCE cylinder is NOT givable', async () => {
    const cyl = await Cylinder.findOne({ user_id: userId, rotational_number: 'TEST-002' });
    expect(cyl.under_maintenance).toBe(true);
    expect(!cyl.under_maintenance).toBe(false);
  });

  test('IN_STOCK cylinder at different location is NOT givable from another site', async () => {
    const cyl = await Cylinder.findOne({ user_id: userId, rotational_number: 'TEST-001' });
    expect(cyl.location).toBe('AT_PLANT_CHANDISAR');
    expect(cyl.location === 'AT_PALANPUR_OFFICE').toBe(false);
  });

  test('bill form cylinder pool correctly filters: IN_STOCK + not maintenance + matching location', async () => {
    await createCylinder(userId, {
      rotational_number: 'TEST-003',
      gas_type: 'Oxygen',
      capacity: '10 m3',
      location: 'AT_PLANT_CHANDISAR',
      stock_state: 'IN_STOCK'
    });
    await createCylinder(userId, {
      rotational_number: 'TEST-004',
      gas_type: 'Oxygen',
      capacity: '10 m3',
      location: 'AT_PALANPUR_OFFICE',
      stock_state: 'IN_STOCK'
    });

    const allCylinders = await Cylinder.find({ user_id: userId }).lean();
    const billLocation = 'AT_PLANT_CHANDISAR';
    const pool = allCylinders.filter(c =>
      c.stock_state === 'IN_STOCK' && !c.under_maintenance && c.location === billLocation
    );

    expect(pool.some(c => c.rotational_number === 'TEST-001')).toBe(true);
    expect(pool.some(c => c.rotational_number === 'TEST-002')).toBe(false);
    expect(pool.some(c => c.rotational_number === 'TEST-003')).toBe(true);
    expect(pool.some(c => c.rotational_number === 'TEST-004')).toBe(false);
  });
});
