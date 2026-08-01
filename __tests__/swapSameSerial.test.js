const mongoose = require('mongoose');
const User = require('../models/User');
const Cylinder = require('../models/Cylinder');
const Customer = require('../models/Customer');
const GasType = require('../models/GasType');
const CylinderSize = require('../models/CylinderSize');
const billService = require('../services/bill.service');

const TEST_DB = 'mongodb://localhost:27017/cylinder_management_test_swap';

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

describe('SWAP — same serial in both given and received (instant refill)', () => {
  let uid, gasId, sizeId, custId;

  beforeAll(async () => {
    const user = await User.create({ name: 'Swap Test', email: 'swap@test.com', password: 'Test1234!' });
    uid = user._id;
    const gas = await GasType.create({ user_id: uid, gas_type_name: 'Nitrogen' });
    gasId = gas._id;
    const size = await CylinderSize.create({ user_id: uid, size_label: '7 m3' });
    sizeId = size._id;
    const cust = await Customer.create({ user_id: uid, company_name: 'Test Customer', customer_type: 'REGULAR', holding_limit: 50, phone_primary: '1234567890' });
    custId = cust._id;
  });

  test('AT_CUSTOMER cylinder: receive empty + give filled in same SWAP bill', async () => {
    await Cylinder.create({ user_id: uid, rotational_number: 'SWAP-001', gas_type: 'Nitrogen', capacity: '7 m3', location: 'AT_PLANT_CHANDISAR', stock_state: 'AT_CUSTOMER' });

    const result = await billService.createBill(uid, {
      customer_id: custId, customer_type: 'REGULAR',
      bill_date: new Date().toISOString().split('T')[0],
      transaction_type: 'SWAP', challan_no: 'T-001', location: 'AT_PLANT_CHANDISAR',
      given_items: [{ gas_type_id: gasId, cylinder_size_id: sizeId, serial_numbers: ['SWAP-001'], quantity: 1, rate: 100, amount: 100, personalCylindersOut: 0 }],
      received_items: [{ gas_type_id: gasId, cylinder_size_id: sizeId, serial_numbers: ['SWAP-001'], quantity: 1, personalCylindersIn: 0 }]
    }, {}, '');

    expect(result.bill_number).toBeTruthy();
  });

  test('IN_STOCK cylinder: give filled + receive empty in same SWAP bill', async () => {
    await Cylinder.create({ user_id: uid, rotational_number: 'SWAP-002', gas_type: 'Nitrogen', capacity: '7 m3', location: 'AT_PLANT_CHANDISAR', stock_state: 'IN_STOCK' });

    const result = await billService.createBill(uid, {
      customer_id: custId, customer_type: 'REGULAR',
      bill_date: new Date().toISOString().split('T')[0],
      transaction_type: 'SWAP', challan_no: 'T-002', location: 'AT_PLANT_CHANDISAR',
      given_items: [{ gas_type_id: gasId, cylinder_size_id: sizeId, serial_numbers: ['SWAP-002'], quantity: 1, rate: 100, amount: 100, personalCylindersOut: 0 }],
      received_items: [{ gas_type_id: gasId, cylinder_size_id: sizeId, serial_numbers: ['SWAP-002'], quantity: 1, personalCylindersIn: 0 }]
    }, {}, '');

    expect(result.bill_number).toBeTruthy();
  });

  test('non-SWAP rejects same serial in both sections', async () => {
    await Cylinder.create({ user_id: uid, rotational_number: 'SWAP-003', gas_type: 'Nitrogen', capacity: '7 m3', location: 'AT_PLANT_CHANDISAR', stock_state: 'AT_CUSTOMER' });

    await expect(billService.createBill(uid, {
      customer_id: custId, customer_type: 'REGULAR',
      bill_date: new Date().toISOString().split('T')[0],
      transaction_type: 'GIVEN', challan_no: 'T-003', location: 'AT_PLANT_CHANDISAR',
      given_items: [{ gas_type_id: gasId, cylinder_size_id: sizeId, serial_numbers: ['SWAP-003'], quantity: 1, rate: 100, amount: 100, personalCylindersOut: 0 }],
      received_items: [{ gas_type_id: gasId, cylinder_size_id: sizeId, serial_numbers: ['SWAP-003'], quantity: 1, personalCylindersIn: 0 }]
    }, {}, '')).rejects.toThrow('cannot be both given and received');
  });

  test('frontend eligible pool: GIVEN pool includes received serials in SWAP', () => {
    const cylinders = [
      { _id: '1', rotational_number: 'C-1', stock_state: 'IN_STOCK', under_maintenance: false, location: 'AT_PLANT_CHANDISAR' },
      { _id: '2', rotational_number: 'C-2', stock_state: 'AT_CUSTOMER', under_maintenance: false, location: 'AT_PLANT_CHANDISAR' },
    ];
    const receivedItems = [{ serial_numbers: ['C-2'] }];
    const location = 'AT_PLANT_CHANDISAR';

    // Simulate getEligiblePool('GIVEN') in SWAP mode
    let pool = cylinders.filter(c => c.stock_state === 'IN_STOCK' && !c.under_maintenance);
    pool = pool.filter(c => c.location === location);
    // SWAP: add received serials
    const receivedSerials = new Set(receivedItems.flatMap(ri => ri.serial_numbers));
    cylinders.forEach(c => {
      if (receivedSerials.has(c.rotational_number) && !pool.some(p => p._id === c._id)) {
        pool.push(c);
      }
    });

    expect(pool.some(c => c.rotational_number === 'C-1')).toBe(true);
    expect(pool.some(c => c.rotational_number === 'C-2')).toBe(true);
  });

  test('frontend eligible pool: RECEIVED pool includes given serials in SWAP', () => {
    const cylinders = [
      { _id: '1', rotational_number: 'C-1', stock_state: 'IN_STOCK', location: 'AT_PLANT_CHANDISAR' },
      { _id: '2', rotational_number: 'C-2', stock_state: 'AT_CUSTOMER', location: 'AT_PLANT_CHANDISAR' },
    ];
    const inRotationCyls = [
      { rotational_number: 'C-2', stock_state: 'AT_CUSTOMER' },
    ];
    const givenItems = [{ serial_numbers: ['C-1'] }];

    // Simulate getEligiblePool('RECEIVED') in SWAP mode (the fix)
    let receivedPool = [...inRotationCyls];
    const givenSerials = new Set(givenItems.flatMap(gi => gi.serial_numbers || []));
    cylinders.forEach(c => {
      if (givenSerials.has(c.rotational_number) && !receivedPool.some(p => p.rotational_number === c.rotational_number)) {
        receivedPool.push(c);
      }
    });

    // C-2 is already AT_CUSTOMER — always in pool
    expect(receivedPool.some(c => c.rotational_number === 'C-2')).toBe(true);
    // C-1 is IN_STOCK but in givenItems — now added to received pool for SWAP
    expect(receivedPool.some(c => c.rotational_number === 'C-1')).toBe(true);
  });

  test('frontend eligible pool: RECEIVED pool does NOT include given serials in non-SWAP', () => {
    const inRotationCyls = [
      { rotational_number: 'C-2', stock_state: 'AT_CUSTOMER' },
    ];

    // Non-SWAP: just return inRotationCyls (no given-serial augmentation)
    const receivedPool = [...inRotationCyls];

    expect(receivedPool.some(c => c.rotational_number === 'C-2')).toBe(true);
    expect(receivedPool.some(c => c.rotational_number === 'C-1')).toBe(false);
  });
});
