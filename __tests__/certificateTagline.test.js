// The Quality Certificate's tagline is its own field, fully decoupled from the challan's
// products_lines: writing either one never changes the other, and neither falls back to the other.
const mongoose = require('mongoose');

const DB = 'mongodb://127.0.0.1:27017/cylinder_management_test_certtag_' + Date.now();

let User, BusinessProfile, profile, V;
let uid;

beforeAll(async () => {
  process.env.MONGODB_URI = DB;
  await mongoose.connect(DB);
  User = require('../models/User');
  BusinessProfile = require('../models/BusinessProfile');
  profile = require('../services/profile.service');
  V = require('../validators/schemas');
  const u = await User.create({ name: 'Cert', email: 'certtag@example.invalid', password: 'x' });
  uid = u._id;
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

describe('certificate_tagline_lines', () => {
  test('a new account reads an empty certificate tagline', async () => {
    const b = await profile.getBusinessProfile(uid);
    expect(b.certificate_tagline_lines).toEqual([]);
  });

  test('saving the challan line leaves the certificate tagline empty — no fallback', async () => {
    await profile.updateBusinessProfile(uid, { products_lines: ['Mfg.: Challan line'] });
    const b = await profile.getBusinessProfile(uid);
    expect(b.products_lines).toEqual(['Mfg.: Challan line']);
    expect(b.certificate_tagline_lines).toEqual([]);
  });

  test('saving the certificate tagline leaves the challan line untouched', async () => {
    await profile.updateBusinessProfile(uid, { certificate_tagline_lines: ['  Cert LINE one ', 'two'] });
    const b = await profile.getBusinessProfile(uid);
    expect(b.certificate_tagline_lines).toEqual(['  Cert LINE one ', 'two']);   // exactly as typed
    expect(b.products_lines).toEqual(['Mfg.: Challan line']);
  });

  test('a save that omits the field keeps it', async () => {
    await profile.updateBusinessProfile(uid, { business_name: 'Somebody' });
    const b = await profile.getBusinessProfile(uid);
    expect(b.certificate_tagline_lines).toEqual(['  Cert LINE one ', 'two']);
  });

  test('trailing blank lines are dropped, a blank between lines is kept', async () => {
    await profile.updateBusinessProfile(uid, { certificate_tagline_lines: ['a', '', 'b', '  ', ''] });
    const b = await profile.getBusinessProfile(uid);
    expect(b.certificate_tagline_lines).toEqual(['a', '', 'b']);
  });

  test('clearing it stores an empty list', async () => {
    await profile.updateBusinessProfile(uid, { certificate_tagline_lines: [] });
    const raw = await BusinessProfile.findOne({ user_id: uid }).lean();
    expect(raw.certificate_tagline_lines).toEqual([]);
    expect(raw.products_lines).toEqual(['Mfg.: Challan line']);
  });

  test('the validator accepts the field and bounds it', () => {
    expect(V.businessProfile.safeParse({ certificate_tagline_lines: ['x'] }).success).toBe(true);
    expect(V.businessProfile.safeParse({ certificate_tagline_lines: ['x'.repeat(301)] }).success).toBe(false);
    expect(V.businessProfile.safeParse({ certificate_tagline_lines: Array(21).fill('x') }).success).toBe(false);
  });
});
