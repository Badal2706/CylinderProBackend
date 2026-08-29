// Licence numbers — the scheme that replaced the single shared DEVELOPER_TOKEN.
//
// The properties worth pinning down are the ones that make a leaked licence worthless:
// it is bound to ONE email, it is spent while its account lives, and it comes back when that
// account is deleted. Plus the migration guarantee: the old token still works, so a deploy cannot
// lock production out of signup before a licence has been issued there.
process.env.NUMBERING_SALT = process.env.NUMBERING_SALT || 'test-salt-do-not-use-in-production';
process.env.DEVELOPER_TOKEN = 'legacy-token-for-tests';
process.env.SIGNUP_GATEKEEPER_EMAIL = 'gatekeeper@test.invalid';
// signupRequest signs a short-lived pending token; without this it throws before it gets there.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-production';

const mongoose = require('mongoose');

const User = require('../models/User');
const Licence = require('../models/Licence');
const licenceSvc = require('../services/licence.service');
const authSvc = require('../services/auth.service');
const profileSvc = require('../services/profile.service');

const TEST_DB = `mongodb://127.0.0.1:27017/cylinder_management_test_licence_${Date.now()}`;

const CLIENT = 'client@example.com';

beforeAll(async () => {
  await mongoose.connect(TEST_DB);
  await Licence.syncIndexes();
});
afterAll(async () => {
  await mongoose.connection.db.dropDatabase();
  await mongoose.connection.close();
});
afterEach(async () => {
  await Licence.deleteMany({});
  await User.deleteMany({});
});

describe('issuing', () => {
  test('returns a readable key and stores only its hash', async () => {
    const { key, licence_id } = await licenceSvc.issueLicence({ email: CLIENT, note: 'Acme' });

    expect(key).toMatch(/^CP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // The alphabet omits the characters people misread off a screen.
    expect(key).not.toMatch(/[O0I1]/);

    const stored = await Licence.findById(licence_id).lean();
    expect(stored.key_hash).toBe(Licence.hashKey(key));
    expect(JSON.stringify(stored)).not.toContain(key);   // the plaintext is nowhere in the document
    expect(stored.key_prefix).toBe(key.slice(0, 7));
    expect(stored.email).toBe(CLIENT);
  });

  test('the email is normalised, and a malformed one is refused', async () => {
    const { licence_id } = await licenceSvc.issueLicence({ email: '  Client@Example.COM ' });
    expect((await Licence.findById(licence_id).lean()).email).toBe(CLIENT);
    await expect(licenceSvc.issueLicence({ email: 'not-an-email' })).rejects.toThrow(/valid email/i);
  });

  test('two licences never collide', async () => {
    const keys = new Set();
    for (let i = 0; i < 25; i++) keys.add((await licenceSvc.issueLicence({ email: CLIENT })).key);
    expect(keys.size).toBe(25);
  });

  test('the listing never exposes a key', async () => {
    const { key } = await licenceSvc.issueLicence({ email: CLIENT, note: 'Acme' });
    const rows = await licenceSvc.listLicences();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(rows[0].key_prefix).toBe(key.slice(0, 7));
    expect(rows[0].in_use).toBe(false);
  });
});

describe('validation', () => {
  test('a correct licence for its own address passes', async () => {
    const { key } = await licenceSvc.issueLicence({ email: CLIENT });
    const res = await licenceSvc.validateForSignup(key, CLIENT);
    expect(res.legacy).toBe(false);
    expect(res.licence).toBeTruthy();
  });

  test('an unknown key is refused with a message that reveals nothing', async () => {
    await expect(licenceSvc.validateForSignup('CP-AAAA-BBBB-CCCC', CLIENT))
      .rejects.toThrow('Invalid licence number');
    await expect(licenceSvc.validateForSignup('total nonsense', CLIENT))
      .rejects.toThrow('Invalid licence number');
  });

  test('a licence is useless for a different address', async () => {
    const { key } = await licenceSvc.issueLicence({ email: CLIENT });
    const err = await licenceSvc.validateForSignup(key, 'someone.else@example.com').catch(e => e);
    expect(err.message).toMatch(/issued for a different email address/i);
    // …and it must not name the address it IS for.
    expect(err.message).not.toContain(CLIENT);
  });

  test('the address match is case- and space-insensitive', async () => {
    const { key } = await licenceSvc.issueLicence({ email: CLIENT });
    await expect(licenceSvc.validateForSignup(key, '  CLIENT@Example.com ')).resolves.toBeTruthy();
  });

  test('an expired licence is refused', async () => {
    const { key, licence_id } = await licenceSvc.issueLicence({ email: CLIENT });
    await Licence.updateOne({ _id: licence_id }, { $set: { expires_at: new Date(Date.now() - 1000) } });
    await expect(licenceSvc.validateForSignup(key, CLIENT)).rejects.toThrow(/expired/i);
  });

  test('a revoked licence is refused', async () => {
    const { key, licence_id } = await licenceSvc.issueLicence({ email: CLIENT });
    await licenceSvc.revokeLicence(licence_id);
    await expect(licenceSvc.validateForSignup(key, CLIENT)).rejects.toThrow(/revoked/i);
  });

  test('a blank licence is refused', async () => {
    await expect(licenceSvc.validateForSignup('', CLIENT)).rejects.toThrow(/licence number is required/i);
    await expect(licenceSvc.validateForSignup(undefined, CLIENT)).rejects.toThrow(/licence number is required/i);
  });

  test('the legacy DEVELOPER_TOKEN still passes, and claims nothing', async () => {
    const res = await licenceSvc.validateForSignup('legacy-token-for-tests', 'anyone@example.com');
    expect(res.legacy).toBe(true);
    expect(res.licence).toBeNull();
  });
});

describe('a licence is spent while its account lives', () => {
  test('claiming binds it and records the account', async () => {
    const { key, licence_id } = await licenceSvc.issueLicence({ email: CLIENT });
    const user = await User.create({ name: 'C', email: CLIENT, password: 'Test1234!' });
    await licenceSvc.claim(licence_id, user._id, CLIENT);

    const l = await Licence.findById(licence_id).lean();
    expect(String(l.used_by)).toBe(String(user._id));
    expect(l.used_at).toBeTruthy();
    expect(l.history).toHaveLength(1);
    expect(l.history[0].released_at).toBeNull();

    // This is the property that makes a leaked licence worthless.
    await expect(licenceSvc.validateForSignup(key, CLIENT)).rejects.toThrow(/already in use/i);
  });

  test('two signups racing on one licence: exactly one wins', async () => {
    const { licence_id } = await licenceSvc.issueLicence({ email: CLIENT });
    const a = await User.create({ name: 'A', email: 'a@example.com', password: 'Test1234!' });
    const b = await User.create({ name: 'B', email: 'b@example.com', password: 'Test1234!' });

    const results = await Promise.allSettled([
      licenceSvc.claim(licence_id, a._id, 'a@example.com'),
      licenceSvc.claim(licence_id, b._id, 'b@example.com')
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.message).toMatch(/just used by another signup/i);

    expect((await Licence.findById(licence_id).lean()).history).toHaveLength(1);
  });

  test('one account cannot hold two licences', async () => {
    const one = await licenceSvc.issueLicence({ email: CLIENT });
    const two = await licenceSvc.issueLicence({ email: CLIENT });
    const user = await User.create({ name: 'C', email: CLIENT, password: 'Test1234!' });

    await licenceSvc.claim(one.licence_id, user._id, CLIENT);
    // Enforced by the unique partial index on used_by, not by application logic.
    await expect(licenceSvc.claim(two.licence_id, user._id, CLIENT)).rejects.toThrow();
  });
});

describe('deleting the account frees the licence', () => {
  test('release unbinds it and closes the history entry', async () => {
    const { key, licence_id } = await licenceSvc.issueLicence({ email: CLIENT });
    const user = await User.create({ name: 'C', email: CLIENT, password: 'Test1234!' });
    await licenceSvc.claim(licence_id, user._id, CLIENT);

    const released = await licenceSvc.releaseForUser(user._id);
    expect(released.licence_id).toBeTruthy();

    const l = await Licence.findById(licence_id).lean();
    expect(l.used_by).toBeNull();
    expect(l.used_at).toBeNull();
    expect(l.history[0].released_at).toBeTruthy();      // the binding is closed, not erased

    // Usable again — the same number, for the same client.
    await expect(licenceSvc.validateForSignup(key, CLIENT)).resolves.toBeTruthy();
  });

  test('the history accumulates one entry per account it has created', async () => {
    const { licence_id } = await licenceSvc.issueLicence({ email: CLIENT });
    for (let i = 0; i < 3; i++) {
      const u = await User.create({ name: 'C' + i, email: `c${i}@example.com`, password: 'Test1234!' });
      await licenceSvc.claim(licence_id, u._id, u.email);
      await licenceSvc.releaseForUser(u._id);
    }
    const l = await Licence.findById(licence_id).lean();
    expect(l.history).toHaveLength(3);
    expect(l.history.every(h => h.released_at)).toBe(true);
    expect(l.used_by).toBeNull();
  });

  test('releasing for an account that holds none is a no-op', async () => {
    const user = await User.create({ name: 'C', email: CLIENT, password: 'Test1234!' });
    expect(await licenceSvc.releaseForUser(user._id)).toBeNull();
  });

  test('deleteAccount releases it — a stuck licence would be unusable forever', async () => {
    const { key, licence_id } = await licenceSvc.issueLicence({ email: CLIENT });
    const user = await User.create({ name: 'C', email: CLIENT, password: 'Test1234!' });
    await licenceSvc.claim(licence_id, user._id, CLIENT);

    // deleteAccount demands a password and an owner step-up; both are exercised elsewhere. What
    // matters here is only that the release step is wired into that path at all.
    jest.spyOn(require('../services/stepup.service'), 'requireOwnerStepUp').mockResolvedValue(true);
    const res = await profileSvc.deleteAccount(user._id, 'Test1234!', 'stub-token');
    expect(res.licence_released).toBeTruthy();

    expect((await Licence.findById(licence_id).lean()).used_by).toBeNull();
    await expect(licenceSvc.validateForSignup(key, CLIENT)).resolves.toBeTruthy();
    jest.restoreAllMocks();
  });
});

describe('signup end to end', () => {
  test('a wrong licence fails BEFORE any OTP is sent', async () => {
    const otp = require('../services/otp.service');
    const spy = jest.spyOn(otp, 'sendOtp').mockResolvedValue(true);

    await expect(authSvc.signupRequest({
      name: 'C', email: CLIENT, password: 'Test1234!', licence_number: 'CP-ZZZZ-ZZZZ-ZZZZ'
    })).rejects.toThrow('Invalid licence number');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('a valid licence gets as far as the gatekeeper OTP', async () => {
    const { key } = await licenceSvc.issueLicence({ email: CLIENT });
    const otp = require('../services/otp.service');
    const spy = jest.spyOn(otp, 'sendOtp').mockResolvedValue(true);

    const res = await authSvc.signupRequest({
      name: 'C', email: CLIENT, password: 'Test1234!', licence_number: key
    });
    expect(res.requires_otp).toBe(true);
    expect(spy).toHaveBeenCalled();
    // Not claimed yet — no account exists to bind it to.
    expect((await Licence.findOne({ email: CLIENT }).lean()).used_by).toBeNull();
    spy.mockRestore();
  });

  test('an older frontend sending developer_token still works', async () => {
    const otp = require('../services/otp.service');
    const spy = jest.spyOn(otp, 'sendOtp').mockResolvedValue(true);
    const res = await authSvc.signupRequest({
      name: 'C', email: CLIENT, password: 'Test1234!', developer_token: 'legacy-token-for-tests'
    });
    expect(res.requires_otp).toBe(true);
    spy.mockRestore();
  });

  test('a licence already in use is refused at the request stage', async () => {
    const { key, licence_id } = await licenceSvc.issueLicence({ email: CLIENT });
    const holder = await User.create({ name: 'H', email: 'holder@example.com', password: 'Test1234!' });
    await licenceSvc.claim(licence_id, holder._id, 'holder@example.com');

    await expect(authSvc.signupRequest({
      name: 'C', email: CLIENT, password: 'Test1234!', licence_number: key
    })).rejects.toThrow(/already in use/i);
  });
});
