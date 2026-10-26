import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { AuthService } from '../src/services/auth-service.js';

class Users {
  constructor() { this.items = []; }
  findOne(query) {
    const item = this.items.find((candidate) => candidate.restaurantId === query.restaurantId && candidate.email === query.email);
    return {
      then: (resolve, reject) => Promise.resolve(item ?? null).then(resolve, reject),
      select: async () => item ?? null
    };
  }
  async create(item) { const created = { ...item, _id: 'user-1', role: 'customer', isVerified: false }; this.items.push(created); return created; }
  async findOneAndUpdate(query, update) { const item = this.items.find((candidate) => candidate.restaurantId === query.restaurantId && candidate.email === query.email); if (item) Object.assign(item, update.$set ?? update); return item; }
}

class OtpStore {
  constructor() { this.redis = { ttl: async () => 60, key: (e,p='code') => `otp:${p}:${e}` }; }
  async allowRequest() { return true; }
  async isCooldown() { return false; }
  async save(_email, otp) { this.otp = otp; }
  async verify(_email, suppliedOtp) {
    const matches = suppliedOtp === this.otp;
    if (matches) this.otp = undefined;
    return matches;
  }
  key(email, purpose='code') { return `otp:${purpose}:${email}`; }
}

test('signup, OTP verification, and login issue valid JWTs', async () => {
  const users = new Users();
  const store = new OtpStore();
  const service = new AuthService({ users, otpStore: store, jwtSecret: 'test-secret', jwtExpiresIn: '1h', authPartitionRestaurantId: 'partition-1' });
  await service.signup({ name: 'Ada', email: 'ada@example.com', password: 'password123' });
  const token = await service.verifyOtp({ email: 'ada@example.com', otp: store.otp });
  assert.equal(jwt.verify(token, 'test-secret').sub, 'user-1');
  const loginToken = await service.login({ email: 'ada@example.com', password: 'password123' });
  assert.equal(jwt.verify(loginToken, 'test-secret').role, 'customer');
});

test('signup: returns emailDispatched flag and is unaffected if sendOtp rejects', async () => {
  const users = new Users();
  const store = new OtpStore();
  const emailService = {
    async sendOtp() { throw new Error('SMTP failure'); }
  };
  const service = new AuthService({ users, otpStore: store, emailService, jwtSecret: 'test-secret', jwtExpiresIn: '1h', authPartitionRestaurantId: 'partition-1' });
  const result = await service.signup({ name: 'Bob', email: 'bob@example.com', password: 'password123' });
  assert.equal(result.emailDispatched, false);
});
