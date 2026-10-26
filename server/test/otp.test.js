/**
 * otp.test.js — Unit tests for OTP expiry, attempt lockout, resend cooldown,
 * hourly cap, and the guarantee that OTPs never appear in API responses.
 *
 * These tests use Node's built-in test runner (node:test) with in-memory fakes
 * so no Redis or MongoDB is required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../src/services/auth-service.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A minimal in-memory OtpStore that mirrors the real implementation's contract
 * but uses plain hashed storage so tests don't need Redis.
 */
class FakeOtpStore {
  constructor({ ttlMs = 300_000, cooldownMs = 60_000, requestLimit = 3, requestWindowMs = 3_600_000 } = {}) {
    this.ttlMs = ttlMs;
    this.cooldownMs = cooldownMs;
    this.requestLimit = requestLimit;
    this.requestWindowMs = requestWindowMs;
    this._codes = new Map();      // email → { hash, expiresAt, attempts }
    this._cooldowns = new Map();  // email → expiresAt
    this._requests = new Map();   // email → { count, windowEnd }
  }

  _hash(otp) {
    // Mirror the real SHA-256 hash (but keep this fake simple with a toString).
    return `hashed:${String(otp)}`;
  }

  async allowRequest(email, limit, windowSeconds) {
    const now = Date.now();
    const entry = this._requests.get(email);
    if (!entry || now > entry.windowEnd) {
      this._requests.set(email, { count: 1, windowEnd: now + (windowSeconds ?? this.requestWindowMs / 1000) * 1000 });
      return true;
    }
    entry.count++;
    return entry.count <= (limit ?? this.requestLimit);
  }

  async isCooldown(email) {
    const exp = this._cooldowns.get(email);
    return exp !== undefined && Date.now() < exp;
  }

  async save(email, otp) {
    const now = Date.now();
    this._codes.set(email, { hash: this._hash(otp), expiresAt: now + this.ttlMs, attempts: 0 });
    this._cooldowns.set(email, now + this.cooldownMs);
  }

  async verify(email, suppliedOtp, maxAttempts = 5) {
    const entry = this._codes.get(email);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this._codes.delete(email);
      return false;
    }
    if (entry.attempts >= maxAttempts) {
      this._codes.delete(email);
      return false;
    }
    if (entry.hash === this._hash(suppliedOtp)) {
      this._codes.delete(email);
      return true;
    }
    entry.attempts++;
    if (entry.attempts >= maxAttempts) this._codes.delete(email);
    return false;
  }

  /** Test helper: fast-forward the stored code's expiry */
  expireCode(email) {
    const entry = this._codes.get(email);
    if (entry) entry.expiresAt = Date.now() - 1;
  }

  /** Test helper: fast-forward the per-send cooldown */
  expireCooldown(email) {
    this._cooldowns.set(email, Date.now() - 1);
  }
}

class FakeUsers {
  constructor() { this.items = []; }
  findOne(query) {
    const item = this.items.find(
      (u) => u.restaurantId === query.restaurantId && u.email === query.email
    );
    return { then: (r, j) => Promise.resolve(item ?? null).then(r, j), select: async () => item ?? null };
  }
  async create(item) {
    const created = { ...item, _id: `user-${this.items.length}`, isVerified: false };
    this.items.push(created);
    return created;
  }
  async findOneAndUpdate(query, update) {
    const item = this.items.find((u) => u.restaurantId === query.restaurantId && u.email === query.email);
    if (item) Object.assign(item, update.$set ?? update);
    return item ?? null;
  }
  findById(id) { return { select: async () => this.items.find((u) => u._id === id) ?? null }; }
}

/** Collect emails sent so tests can assert they were (or weren't) sent */
class FakeEmailService {
  constructor() { this.sent = []; }
  async sendOtp(email, otp) { this.sent.push({ type: 'otp', email, otp }); }
  sendBookingConfirmation(email, data) { this.sent.push({ type: 'confirm', email, data }); }
  sendBookingCancellation(email, data) { this.sent.push({ type: 'cancel', email, data }); }
}

function makeService({ otpStore, emailService } = {}) {
  return new AuthService({
    users: new FakeUsers(),
    otpStore: otpStore ?? new FakeOtpStore(),
    emailService: emailService ?? new FakeEmailService(),
    jwtSecret: 'test-secret',
    jwtExpiresIn: '1h',
    authPartitionRestaurantId: 'partition-1'
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('signup: OTP is not present in the return value', async () => {
  const service = makeService();
  const result = await service.signup({ name: 'Ada', email: 'ada@test.com', password: 'password123' });
  assert.ok(!('otp' in result), 'OTP must not appear in signup response');
});

test('signup: OTP is delivered via emailService, not API response', async () => {
  const emailService = new FakeEmailService();
  const service = makeService({ emailService });
  await service.signup({ name: 'Ada', email: 'ada2@test.com', password: 'password123' });
  assert.equal(emailService.sent.length, 1);
  assert.equal(emailService.sent[0].type, 'otp');
  assert.equal(emailService.sent[0].email, 'ada2@test.com');
  // The OTP value exists in the email but is just a 6-digit string
  assert.match(String(emailService.sent[0].otp), /^\d{6}$/);
});

test('requestOtp: return value never contains OTP', async () => {
  const store = new FakeOtpStore();
  const users = new FakeUsers();
  const emailService = new FakeEmailService();
  const service = new AuthService({ users, otpStore: store, emailService, jwtSecret: 'x', jwtExpiresIn: '1h', authPartitionRestaurantId: 'p' });
  // Create a verified=false user
  await users.create({ restaurantId: 'p', email: 'resend@test.com', passwordHash: 'h', isVerified: false });
  const result = await service.requestOtp({ email: 'resend@test.com' });
  assert.ok(!('otp' in result), 'requestOtp must not return OTP');
});

test('verifyOtp: expires after TTL', async () => {
  const store = new FakeOtpStore({ ttlMs: 100 });
  const emailService = new FakeEmailService();
  const users = new FakeUsers();
  const service = new AuthService({ users, otpStore: store, emailService, jwtSecret: 'x', jwtExpiresIn: '1h', authPartitionRestaurantId: 'p' });
  await service.signup({ name: 'Bob', email: 'bob@test.com', password: 'password123' });
  const otp = emailService.sent[0].otp;

  // Fast-forward past TTL
  store.expireCode('bob@test.com');

  await assert.rejects(
    service.verifyOtp({ email: 'bob@test.com', otp }),
    (err) => err.status === 400 && /invalid|expired/i.test(err.message)
  );
});

test('verifyOtp: 5 wrong attempts lock the code; sixth attempt fails even with correct OTP', async () => {
  const store = new FakeOtpStore();
  const emailService = new FakeEmailService();
  const users = new FakeUsers();
  const service = new AuthService({ users, otpStore: store, emailService, jwtSecret: 'x', jwtExpiresIn: '1h', authPartitionRestaurantId: 'p' });
  await service.signup({ name: 'Carol', email: 'carol@test.com', password: 'password123' });
  const correctOtp = emailService.sent[0].otp;

  // Submit 5 wrong codes
  for (let i = 0; i < 5; i++) {
    await assert.rejects(service.verifyOtp({ email: 'carol@test.com', otp: '000000' }));
  }
  // Now submit the correct OTP — must still fail (code was deleted)
  await assert.rejects(
    service.verifyOtp({ email: 'carol@test.com', otp: correctOtp }),
    (err) => err.status === 400
  );
});

test('requestOtp: 60-second cooldown prevents immediate re-request', async () => {
  const store = new FakeOtpStore({ cooldownMs: 60_000 });
  store.redis = { ttl: async () => 60, key: (e,p='code') => `otp:${p}:${e}` };
  const emailService = new FakeEmailService();
  const users = new FakeUsers();
  const service = new AuthService({ users, otpStore: store, emailService, jwtSecret: 'x', jwtExpiresIn: '1h', authPartitionRestaurantId: 'p' });
  await users.create({ restaurantId: 'p', email: 'dave@test.com', passwordHash: 'h', isVerified: false });

  // First request works
  await service.requestOtp({ email: 'dave@test.com' });

  // Immediate re-request is blocked by cooldown
  await assert.rejects(
    service.requestOtp({ email: 'dave@test.com' }),
    (err) => err.status === 429 && /60|cooldown|wait/i.test(err.message) && err.retryAfterSeconds !== undefined
  );
});

test('requestOtp: hourly cap (3 requests per hour) is enforced', async () => {
  const store = new FakeOtpStore({ cooldownMs: 0 }); // disable cooldown for this test
  store.redis = { ttl: async () => 60, key: (e,p='code') => `otp:${p}:${e}` };
  const emailService = new FakeEmailService();
  const users = new FakeUsers();
  const service = new AuthService({ users, otpSecret: undefined, otpStore: store, emailService, jwtSecret: 'x', jwtExpiresIn: '1h', authPartitionRestaurantId: 'p' });
  await users.create({ restaurantId: 'p', email: 'eve@test.com', passwordHash: 'h', isVerified: false });

  // 3 allowed
  for (let i = 0; i < 3; i++) {
    store.expireCooldown('eve@test.com');
    await service.requestOtp({ email: 'eve@test.com' });
  }

  // 4th is blocked by hourly cap
  store.expireCooldown('eve@test.com');
  await assert.rejects(
    service.requestOtp({ email: 'eve@test.com' }),
    (err) => err.status === 429 && err.code === 'OTP_RATE_LIMIT'
  );
});

test('requestOtp: unknown email returns same generic response (no enumeration)', async () => {
  const store = new FakeOtpStore({ cooldownMs: 0 });
  store.redis = { ttl: async () => 60, key: (e,p='code') => `otp:${p}:${e}` };
  const emailService = new FakeEmailService();
  const service = makeService({ otpStore: store, emailService });

  // Email does not exist in the user store
  const result = await service.requestOtp({ email: 'ghost@test.com' });

  // Should not throw, should return empty object, and must not send an email
  assert.ok(!('otp' in result));
  assert.equal(emailService.sent.length, 0, 'must not send email for unknown address');
});

test('verifyOtp: correct OTP issues a valid JWT', async () => {
  const store = new FakeOtpStore();
  store.redis = { ttl: async () => 60, key: (e,p='code') => `otp:${p}:${e}` };
  const emailService = new FakeEmailService();
  const users = new FakeUsers();
  const service = new AuthService({ users, otpStore: store, emailService, jwtSecret: 'test-secret', jwtExpiresIn: '1h', authPartitionRestaurantId: 'p' });
  await service.signup({ name: 'Frank', email: 'frank@test.com', password: 'password123' });
  const otp = emailService.sent[0].otp;

  const token = await service.verifyOtp({ email: 'frank@test.com', otp });
  assert.ok(typeof token === 'string' && token.split('.').length === 3, 'should return a JWT');
});

test('requestOtp: after the cooldown a fresh code replaces the previous one', async () => {
  const store = new FakeOtpStore({ cooldownMs: 60_000 });
  store.redis = { ttl: async () => 60, key: (e, p = 'code') => `otp:${p}:${e}` };
  const emailService = new FakeEmailService();
  const users = new FakeUsers();
  const service = new AuthService({ users, otpStore: store, emailService, jwtSecret: 'x', jwtExpiresIn: '1h', authPartitionRestaurantId: 'p' });

  await service.signup({ name: 'Hana', email: 'hana@test.com', password: 'password123' });
  assert.equal(emailService.sent.length, 1);
  const firstOtp = emailService.sent[0].otp;

  store.expireCooldown('hana@test.com');
  await service.requestOtp({ email: 'hana@test.com' });

  assert.equal(emailService.sent.length, 2, 'resend must deliver a new email');
  const secondOtp = emailService.sent[1].otp;
  assert.match(secondOtp, /^\d{6}$/);

  // The superseded code must no longer work (unless the 6-digit generator
  // happened to collide, which is astronomically unlikely).
  if (firstOtp !== secondOtp) {
    await assert.rejects(
      service.verifyOtp({ email: 'hana@test.com', otp: firstOtp }),
      (err) => err.status === 400
    );
  }

  const token = await service.verifyOtp({ email: 'hana@test.com', otp: secondOtp });
  assert.equal(typeof token, 'string');
});

test('requestOtp: verified accounts do not receive another code', async () => {
  const store = new FakeOtpStore({ cooldownMs: 0 });
  store.redis = { ttl: async () => 60, key: (e, p = 'code') => `otp:${p}:${e}` };
  const emailService = new FakeEmailService();
  const users = new FakeUsers();
  const service = new AuthService({ users, otpStore: store, emailService, jwtSecret: 'x', jwtExpiresIn: '1h', authPartitionRestaurantId: 'p' });

  await service.signup({ name: 'Ira', email: 'ira@test.com', password: 'password123' });
  await service.verifyOtp({ email: 'ira@test.com', otp: emailService.sent[0].otp });
  const sentBefore = emailService.sent.length;

  const result = await service.requestOtp({ email: 'ira@test.com' });
  assert.deepEqual(result, {});
  assert.equal(emailService.sent.length, sentBefore, 'verified users must not get another OTP email');
});

test('signup: an unverified duplicate email is sent back to verification', async () => {
  const service = makeService();
  await service.signup({ name: 'Jo', email: 'jo@test.com', password: 'password123' });
  await assert.rejects(
    service.signup({ name: 'Jo', email: 'jo@test.com', password: 'password123' }),
    (err) => err.status === 409 && err.code === 'EMAIL_UNVERIFIED'
  );
});

test('login: unverified accounts get the same generic 401 as unknown emails', async () => {
  const service = makeService();
  await service.signup({ name: 'Kim', email: 'kim@test.com', password: 'password123' });
  await assert.rejects(
    service.login({ email: 'kim@test.com', password: 'password123' }),
    (err) => err.status === 401 && err.message === 'Email or password is incorrect'
  );
  await assert.rejects(
    service.login({ email: 'nobody@test.com', password: 'password123' }),
    (err) => err.status === 401 && err.message === 'Email or password is incorrect'
  );
});

test('sendOtp failure is isolated and does not throw from requestOtp', async () => {
  const store = new FakeOtpStore({ cooldownMs: 0 });
  store.redis = { ttl: async () => 60, key: (e,p='code') => `otp:${p}:${e}` };
  const emailService = { async sendOtp() { throw new Error('SMTP down'); } };
  const users = new FakeUsers();
  const service = new AuthService({ users, otpStore: store, emailService, jwtSecret: 'x', jwtExpiresIn: '1h', authPartitionRestaurantId: 'p' });
  await users.create({ restaurantId: 'p', email: 'grace@test.com', passwordHash: 'h', isVerified: false });
  const result = await service.requestOtp({ email: 'grace@test.com' });
  assert.deepEqual(result, {});
});
