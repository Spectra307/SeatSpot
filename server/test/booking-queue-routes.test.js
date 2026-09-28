import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Booking } from '../src/models/booking.js';
import { Restaurant } from '../src/models/restaurant.js';
import { Table } from '../src/models/table.js';
import { User } from '../src/models/user.js';
import { AuthService } from '../src/services/auth-service.js';
import { createBookingServiceFactory } from '../src/services/booking-service-factory.js';
import { DashboardService } from '../src/services/dashboard-service.js';
import { LoginAttemptStore } from '../src/services/login-attempt-store.js';
import { OtpStore } from '../src/services/otp-store.js';
import { QueueService } from '../src/services/queue-service.js';
import { RestaurantService } from '../src/services/restaurant-service.js';

const jwtSecret = 'booking-queue-test-secret';
const mongoUri = process.env.MONGO_URI
  ?? process.env.MONGODB_URI
  ?? 'mongodb://127.0.0.1:27017/seatspot?replicaSet=rs0';
const redisUrl = process.env.REDIS_URL
  ?? `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD ?? 'replace-with-a-strong-redis-password')}@127.0.0.1:6379`;
const databaseName = `seatspot_http_tests_${process.pid}`;
const queuePrefix = `seatspot:http-tests:${process.pid}:`;
const loginKeyPrefix = `seatspot:http-login-tests:${process.pid}:`;
const authPartitionRestaurantId = '000000000000000000000001';
const testEmails = new Set();
let redis;
let app;

before(async () => {
  await mongoose.connect(mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
  await Promise.all([Restaurant.init(), Table.init(), Booking.init(), User.init()]);

  redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();

  const bookingServiceFactory = createBookingServiceFactory({
    restaurants: Restaurant,
    tables: Table,
    bookings: Booking,
    mongoClient: mongoose.connection.getClient()
  });
  const queueService = new QueueService(redis, { queueKeyPrefix: queuePrefix });
  const dashboardService = new DashboardService({
    tables: Table,
    bookings: Booking,
    queueService,
    bookingServiceFactory,
    mongoClient: mongoose.connection.getClient()
  });
  const authService = new AuthService({
    users: User,
    otpStore: new OtpStore(redis, 300),
    loginAttemptStore: new LoginAttemptStore(redis, {
      maxAttempts: 3,
      windowSeconds: 60,
      lockoutSeconds: 2,
      keyPrefix: loginKeyPrefix
    }),
    jwtSecret,
    jwtExpiresIn: '1h',
    authPartitionRestaurantId
  });
  const restaurantService = new RestaurantService({
    restaurants: Restaurant,
    tables: Table,
    mapsClient: { enabled: false }
  });
  app = createApp({
    authService,
    bookingServiceFactory,
    queueService,
    dashboardService,
    restaurants: Restaurant,
    restaurantService,
    jwtSecret,
    exposeOtp: true
  });
  app.set('trust proxy', 1);
});

after(async () => {
  if (redis?.status === 'ready') {
    const keys = await redis.keys(`${queuePrefix}*`);
    keys.push(...await redis.keys(`${loginKeyPrefix}*`));
    for (const email of testEmails) {
      keys.push(`otp:code:${email}`, `otp:attempts:${email}`, `otp:requests:${email}`);
    }
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

function customerToken(userId = new mongoose.Types.ObjectId().toString()) {
  return jwt.sign({
    sub: userId,
    role: 'customer',
    restaurantId: authPartitionRestaurantId
  }, jwtSecret);
}

function staffToken(userId, restaurantId) {
  return jwt.sign({ sub: userId, role: 'staff', restaurantId }, jwtSecret);
}

async function createRestaurantWithTable(capacity = 4) {
  const restaurantId = new mongoose.Types.ObjectId();
  await Restaurant.create({
    restaurantId,
    name: `HTTP test ${restaurantId}`,
    location: { type: 'Point', coordinates: [0, 0] }
  });
  const table = await Table.create({
    restaurantId,
    label: `table-${new mongoose.Types.ObjectId()}`,
    capacity,
    status: 'available'
  });
  return { restaurantId: restaurantId.toString(), table };
}

function bookingBody(tableId, overrides = {}) {
  return {
    tableId: tableId.toString(),
    partySize: 2,
    startsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides
  };
}

test('booking and queue endpoints require a token and unknown restaurants return 404', async () => {
  const unknownRestaurantId = new mongoose.Types.ObjectId().toString();
  const body = bookingBody(new mongoose.Types.ObjectId());

  await request(app).post(`/api/restaurants/${unknownRestaurantId}/bookings`).send(body).expect(401);
  await request(app).post(`/api/restaurants/${unknownRestaurantId}/queue`).send({}).expect(401);
  await request(app)
    .post(`/api/restaurants/${unknownRestaurantId}/bookings`)
    .set('authorization', `Bearer ${customerToken()}`)
    .send(body)
    .expect(404);
  await request(app)
    .post(`/api/restaurants/${unknownRestaurantId}/queue`)
    .set('authorization', `Bearer ${customerToken()}`)
    .send({})
    .expect(404);
});

test('HTTP booking returns 201 and enforces taken, over-capacity, and invalid-input contracts', async () => {
  const { restaurantId, table } = await createRestaurantWithTable();
  const userAId = new mongoose.Types.ObjectId().toString();
  const userBId = new mongoose.Types.ObjectId().toString();
  const authorization = `Bearer ${customerToken(userAId)}`;
  const bookingPath = `/api/restaurants/${restaurantId}/bookings`;

  const created = await request(app)
    .post(bookingPath)
    .set('authorization', authorization)
    .send(bookingBody(table._id, { userId: userBId }))
    .expect(201);
  assert.equal(created.body.status, 'confirmed');
  assert.equal(created.body.userId, userAId);
  assert.equal(await Booking.countDocuments({ userId: userBId }), 0);

  await request(app)
    .post(bookingPath)
    .set('authorization', authorization)
    .send(bookingBody(table._id))
    .expect(409);

  const { table: smallTable } = await createRestaurantWithTable(2);
  const smallRestaurantId = (await Table.findById(smallTable._id).lean()).restaurantId.toString();
  await request(app)
    .post(`/api/restaurants/${smallRestaurantId}/bookings`)
    .set('authorization', authorization)
    .send(bookingBody(smallTable._id, { partySize: 3 }))
    .expect(409);
  assert.equal((await Table.findById(smallTable._id).lean()).status, 'available');

  await request(app)
    .post(bookingPath)
    .set('authorization', authorization)
    .send(bookingBody(table._id, { partySize: 0 }))
    .expect(400);
});

test('two concurrent HTTP bookings for one table produce exactly one 201 and one 409', async () => {
  const { restaurantId, table } = await createRestaurantWithTable();
  const authorization = `Bearer ${customerToken()}`;
  const path = `/api/restaurants/${restaurantId}/bookings`;
  const results = await Promise.all([
    request(app).post(path).set('authorization', authorization).send(bookingBody(table._id)),
    request(app).post(path).set('authorization', `Bearer ${customerToken()}`).send(bookingBody(table._id))
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
});

test('customers can join and leave a queue over HTTP', async () => {
  const { restaurantId } = await createRestaurantWithTable();
  const userAId = new mongoose.Types.ObjectId().toString();
  const userBId = new mongoose.Types.ObjectId().toString();
  const authorization = `Bearer ${customerToken(userAId)}`;
  const path = `/api/restaurants/${restaurantId}/queue`;

  const joined = await request(app)
    .post(path)
    .set('authorization', authorization)
    .send({ userId: userBId })
    .expect(201);
  assert.equal(joined.body.position, 1);
  assert.equal(joined.body.alreadyInQueue, false);
  assert.equal(joined.body.userId, userAId);

  const otherUser = await request(app)
    .post(path)
    .set('authorization', `Bearer ${customerToken(userBId)}`)
    .send({})
    .expect(201);
  assert.equal(otherUser.body.userId, userBId);

  const position = await request(app)
    .get(`${path}/position`)
    .set('authorization', authorization)
    .expect(200);
  assert.equal(position.body.position, 1);

  const left = await request(app)
    .delete(path)
    .set('authorization', authorization)
    .send({ userId: userBId })
    .expect(200);
  assert.equal(left.body.removed, 1);
  assert.equal(left.body.queueLength, 1);

  const otherUserPosition = await request(app)
    .get(`${path}/position?userId=${userAId}`)
    .set('authorization', `Bearer ${customerToken(userBId)}`)
    .expect(200);
  assert.equal(otherUserPosition.body.position, 1);

  await request(app)
    .delete(path)
    .set('authorization', authorization)
    .send({ userId: userBId })
    .expect(404);
});

test('restaurant read access is authenticated while patching is limited to staff of that restaurant', async () => {
  const restaurantA = await createRestaurantWithTable();
  const restaurantB = await createRestaurantWithTable();
  const customerAuthorization = `Bearer ${customerToken()}`;
  const staffAAuthorization = `Bearer ${staffToken('staff-a', restaurantA.restaurantId)}`;

  await request(app)
    .patch(`/api/restaurants/${restaurantA.restaurantId}`)
    .set('authorization', customerAuthorization)
    .send({ name: 'Customer edit attempt' })
    .expect(403);
  await request(app)
    .delete(`/api/restaurants/${restaurantA.restaurantId}`)
    .set('authorization', customerAuthorization)
    .expect(403);

  await request(app)
    .patch(`/api/restaurants/${restaurantB.restaurantId}`)
    .set('authorization', staffAAuthorization)
    .send({ name: 'Cross-tenant edit attempt' })
    .expect(403);
  await request(app)
    .delete(`/api/restaurants/${restaurantB.restaurantId}`)
    .set('authorization', staffAAuthorization)
    .expect(403);

  const updated = await request(app)
    .patch(`/api/restaurants/${restaurantA.restaurantId}`)
    .set('authorization', staffAAuthorization)
    .send({ name: 'Staff authorized edit' })
    .expect(200);
  assert.equal(updated.body.name, 'Staff authorized edit');

  await request(app)
    .delete(`/api/restaurants/${restaurantA.restaurantId}`)
    .set('authorization', staffAAuthorization)
    .expect(403);
  await request(app)
    .post('/api/restaurants')
    .set('authorization', staffAAuthorization)
    .send({ name: 'Unauthorized create', latitude: 0, longitude: 0 })
    .expect(403);

  const availability = await request(app)
    .get(`/api/restaurants/${restaurantA.restaurantId}/availability`)
    .set('authorization', customerAuthorization)
    .expect(200);
  assert.equal(availability.body.available, 1);

  const restaurant = await request(app)
    .get(`/api/restaurants/${restaurantA.restaurantId}`)
    .set('authorization', customerAuthorization)
    .expect(200);
  assert.equal(restaurant.body.name, 'Staff authorized edit');
});

test('public signup ignores requested staff role and restaurantId and issues a customer token', async () => {
  const email = `public-${new mongoose.Types.ObjectId()}@example.com`;
  const requestedRestaurantId = new mongoose.Types.ObjectId().toString();
  const signup = await request(app)
    .post('/api/auth/signup')
    .send({
      name: 'Public Signup',
      email,
      password: 'password123',
      role: 'staff',
      restaurantId: requestedRestaurantId
    })
    .expect(201);

  const verified = await request(app)
    .post('/api/auth/verify-otp')
    .send({ email, otp: signup.body.otp })
    .expect(200);
  const claims = jwt.verify(verified.body.token, jwtSecret);
  const user = await User.findById(claims.sub).lean();

  assert.equal(claims.role, 'customer');
  assert.equal(claims.restaurantId, authPartitionRestaurantId);
  assert.equal(user.role, 'customer');
  assert.equal(user.restaurantId.toString(), authPartitionRestaurantId);
  assert.notEqual(user.restaurantId.toString(), requestedRestaurantId);
});

test('tenant-scoped staff login issues role and restaurantId from the stored account', async () => {
  const { restaurantId } = await createRestaurantWithTable();
  const email = `staff-${new mongoose.Types.ObjectId()}@example.com`;
  const password = 'staff-password-123';
  await User.create({
    restaurantId,
    name: 'Seeded Staff',
    email,
    passwordHash: await bcrypt.hash(password, 4),
    role: 'staff',
    isVerified: true
  });

  const result = await request(app)
    .post('/api/auth/login')
    .send({ email, password, restaurantId, role: 'customer' })
    .expect(200);
  const claims = jwt.verify(result.body.token, jwtSecret);

  assert.equal(claims.role, 'staff');
  assert.equal(claims.restaurantId, restaurantId);
});

test('the sixth OTP guess is rejected after five failures, even when correct; resend is rate limited', async () => {
  const email = `otp-attempts-${process.pid}-${new mongoose.Types.ObjectId()}@example.com`;
  testEmails.add(email);
  const signup = await request(app)
    .post('/api/auth/signup')
    .send({ name: 'OTP Test', email, password: 'password123' })
    .expect(201);
  const otp = signup.body.otp;
  const wrongOtp = otp === '000000' ? '000001' : '000000';

  const codeTtl = await redis.ttl(`otp:code:${email}`);
  const attemptsTtl = await redis.ttl(`otp:attempts:${email}`);
  assert.equal(attemptsTtl, codeTtl);

  await request(app).post('/api/auth/verify-otp').send({ email, otp: '12' }).expect(400);
  assert.equal(Number(await redis.get(`otp:attempts:${email}`)), 1);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await request(app).post('/api/auth/verify-otp').send({ email, otp: wrongOtp }).expect(400);
  }
  assert.equal(await redis.exists(`otp:code:${email}`), 0);
  assert.equal(Number(await redis.get(`otp:attempts:${email}`)), 5);

  await request(app).post('/api/auth/verify-otp').send({ email, otp }).expect(400);

  const resent = await request(app).post('/api/auth/request-otp').send({ email }).expect(200);
  assert.ok(resent.body.otp);
  await request(app).post('/api/auth/verify-otp').send({ email, otp: resent.body.otp }).expect(200);

  const rateLimitedEmail = `otp-rate-${process.pid}-${new mongoose.Types.ObjectId()}@example.com`;
  testEmails.add(rateLimitedEmail);
  await request(app)
    .post('/api/auth/signup')
    .send({ name: 'OTP Rate Test', email: rateLimitedEmail, password: 'password123' })
    .expect(201);
  await request(app).post('/api/auth/request-otp').send({ email: rateLimitedEmail }).expect(200);
  await request(app).post('/api/auth/request-otp').send({ email: rateLimitedEmail }).expect(200);
  await request(app).post('/api/auth/request-otp').send({ email: rateLimitedEmail }).expect(429);
});

test('unknown email and wrong password have the same response; per-email and per-IP lockouts expire', async () => {
  const email = `login-email-lock-${process.pid}-${new mongoose.Types.ObjectId()}@example.com`;
  const emailPassword = 'correct-password-123';
  testEmails.add(email);
  await User.create({
    restaurantId: authPartitionRestaurantId,
    name: 'Login Lock Test',
    email,
    passwordHash: await bcrypt.hash(emailPassword, 12),
    role: 'customer',
    isVerified: true
  });

  const unknown = await request(app)
    .post('/api/auth/login')
    .set('x-forwarded-for', '198.51.100.10')
    .send({ email: `missing-${process.pid}@example.com`, password: 'wrong-password' });
  const wrongPassword = await request(app)
    .post('/api/auth/login')
    .set('x-forwarded-for', '198.51.100.11')
    .send({ email, password: 'wrong-password' });
  const unverifiedEmail = `unverified-${process.pid}-${new mongoose.Types.ObjectId()}@example.com`;
  testEmails.add(unverifiedEmail);
  await User.create({
    restaurantId: authPartitionRestaurantId,
    name: 'Unverified Login Test',
    email: unverifiedEmail,
    passwordHash: await bcrypt.hash(emailPassword, 12),
    role: 'customer',
    isVerified: false
  });
  const unverified = await request(app)
    .post('/api/auth/login')
    .set('x-forwarded-for', '198.51.100.12')
    .send({ email: unverifiedEmail, password: emailPassword });
  assert.equal(unknown.status, 401);
  assert.equal(wrongPassword.status, 401);
  assert.equal(unverified.status, 401);
  assert.deepEqual(unknown.body, wrongPassword.body);
  assert.deepEqual(unknown.body, unverified.body);

  const emailLockEmail = `email-lock-${process.pid}-${new mongoose.Types.ObjectId()}@example.com`;
  testEmails.add(emailLockEmail);
  await User.create({
    restaurantId: authPartitionRestaurantId,
    name: 'Email Lock Test',
    email: emailLockEmail,
    passwordHash: await bcrypt.hash(emailPassword, 12),
    role: 'customer',
    isVerified: true
  });
  for (const ip of ['198.51.100.20', '198.51.100.21', '198.51.100.22']) {
    await request(app)
      .post('/api/auth/login')
      .set('x-forwarded-for', ip)
      .send({ email: emailLockEmail, password: 'wrong-password' })
      .expect(401);
  }
  await request(app)
    .post('/api/auth/login')
    .set('x-forwarded-for', '198.51.100.23')
    .send({ email: emailLockEmail, password: emailPassword })
    .expect(401);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await request(app)
    .post('/api/auth/login')
    .set('x-forwarded-for', '198.51.100.23')
    .send({ email: emailLockEmail, password: emailPassword })
    .expect(200);

  const ipLockEmail = `login-ip-lock-${process.pid}-${new mongoose.Types.ObjectId()}@example.com`;
  testEmails.add(ipLockEmail);
  await User.create({
    restaurantId: authPartitionRestaurantId,
    name: 'IP Lock Test',
    email: ipLockEmail,
    passwordHash: await bcrypt.hash(emailPassword, 12),
    role: 'customer',
    isVerified: true
  });
  for (let failure = 0; failure < 3; failure += 1) {
    await request(app)
      .post('/api/auth/login')
      .set('x-forwarded-for', '198.51.100.30')
      .send({ email: `unknown-${failure}-${process.pid}@example.com`, password: 'wrong-password' })
      .expect(401);
  }
  await request(app)
    .post('/api/auth/login')
    .set('x-forwarded-for', '198.51.100.30')
    .send({ email: ipLockEmail, password: emailPassword })
    .expect(401);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await request(app)
    .post('/api/auth/login')
    .set('x-forwarded-for', '198.51.100.30')
    .send({ email: ipLockEmail, password: emailPassword })
    .expect(200);
});

test('dashboard endpoints reject customers and staff from another restaurant', async () => {
  const restaurantA = await createRestaurantWithTable();
  const restaurantB = await createRestaurantWithTable();
  const pathA = `/api/restaurants/${restaurantA.restaurantId}/dashboard/tables`;
  const pathB = `/api/restaurants/${restaurantB.restaurantId}/dashboard/tables`;

  await request(app).get(pathA).set('authorization', `Bearer ${customerToken()}`).expect(403);
  await request(app)
    .get(pathB)
    .set('authorization', `Bearer ${staffToken('staff-a', restaurantA.restaurantId)}`)
    .expect(403);

  const ownTables = await request(app)
    .get(pathA)
    .set('authorization', `Bearer ${staffToken('staff-a', restaurantA.restaurantId)}`)
    .expect(200);
  assert.equal(ownTables.body.tables.length, 1);

  const queue = await request(app)
    .get(`/api/restaurants/${restaurantA.restaurantId}/dashboard/queue`)
    .set('authorization', `Bearer ${staffToken('staff-a', restaurantA.restaurantId)}`)
    .expect(200);
  assert.equal(queue.body.queueLength, 0);
});

test('walk-in seating and customer booking race for one table with exactly one winner', async () => {
  const { restaurantId, table } = await createRestaurantWithTable();
  const path = `/api/restaurants/${restaurantId}`;
  const walkInPath = `${path}/dashboard/tables/${table._id}/walk-in`;
  const customerPath = `${path}/bookings`;
  const results = await Promise.all([
    request(app)
      .post(walkInPath)
      .set('authorization', `Bearer ${staffToken('staff-a', restaurantId)}`)
      .send({ userId: new mongoose.Types.ObjectId().toString(), partySize: 2 }),
    request(app)
      .post(customerPath)
      .set('authorization', `Bearer ${customerToken()}`)
      .send(bookingBody(table._id))
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(await Booking.countDocuments({ tableId: table._id, status: 'confirmed' }), 1);
});

test('dashboard cannot override a table with a confirmed booking to available', async () => {
  const { restaurantId, table } = await createRestaurantWithTable();
  await request(app)
    .post(`/api/restaurants/${restaurantId}/bookings`)
    .set('authorization', `Bearer ${customerToken()}`)
    .send(bookingBody(table._id))
    .expect(201);

  await request(app)
    .patch(`/api/restaurants/${restaurantId}/dashboard/tables/${table._id}/status`)
    .set('authorization', `Bearer ${staffToken('staff-a', restaurantId)}`)
    .send({ status: 'available' })
    .expect(409);
  assert.equal((await Table.findById(table._id).lean()).status, 'reserved');
});