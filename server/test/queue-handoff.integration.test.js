import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { Booking } from '../src/models/booking.js';
import { Restaurant } from '../src/models/restaurant.js';
import { Table } from '../src/models/table.js';
import { BookingService } from '../src/services/booking-service.js';
import { createBookingServiceFactory } from '../src/services/booking-service-factory.js';
import { NotificationService } from '../src/services/notification-service.js';
import { QueueService } from '../src/services/queue-service.js';

const mongoUri = process.env.MONGO_URI
  ?? process.env.MONGODB_URI
  ?? 'mongodb://127.0.0.1:27017/seatspot?replicaSet=rs0';
const redisUrl = process.env.REDIS_URL
  ?? `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD ?? 'replace-with-a-strong-redis-password')}@127.0.0.1:6379`;
const databaseName = `seatspot_handoff_tests_${process.pid}`;
const keyPrefix = `seatspot:handoff-tests:${process.pid}:`;
const restaurantId = new mongoose.Types.ObjectId();
let redis;
let queueService;

before(async () => {
  await mongoose.connect(mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
  await Promise.all([Booking.init(), Restaurant.init(), Table.init()]);
  redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  queueService = new QueueService(redis, {
    queueKeyPrefix: keyPrefix,
    bookings: Booking,
    bookingServiceFactory: createBookingServiceFactory({
      restaurants: Restaurant,
      tables: Table,
      bookings: Booking,
      mongoClient: mongoose.connection.getClient()
    })
  });
});

beforeEach(async () => {
  await Promise.all([
    Booking.deleteMany({}),
    Table.deleteMany({}),
    Restaurant.deleteMany({})
  ]);
  const keys = await redis.keys(`${keyPrefix}*`);
  if (keys.length) await redis.del(...keys);
  await Restaurant.create({
    restaurantId,
    name: `Handoff ${restaurantId}`,
    location: { type: 'Point', coordinates: [0, 0] }
  });
});

after(async () => {
  if (redis?.status === 'ready') {
    const keys = await redis.keys(`${keyPrefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

async function createTable(status = 'available') {
  return Table.create({
    restaurantId,
    label: `T-${new mongoose.Types.ObjectId()}`,
    capacity: 4,
    status
  });
}

function newUserId() {
  return new mongoose.Types.ObjectId().toString();
}

test('handoff cleans already-booked queue members before seating the next user', async () => {
  const activeTable = await createTable('reserved');
  const freeTable = await createTable();
  const alreadyBookedUser = newUserId();
  const queuedUser = newUserId();
  await Booking.create({
    restaurantId,
    tableId: activeTable._id,
    userId: alreadyBookedUser,
    partySize: 2,
    startsAt: new Date(Date.now() + 3600000),
    status: 'confirmed'
  });
  await queueService.joinQueue({ restaurantId: restaurantId.toString(), userId: alreadyBookedUser });
  await queueService.joinQueue({ restaurantId: restaurantId.toString(), userId: queuedUser });

  const result = await queueService.handoffNextCustomer({
    restaurantId: restaurantId.toString(),
    staffId: 'staff-a',
    tableId: freeTable._id.toString()
  });

  assert.equal(result.seatedUserId, queuedUser);
  assert.equal(await Booking.countDocuments({ restaurantId, userId: alreadyBookedUser, status: 'confirmed' }), 1);
  assert.equal(await Booking.countDocuments({ restaurantId, userId: queuedUser, status: 'confirmed' }), 1);
  assert.deepEqual(await redis.lrange(`${keyPrefix}${restaurantId}`, 0, -1), []);
});

test('two concurrent handoffs for the same front customer produce one booking', async () => {
  const table = await createTable();
  const userId = newUserId();
  await queueService.joinQueue({ restaurantId: restaurantId.toString(), userId });

  const results = await Promise.allSettled([
    queueService.handoffNextCustomer({ restaurantId: restaurantId.toString(), staffId: 'staff-a', tableId: table._id.toString() }),
    queueService.handoffNextCustomer({ restaurantId: restaurantId.toString(), staffId: 'staff-b', tableId: table._id.toString() })
  ]);
  const succeeded = results.filter((result) => result.status === 'fulfilled' && result.value);
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(succeeded.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(await Booking.countDocuments({ restaurantId, userId, status: 'confirmed' }), 1);
});

test('booking transaction failure rolls back the table and preserves the queue entry', async () => {
  const table = await createTable();
  const userId = newUserId();
  await queueService.joinQueue({ restaurantId: restaurantId.toString(), userId });
  const failingBookings = {
    findOne(...args) { return Booking.findOne(...args); },
    create() { throw new Error('injected booking insert failure'); }
  };
  const failingService = new QueueService(redis, {
    queueKeyPrefix: keyPrefix,
    bookings: Booking,
    bookingServiceFactory: async () => new BookingService({
      tables: Table,
      bookings: failingBookings,
      restaurantId,
      mongoClient: mongoose.connection.getClient()
    })
  });

  await assert.rejects(
    failingService.handoffNextCustomer({ restaurantId: restaurantId.toString(), staffId: 'staff-a', tableId: table._id.toString() }),
    (error) => error.status === 503
  );
  assert.equal((await Table.findById(table._id).lean()).status, 'available');
  assert.deepEqual(await redis.lrange(`${keyPrefix}${restaurantId}`, 0, -1), [userId]);
});

test('Redis removal failure after commit is recovered on retry without a second booking', async () => {
  const table = await createTable();
  const userId = newUserId();
  const queueKey = `${keyPrefix}${restaurantId}`;
  await queueService.joinQueue({ restaurantId: restaurantId.toString(), userId });
  let failRemoval = true;
  const redisWithOneRemovalFailure = new Proxy(redis, {
    get(target, property) {
      if (property === 'lrem') {
        return async (...args) => {
          if (failRemoval && args[0] === queueKey) {
            failRemoval = false;
            throw new Error('injected Redis removal failure');
          }
          return target.lrem(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const retryableService = new QueueService(redisWithOneRemovalFailure, {
    queueKeyPrefix: keyPrefix,
    bookings: Booking,
    bookingServiceFactory: queueService.bookingServiceFactory
  });

  await assert.rejects(
    retryableService.handoffNextCustomer({ restaurantId: restaurantId.toString(), staffId: 'staff-a', tableId: table._id.toString() }),
    (error) => error.status === 503
  );
  assert.equal(await Booking.countDocuments({ restaurantId, userId, status: 'confirmed' }), 1);
  assert.deepEqual(await redis.lrange(queueKey, 0, -1), [userId]);

  const retried = await retryableService.handoffNextCustomer({
    restaurantId: restaurantId.toString(),
    staffId: 'staff-b',
    tableId: table._id.toString()
  });
  assert.equal(retried, null);
  assert.equal(await Booking.countDocuments({ restaurantId, userId, status: 'confirmed' }), 1);
  assert.deepEqual(await redis.lrange(queueKey, 0, -1), []);
});

test('throwing and hanging booking/promotion notifications never fail a queue handoff', async () => {
  const providers = [
    { send() { throw new Error('notification provider failed'); } },
    { send() { return new Promise(() => {}); } }
  ];

  for (const provider of providers) {
    const notificationService = new NotificationService({
      provider,
      logger: { info() {}, warn() {} },
      timeoutMs: 20
    });
    const bookingServiceFactory = createBookingServiceFactory({
      restaurants: Restaurant,
      tables: Table,
      bookings: Booking,
      mongoClient: mongoose.connection.getClient(),
      notificationService
    });
    const notifiedQueueService = new QueueService(redis, {
      queueKeyPrefix: keyPrefix,
      bookings: Booking,
      bookingServiceFactory,
      notificationService
    });
    const table = await createTable();
    const userId = newUserId();
    await notifiedQueueService.joinQueue({ restaurantId: restaurantId.toString(), userId });
    const result = await notifiedQueueService.handoffNextCustomer({
      restaurantId: restaurantId.toString(),
      staffId: 'staff-a',
      tableId: table._id.toString()
    });

    assert.equal(result.seatedUserId, userId);
    assert.equal(await Booking.countDocuments({ restaurantId, userId, status: 'confirmed' }), 1);
  }
});