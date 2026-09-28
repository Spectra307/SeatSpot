import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Booking } from '../src/models/booking.js';
import { Restaurant } from '../src/models/restaurant.js';
import { Table } from '../src/models/table.js';
import { createBookingServiceFactory } from '../src/services/booking-service-factory.js';
import { QueueService } from '../src/services/queue-service.js';

const jwtSecret = 'booking-queue-test-secret';
const mongoUri = process.env.MONGO_URI
  ?? process.env.MONGODB_URI
  ?? 'mongodb://127.0.0.1:27017/seatspot?replicaSet=rs0';
const redisUrl = process.env.REDIS_URL
  ?? `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD ?? 'replace-with-a-strong-redis-password')}@127.0.0.1:6379`;
const databaseName = `seatspot_http_tests_${process.pid}`;
const queuePrefix = `seatspot:http-tests:${process.pid}:`;
let redis;
let app;

before(async () => {
  await mongoose.connect(mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
  await Promise.all([Restaurant.init(), Table.init(), Booking.init()]);

  redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();

  const bookingServiceFactory = createBookingServiceFactory({
    restaurants: Restaurant,
    tables: Table,
    bookings: Booking,
    mongoClient: mongoose.connection.getClient()
  });
  const queueService = new QueueService(redis, { queueKeyPrefix: queuePrefix });
  app = createApp({ bookingServiceFactory, queueService, restaurants: Restaurant, jwtSecret });
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

function customerToken(userId = new mongoose.Types.ObjectId().toString()) {
  return jwt.sign({
    sub: userId,
    role: 'customer',
    restaurantId: '000000000000000000000001'
  }, jwtSecret);
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