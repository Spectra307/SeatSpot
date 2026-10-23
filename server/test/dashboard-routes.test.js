import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Booking } from '../src/models/booking.js';
import { Restaurant } from '../src/models/restaurant.js';
import { Table } from '../src/models/table.js';
import { User } from '../src/models/user.js';
import { DashboardService } from '../src/services/dashboard-service.js';

const jwtSecret = 'dashboard-test-jwt-secret';
const mongoUri = process.env.MONGO_URI
  ?? process.env.MONGODB_URI
  ?? 'mongodb://127.0.0.1:27017/seatspot?replicaSet=rs0';
const databaseName = `seatspot_dashboard_tests_${process.pid}`;

let app;
let restaurantAId;
let restaurantBId;
let tableAId;
let staffTokenA;
let staffTokenB;
let customerToken;
let testCustomerUser;

before(async () => {
  await mongoose.connect(mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
  await Promise.all([Booking.init(), Restaurant.init(), Table.init(), User.init()]);

  restaurantAId = new mongoose.Types.ObjectId();
  restaurantBId = new mongoose.Types.ObjectId();

  await Restaurant.create([
    {
      restaurantId: restaurantAId,
      name: 'Restaurant Alpha',
      location: { type: 'Point', coordinates: [80.2, 12.9] }
    },
    {
      restaurantId: restaurantBId,
      name: 'Restaurant Beta',
      location: { type: 'Point', coordinates: [80.3, 13.0] }
    }
  ]);

  const tableA = await Table.create({
    restaurantId: restaurantAId,
    label: 'T-A1',
    capacity: 4,
    status: 'available'
  });
  tableAId = tableA._id;

  testCustomerUser = await User.create({
    restaurantId: new mongoose.Types.ObjectId('000000000000000000000001'),
    name: 'Jane Customer',
    email: `customer-${process.pid}@seatspot.test`,
    passwordHash: 'dummy-hash',
    role: 'customer',
    isVerified: true
  });

  customerToken = jwt.sign({
    sub: testCustomerUser._id.toString(),
    role: 'customer',
    restaurantId: '000000000000000000000001',
    name: 'Jane Customer'
  }, jwtSecret);

  staffTokenA = jwt.sign({
    sub: new mongoose.Types.ObjectId().toString(),
    role: 'staff',
    restaurantId: restaurantAId.toString(),
    name: 'Staff Alpha'
  }, jwtSecret);

  staffTokenB = jwt.sign({
    sub: new mongoose.Types.ObjectId().toString(),
    role: 'staff',
    restaurantId: restaurantBId.toString(),
    name: 'Staff Beta'
  }, jwtSecret);

  const mockRealtime = {
    broadcastAvailability() {},
    broadcastBookingUpdate() {},
    broadcastQueueUpdate() {}
  };

  const dashboardService = new DashboardService({
    tables: Table,
    bookings: Booking,
    users: User,
    mongoClient: mongoose.connection.getClient(),
    socketRealtimeService: mockRealtime
  });

  app = createApp({
    dashboardService,
    restaurants: Restaurant,
    jwtSecret
  });
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('customers get 403 on all dashboard endpoints', async () => {
  const endpoints = [
    { method: 'get', path: `/api/restaurants/${restaurantAId}/dashboard/tables` },
    { method: 'get', path: `/api/restaurants/${restaurantAId}/dashboard/overview` },
    { method: 'get', path: `/api/restaurants/${restaurantAId}/dashboard/bookings` },
    { method: 'get', path: `/api/restaurants/${restaurantAId}/dashboard/stats` },
    { method: 'patch', path: `/api/restaurants/${restaurantAId}/dashboard/bookings/${new mongoose.Types.ObjectId()}/status`, body: { status: 'seated' } }
  ];

  for (const { method, path, body } of endpoints) {
    const res = await request(app)[method](path)
      .set('authorization', `Bearer ${customerToken}`)
      .send(body ?? {});
    assert.equal(res.status, 403, `Customer should get 403 on ${method.toUpperCase()} ${path}`);
  }
});

test('staff of restaurant A gets 403 on restaurant B bookings, stats, and status endpoints', async () => {
  const bBooking = await Booking.create({
    restaurantId: restaurantBId,
    tableId: new mongoose.Types.ObjectId(),
    userId: testCustomerUser._id,
    partySize: 2,
    startsAt: new Date(Date.now() + 3600000),
    status: 'confirmed'
  });

  // Accessing Restaurant B endpoints using staffTokenA
  const getBookingsRes = await request(app)
    .get(`/api/restaurants/${restaurantBId}/dashboard/bookings`)
    .set('authorization', `Bearer ${staffTokenA}`);
  assert.equal(getBookingsRes.status, 403, 'Staff A should get 403 on Restaurant B bookings');

  const getStatsRes = await request(app)
    .get(`/api/restaurants/${restaurantBId}/dashboard/stats`)
    .set('authorization', `Bearer ${staffTokenA}`);
  assert.equal(getStatsRes.status, 403, 'Staff A should get 403 on Restaurant B stats');

  const patchRes = await request(app)
    .patch(`/api/restaurants/${restaurantBId}/dashboard/bookings/${bBooking._id}/status`)
    .set('authorization', `Bearer ${staffTokenA}`)
    .send({ status: 'seated' });
  assert.equal(patchRes.status, 403, 'Staff A should get 403 on Restaurant B booking status patch');
});

test('staff of restaurant A gets 200 on restaurant A bookings, stats, and overview', async () => {
  const getBookingsRes = await request(app)
    .get(`/api/restaurants/${restaurantAId}/dashboard/bookings`)
    .set('authorization', `Bearer ${staffTokenA}`);
  assert.equal(getBookingsRes.status, 200);
  assert.ok(Array.isArray(getBookingsRes.body.bookings));

  const getStatsRes = await request(app)
    .get(`/api/restaurants/${restaurantAId}/dashboard/stats?range=7d`)
    .set('authorization', `Bearer ${staffTokenA}`);
  assert.equal(getStatsRes.status, 200);
  assert.equal(getStatsRes.body.days, 7);
  assert.ok(Array.isArray(getStatsRes.body.bookingsPerDay));
  assert.ok(Array.isArray(getStatsRes.body.peakHours));

  const getOverviewRes = await request(app)
    .get(`/api/restaurants/${restaurantAId}/dashboard/overview`)
    .set('authorization', `Bearer ${staffTokenA}`);
  assert.equal(getOverviewRes.status, 200);
  assert.ok(typeof getOverviewRes.body.tables === 'object');
  assert.ok(typeof getOverviewRes.body.bookingsToday === 'number');
});

test('status transitions: valid flow (confirmed -> seated -> completed) and frees table', async () => {
  const booking = await Booking.create({
    restaurantId: restaurantAId,
    tableId: tableAId,
    userId: testCustomerUser._id,
    partySize: 2,
    startsAt: new Date(Date.now() + 3600000),
    status: 'confirmed'
  });
  await Table.updateOne({ _id: tableAId }, { $set: { status: 'reserved' } });

  // 1. confirmed -> seated
  const seatedRes = await request(app)
    .patch(`/api/restaurants/${restaurantAId}/dashboard/bookings/${booking._id}/status`)
    .set('authorization', `Bearer ${staffTokenA}`)
    .send({ status: 'seated', restaurantId: 'hacked-id', userId: 'hacked-user' }); // Body IDs should be ignored
  assert.equal(seatedRes.status, 200);
  assert.equal(seatedRes.body.status, 'seated');
  assert.ok(seatedRes.body.seatedAt);

  const tableAfterSeated = await Table.findById(tableAId).lean();
  assert.equal(tableAfterSeated.status, 'occupied');

  // 2. seated -> completed
  const completedRes = await request(app)
    .patch(`/api/restaurants/${restaurantAId}/dashboard/bookings/${booking._id}/status`)
    .set('authorization', `Bearer ${staffTokenA}`)
    .send({ status: 'completed' });
  assert.equal(completedRes.status, 200);
  assert.equal(completedRes.body.status, 'completed');
  assert.ok(completedRes.body.completedAt);

  const tableAfterCompleted = await Table.findById(tableAId).lean();
  assert.equal(tableAfterCompleted.status, 'available', 'Completing frees the table');
});

test('invalid status transitions are rejected (e.g. completed -> seated, completed -> cancelled)', async () => {
  const completedBooking = await Booking.create({
    restaurantId: restaurantAId,
    tableId: tableAId,
    userId: testCustomerUser._id,
    partySize: 2,
    startsAt: new Date(Date.now() + 3600000),
    status: 'completed',
    completedAt: new Date()
  });

  const trySeated = await request(app)
    .patch(`/api/restaurants/${restaurantAId}/dashboard/bookings/${completedBooking._id}/status`)
    .set('authorization', `Bearer ${staffTokenA}`)
    .send({ status: 'seated' });
  assert.equal(trySeated.status, 400);

  const tryCancelled = await request(app)
    .patch(`/api/restaurants/${restaurantAId}/dashboard/bookings/${completedBooking._id}/status`)
    .set('authorization', `Bearer ${staffTokenA}`)
    .send({ status: 'cancelled' });
  assert.equal(tryCancelled.status, 400);
});

test('status transition confirmed -> no-show frees the table', async () => {
  const booking = await Booking.create({
    restaurantId: restaurantAId,
    tableId: tableAId,
    userId: testCustomerUser._id,
    partySize: 2,
    startsAt: new Date(Date.now() + 3600000),
    status: 'confirmed'
  });
  await Table.updateOne({ _id: tableAId }, { $set: { status: 'reserved' } });

  const noShowRes = await request(app)
    .patch(`/api/restaurants/${restaurantAId}/dashboard/bookings/${booking._id}/status`)
    .set('authorization', `Bearer ${staffTokenA}`)
    .send({ status: 'no-show' });
  assert.equal(noShowRes.status, 200);
  assert.equal(noShowRes.body.status, 'no-show');

  const table = await Table.findById(tableAId).lean();
  assert.equal(table.status, 'available', 'No-show frees the table');
});

test('bookings search by customer name, status filtering, and pagination', async () => {
  // Query with q=Jane
  const searchRes = await request(app)
    .get(`/api/restaurants/${restaurantAId}/dashboard/bookings?q=Jane&page=1&limit=5`)
    .set('authorization', `Bearer ${staffTokenA}`);
  assert.equal(searchRes.status, 200);
  assert.ok(searchRes.body.total >= 1);
  assert.ok(searchRes.body.bookings.every((b) => /Jane/i.test(b.customerName)));

  // Query with status=completed
  const statusRes = await request(app)
    .get(`/api/restaurants/${restaurantAId}/dashboard/bookings?status=completed`)
    .set('authorization', `Bearer ${staffTokenA}`);
  assert.equal(statusRes.status, 200);
  assert.ok(statusRes.body.bookings.every((b) => b.status === 'completed'));
});
