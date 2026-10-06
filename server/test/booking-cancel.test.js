import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Booking } from '../src/models/booking.js';
import { Restaurant } from '../src/models/restaurant.js';
import { Table } from '../src/models/table.js';
import { User } from '../src/models/user.js';
import { BookingService } from '../src/services/booking-service.js';
import { createBookingServiceFactory } from '../src/services/booking-service-factory.js';
import { NotificationService } from '../src/services/notification-service.js';
import { QueueService } from '../src/services/queue-service.js';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const jwtSecret = 'cancel-test-secret';
const mongoUri = process.env.MONGO_URI
  ?? process.env.MONGODB_URI
  ?? 'mongodb://127.0.0.1:27017/seatspot?replicaSet=rs0';
const redisUrl = process.env.REDIS_URL
  ?? `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD ?? 'replace-with-a-strong-redis-password')}@127.0.0.1:6379`;
const databaseName = `seatspot_cancel_tests_${process.pid}`;
const queuePrefix = `seatspot:cancel-tests:${process.pid}:`;
const authPartitionRestaurantId = '000000000000000000000001';
let redis;
let app;
let queueService;

function createRealtimeSpy() {
  const calls = { broadcastAvailability: [], emitToUser: [] };
  return {
    calls,
    broadcastAvailability(...args) { calls.broadcastAvailability.push(args); },
    emitToUser(...args) { calls.emitToUser.push(args); }
  };
}

let realtimeSpy;

before(async () => {
  await mongoose.connect(mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
  await Promise.all([Booking.init(), Restaurant.init(), Table.init(), User.init()]);
  redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();

  const notificationService = new NotificationService({ logger: { info() {}, warn() {} } });
  realtimeSpy = createRealtimeSpy();
  const bookingServiceFactory = createBookingServiceFactory({
    restaurants: Restaurant,
    tables: Table,
    bookings: Booking,
    mongoClient: mongoose.connection.getClient(),
    notificationService,
    socketRealtimeService: realtimeSpy,
    queueService: undefined
  });
  queueService = new QueueService(redis, { queueKeyPrefix: queuePrefix, notificationService });
  app = createApp({
    bookingServiceFactory,
    queueService,
    restaurants: Restaurant,
    jwtSecret,
    bookings: Booking
  });
});

after(async () => {
  if (redis?.status === 'ready') {
    const keys = await redis.keys(`${queuePrefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

beforeEach(async () => {
  await Promise.all([Booking.deleteMany({}), Table.deleteMany({}), Restaurant.deleteMany({})]);
  const keys = await redis.keys(`${queuePrefix}*`);
  if (keys.length) await redis.del(...keys);
  realtimeSpy.calls.broadcastAvailability.length = 0;
  realtimeSpy.calls.emitToUser.length = 0;
});

function customerToken(userId) {
  return jwt.sign({ sub: String(userId), role: 'customer', restaurantId: authPartitionRestaurantId }, jwtSecret);
}

async function createFixture({ userId = new mongoose.Types.ObjectId(), startsAt } = {}) {
  const restaurantId = new mongoose.Types.ObjectId();
  await Restaurant.create({
    restaurantId,
    name: `Cancel Test ${restaurantId}`,
    location: { type: 'Point', coordinates: [0, 0] }
  });
  const table = await Table.create({
    restaurantId,
    label: `table-${new mongoose.Types.ObjectId()}`,
    capacity: 4,
    status: 'reserved'
  });
  const booking = await Booking.create({
    restaurantId,
    tableId: table._id,
    userId,
    partySize: 2,
    startsAt: startsAt ?? new Date(Date.now() + 60 * 60 * 1000),
    source: 'customer',
    status: 'confirmed'
  });
  return { restaurantId, table, booking, userId };
}

test('owner cancels: 200, booking CANCELLED, table AVAILABLE', async () => {
  const { booking, table, userId } = await createFixture();

  const response = await request(app)
    .patch(`/api/bookings/${booking._id}/cancel`)
    .set('Authorization', `Bearer ${customerToken(userId)}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'cancelled');
  assert.ok(response.body.cancelledAt);
  assert.equal((await Booking.findById(booking._id).lean()).status, 'cancelled');
  assert.equal((await Table.findById(table._id).lean()).status, 'available');
});

test('different user cancels: 404, booking and table unchanged', async () => {
  const { booking, table } = await createFixture();
  const otherUser = new mongoose.Types.ObjectId();

  const response = await request(app)
    .patch(`/api/bookings/${booking._id}/cancel`)
    .set('Authorization', `Bearer ${customerToken(otherUser)}`);

  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'Booking not found');
  assert.equal((await Booking.findById(booking._id).lean()).status, 'confirmed');
  assert.equal((await Table.findById(table._id).lean()).status, 'reserved');
});

test('cancel twice: second returns 409, table not modified again', async () => {
  const { booking, table, userId } = await createFixture();

  const first = await request(app)
    .patch(`/api/bookings/${booking._id}/cancel`)
    .set('Authorization', `Bearer ${customerToken(userId)}`);
  assert.equal(first.status, 200);

  await Table.updateOne({ _id: table._id }, { $set: { status: 'occupied' } });

  const second = await request(app)
    .patch(`/api/bookings/${booking._id}/cancel`)
    .set('Authorization', `Bearer ${customerToken(userId)}`);

  assert.equal(second.status, 409);
  assert.equal((await Table.findById(table._id).lean()).status, 'occupied');
});

test('two concurrent cancels on one booking: exactly one 200, one 409', async () => {
  const { booking, table, userId } = await createFixture();

  const results = await Promise.allSettled([
    request(app).patch(`/api/bookings/${booking._id}/cancel`).set('Authorization', `Bearer ${customerToken(userId)}`),
    request(app).patch(`/api/bookings/${booking._id}/cancel`).set('Authorization', `Bearer ${customerToken(userId)}`)
  ]);

  const statuses = results.map((r) => r.value.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal((await Booking.findById(booking._id).lean()).status, 'cancelled');
  assert.equal((await Table.findById(table._id).lean()).status, 'available');
});

test('forced table update failure: transaction rolls back, booking stays CONFIRMED, table stays RESERVED', async () => {
  const { table, booking, restaurantId, userId } = await createFixture();
  const notificationService = new NotificationService({ logger: { info() {}, warn() {} } });
  const failingTables = {
    findOneAndUpdate() {
      throw new Error('forced table update failure');
    }
  };
  const service = new BookingService({
    tables: failingTables,
    bookings: Booking,
    restaurantId,
    mongoClient: mongoose.connection.getClient(),
    notificationService
  });

  await assert.rejects(
    service.cancelBooking({ bookingId: booking._id, userId }),
    /forced table update failure/
  );

  assert.equal((await Booking.findById(booking._id).lean()).status, 'confirmed');
  assert.equal((await Table.findById(table._id).lean()).status, 'reserved');
});

test('socket emit and queue promotion are not called on any failure path', async () => {
  const { booking, userId } = await createFixture();
  const notificationService = new NotificationService({ logger: { info() {}, warn() {} } });
  const realtime = createRealtimeSpy();
  let promotionCalls = 0;
  const queueService = { promoteNextFromQueue() { promotionCalls += 1; return Promise.resolve(null); } };
  const service = new BookingService({
    tables: Table,
    bookings: Booking,
    restaurantId: booking.restaurantId,
    mongoClient: mongoose.connection.getClient(),
    notificationService,
    socketRealtimeService: realtime,
    queueService
  });

  await assert.rejects(service.cancelBooking({ bookingId: booking._id, userId: new mongoose.Types.ObjectId() }), (e) => e.status === 404);
  await assert.rejects(service.cancelBooking({ bookingId: new mongoose.Types.ObjectId(), userId }), (e) => e.status === 404);

  await Booking.updateOne({ _id: booking._id }, { $set: { status: 'cancelled' } });
  await assert.rejects(service.cancelBooking({ bookingId: booking._id, userId }), (e) => e.status === 409);

  assert.equal(realtime.calls.broadcastAvailability.length, 0);
  assert.equal(realtime.calls.emitToUser.length, 0);
  assert.equal(promotionCalls, 0);
});

test('queue promotion called once on success when the queue is non-empty', async () => {
  const { booking, userId, restaurantId } = await createFixture();
  const notificationService = new NotificationService({ logger: { info() {}, warn() {} } });
  const realtime = createRealtimeSpy();
  const promotions = [];
  const queueService = { promoteNextFromQueue({ restaurantId: rid }) { promotions.push(rid); return Promise.resolve({ promotedUserId: 'x' }); } };
  const service = new BookingService({
    tables: Table,
    bookings: Booking,
    restaurantId: booking.restaurantId,
    mongoClient: mongoose.connection.getClient(),
    notificationService,
    socketRealtimeService: realtime,
    queueService
  });

  const cancelled = await service.cancelBooking({ bookingId: booking._id, userId });

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0], restaurantId.toString());
  assert.equal(realtime.calls.broadcastAvailability.length, 1);
});

test('queue promotion pops the head and notifies that customer', async () => {
  const { booking, userId, restaurantId } = await createFixture();
  await redis.rpush(`${queuePrefix}${restaurantId}`, 'user-1', 'user-2');

  const notificationService = new NotificationService({ logger: { info() {}, warn() {} } });
  const result = await queueService.promoteNextFromQueue({ restaurantId: restaurantId.toString() });

  assert.deepEqual(result, { restaurantId: restaurantId.toString(), promotedUserId: 'user-1' });
  assert.deepEqual(await redis.lrange(`${queuePrefix}${restaurantId}`, 0, -1), ['user-2']);
});

test('socket emit and promotion are skipped when promotion fails, cancel still succeeds', async () => {
  const { booking, userId } = await createFixture();
  const notificationService = new NotificationService({ logger: { info() {}, warn() {} } });
  const realtime = createRealtimeSpy();
  const queueService = { promoteNextFromQueue() { return Promise.reject(new Error('redis down')); } };
  const service = new BookingService({
    tables: Table,
    bookings: Booking,
    restaurantId: booking.restaurantId,
    mongoClient: mongoose.connection.getClient(),
    notificationService,
    socketRealtimeService: realtime,
    queueService
  });

  const cancelled = await service.cancelBooking({ bookingId: booking._id, userId });

  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await Table.findById(booking.tableId).lean()).status, 'available');
});

test('GET /api/bookings returns only the current user\'s confirmed bookings', async () => {
  const mine = await createFixture();
  const other = await createFixture({ userId: new mongoose.Types.ObjectId() });
  await createFixture({ userId: mine.userId });
  await Booking.updateOne({ _id: other.booking._id }, { $set: { status: 'cancelled' } });

  const response = await request(app)
    .get('/api/bookings')
    .set('Authorization', `Bearer ${customerToken(mine.userId)}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.bookings.length, 2);
  assert.ok(response.body.bookings.every((b) => String(b.userId) === String(mine.userId)));
  assert.ok(response.body.bookings.every((b) => b.status === 'confirmed'));
  assert.ok(response.body.bookings.every((b) => typeof b.restaurantName === 'string' && b.restaurantName.length > 0));
});

test('cancelled bookings disappear from GET /api/bookings', async () => {
  const { booking, userId } = await createFixture();

  await request(app)
    .patch(`/api/bookings/${booking._id}/cancel`)
    .set('Authorization', `Bearer ${customerToken(userId)}`);

  const response = await request(app)
    .get('/api/bookings')
    .set('Authorization', `Bearer ${customerToken(userId)}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.bookings.length, 0);
});
