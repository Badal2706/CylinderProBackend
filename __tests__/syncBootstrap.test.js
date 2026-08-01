const mongoose = require('mongoose');
const TrustedPerson = require('../models/TrustedPerson');
const User = require('../models/User');
const { syncBootstrap, createBootstrap } = require('../services/trustedPeople.service');

const TEST_DB = 'mongodb://localhost:27017/cylinder_management_test';

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
});

afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});

describe('syncBootstrap — TOTP re-enrollment on email change', () => {
  let userId;

  beforeAll(async () => {
    const user = await User.create({
      name: 'Test User',
      email: 'original@test.com',
      password: 'Test1234!'
    });
    userId = user._id;
  });

  test('email change resets totp_enabled, totp_secret, and is_active', async () => {
    const boot = await createBootstrap(userId, { name: 'Test User', email: 'original@test.com' });
    boot.email_verified = true;
    boot.is_active = true;
    boot.totp_secret = 'FAKE_SECRET_ABC123';
    boot.totp_enabled = true;
    await boot.save();

    // Verify TOTP is active before email change
    const before = await TrustedPerson.findById(boot._id);
    expect(before.totp_enabled).toBe(true);
    expect(before.totp_secret).toBe('FAKE_SECRET_ABC123');
    expect(before.is_active).toBe(true);
    expect(before.email_verified).toBe(true);

    // Change the email via syncBootstrap
    await syncBootstrap(userId, { name: 'Test User', email: 'newemail@test.com' });

    // Verify TOTP is reset after email change
    const after = await TrustedPerson.findById(boot._id);
    expect(after.email).toBe('newemail@test.com');
    expect(after.email_verified).toBe(false);
    expect(after.totp_enabled).toBe(false);
    expect(after.totp_secret).toBe('');
    expect(after.is_active).toBe(false);
  });

  test('name-only change does NOT reset TOTP', async () => {
    const boot = await TrustedPerson.findOne({ user_id: userId, is_bootstrap: true });
    boot.email_verified = true;
    boot.is_active = true;
    boot.totp_secret = 'ANOTHER_SECRET';
    boot.totp_enabled = true;
    await boot.save();

    await syncBootstrap(userId, { name: 'Updated Name' });

    const after = await TrustedPerson.findById(boot._id);
    expect(after.name).toBe('Updated Name');
    expect(after.totp_enabled).toBe(true);
    expect(after.totp_secret).toBe('ANOTHER_SECRET');
    expect(after.is_active).toBe(true);
  });

  test('same email does NOT reset TOTP', async () => {
    const boot = await TrustedPerson.findOne({ user_id: userId, is_bootstrap: true });
    boot.totp_secret = 'KEEP_THIS';
    boot.totp_enabled = true;
    boot.email_verified = true;
    boot.is_active = true;
    await boot.save();

    await syncBootstrap(userId, { email: boot.email });

    const after = await TrustedPerson.findById(boot._id);
    expect(after.totp_enabled).toBe(true);
    expect(after.totp_secret).toBe('KEEP_THIS');
    expect(after.is_active).toBe(true);
  });
});
