import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { io as Client } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { Booking } from '../src/models/booking.js';
import { Restaurant } from '../src/models/restaurant.js';
import { Table } from '../src/models/table.js';
import { User } from '../src/models/user.js';
import { AuthService } from '../src/services/auth-service.js';
import { createBookingServiceFactory } from '../src/services/booking-service-factory.js';
import { DashboardService } from '../src/services/dashboard-service.js';
import { LoginAttemptStore } from '../src/services/login-attempt-store.js';
import { NotificationService } from '../src/services/notification-service.js';
import { OtpStore } from '../src/services/otp-store.js';
import { QueueService } from '../src/services/queue-service.js';
import { RestaurantService } from '../src/services/restaurant-service.js';
import { SocketRealtimeService } from '../src/services/socket-realtime.js';

const jwtSecret = 'seatspot-e2e-test-secret';
const mongoUri = process.env.MONGO_URI
  ?? process.env.MONGODB_URI
  ?? 'mongodb://127.0.0.1:27017/seatspot?replicaSet=rs0';
const redisUrl = process.env.REDIS_URL
  ?? `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD ?? 'replace-with-a-strong-redis-password')}@127.0.0.1:6379`;
const databaseName = `seatspot_e2e_${process.pid}`;
const queuePrefix = `seatspot:e2e:${process.pid}:`;
const loginKeyPrefix = `seatspot:e2e:login:${process.pid}:`;
const authPartitionRestaurantId = '000000000000000000000001';
let redis;
let appServer;
let baseUrl;
let app;
let realtime;
let socket;
let emails = [];

before(async () => {
  await mongoose.connect(mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
  await Promise.all([Booking.init(), Restaurant.init(), Table.init(), User.init()]);
  redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();

  const notificationService = new NotificationService({ logger: { info() {}, warn() {} } });
  realtime = new SocketRealtimeService({ jwtSecret, restaurants: Restaurant });
  const authService = new AuthService({
    users: User,
    otpStore: new OtpStore(redis, 300),
    loginAttemptStore: new LoginAttemptStore(redis, { keyPrefix: loginKeyPrefix }),
    jwtSecret,
    jwtExpiresIn: '1h',
    authPartitionRestaurantId
  });
  const bookingServiceFactory = createBookingServiceFactory({
    restaurants: Restaurant,
    tables: Table,
    bookings: Booking,
    mongoClient: mongoose.connection.getClient(),
    notificationService,
    socketRealtimeService: realtime
  });
  const queueService = new QueueService(redis, {
    queueKeyPrefix: queuePrefix,
    bookings: Booking,
    bookingServiceFactory,
    notificationService,
    socketRealtimeService: realtime
  });
  const restaurantService = new RestaurantService({
    restaurants: Restaurant,
    tables: Table,
    mapsClient: { enabled: false }
  });
  const dashboardService = new DashboardService({
    tables: Table,
    bookings: Booking,
    queueService,
    bookingServiceFactory,
    mongoClient: mongoose.connection.getClient(),
    socketRealtimeService: realtime
  });
  app = createApp({
    authService,
    restaurantService,
    bookingServiceFactory,
    queueService,
    dashboardService,
    restaurants: Restaurant,
    jwtSecret,
    exposeOtp: true
  });
  appServer = createServer(app);
  realtime.attach(appServer);
  await new Promise((resolve) => appServer.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => {
  socket?.disconnect();
  if (realtime?.io) await new Promise((resolve) => realtime.io.close(resolve));
  else if (appServer?.listening) await new Promise((resolve) => appServer.close(resolve));

  if (redis?.status === 'ready') {
    const keys = await redis.keys(`${queuePrefix}*`);
    keys.push(...await redis.keys(`${loginKeyPrefix}*`));
    for (const email of emails) keys.push(`otp:code:${email}`, `otp:attempts:${email}`, `otp:requests:${email}`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

async function callApi(method, path, { body, token } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function createRestaurant({ name, tableStatus, coordinates = [80.2201, 12.9255] }) {
  const restaurantId = new mongoose.Types.ObjectId();
  const restaurant = await Restaurant.create({
    restaurantId,
    name,
    location: { type: 'Point', coordinates }
  });
  const table = await Table.create({
    restaurantId,
    label: `E2E-${new mongoose.Types.ObjectId()}`,
    capacity: 4,
    status: tableStatus
  });
  return { restaurant, restaurantId: restaurantId.toString(), table };
}

async function createStaff(restaurantId, slug) {
  const email = `${slug}-${process.pid}@example.com`;
  const password = 'staff-password-123';
  await User.create({
    restaurantId,
    name: `${slug} staff`,
    email,
    passwordHash: await bcrypt.hash(password, 4),
    role: 'staff',
    isVerified: true
  });
  const login = await callApi('POST', '/api/auth/login', { body: { email, password, restaurantId: restaurantId.toString() } });
  assert.equal(login.status, 200);
  return login.body.token;
}

function receive(socketClient, eventName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), 3000);
    socketClient.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test('real app E2E: signup/search/book/availability and full-restaurant queue handoff', async () => {
  const email = `customer-${process.pid}@example.com`;
  emails.push(email);
  const signup = await callApi('POST', '/api/auth/signup', {
    body: { name: 'E2E Customer', email, password: 'customer-password-123' }
  });
  assert.equal(signup.status, 201);

  const verification = await callApi('POST', '/api/auth/verify-otp', {
    body: { email, otp: signup.body.otp }
  });
  assert.equal(verification.status, 200);
  const login = await callApi('POST', '/api/auth/login', {
    body: { email, password: 'customer-password-123' }
  });
  assert.equal(login.status, 200);
  const customerToken = login.body.token;
  const customerClaims = JSON.parse(Buffer.from(customerToken.split('.')[1], 'base64url').toString());

  const firstRestaurant = await createRestaurant({ name: 'E2E Search Restaurant', tableStatus: 'available' });
  const search = await callApi('GET', '/api/restaurants/nearby?latitude=12.9255&longitude=80.2201', { token: customerToken });
  assert.equal(search.status, 200);
  assert.ok(search.body.restaurants.some((restaurant) => restaurant.restaurantId === firstRestaurant.restaurantId));

  const booking = await callApi('POST', `/api/restaurants/${firstRestaurant.restaurantId}/bookings`, {
    token: customerToken,
    body: { tableId: firstRestaurant.table._id.toString(), partySize: 2, startsAt: new Date(Date.now() + 3600000).toISOString() }
  });
  assert.equal(booking.status, 201);
  assert.equal(booking.body.userId, customerClaims.sub);

  socket = Client(baseUrl, { transports: ['websocket'], auth: { token: customerToken }, forceNew: true, reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const joinedAvailability = receive(socket, 'room:joined');
  socket.emit('join-room', `availability:${firstRestaurant.restaurantId}`);
  assert.equal((await joinedAvailability).room, `availability:${firstRestaurant.restaurantId}`);

  const availabilityUpdate = receive(socket, 'availability:update');
  const staffToken = await createStaff(firstRestaurant.restaurant.restaurantId, 'e2e-first-restaurant');
  const changed = await callApi('PATCH', `/api/restaurants/${firstRestaurant.restaurantId}/dashboard/tables/${firstRestaurant.table._id}/status`, {
    token: staffToken,
    body: { status: 'occupied' }
  });
  assert.equal(changed.status, 200);
  const publicUpdate = await availabilityUpdate;
  assert.equal(publicUpdate.restaurantId, firstRestaurant.restaurantId);
  assert.equal(publicUpdate.payload.occupied, 1);
  assert.equal(publicUpdate.payload.userId, undefined);

  const fullRestaurant = await createRestaurant({
    name: 'E2E Full Restaurant',
    tableStatus: 'occupied',
    coordinates: [80.3, 12.9]
  });
  const staffTokenForFull = await createStaff(fullRestaurant.restaurant.restaurantId, 'e2e-full-restaurant');
  const queued = await callApi('POST', `/api/restaurants/${fullRestaurant.restaurantId}/queue`, { token: customerToken });
  assert.equal(queued.status, 201);
  assert.equal(queued.body.position, 1);

  const promotion = receive(socket, 'queue:promoted');
  const freed = await callApi('PATCH', `/api/restaurants/${fullRestaurant.restaurantId}/dashboard/tables/${fullRestaurant.table._id}/status`, {
    token: staffTokenForFull,
    body: { status: 'available' }
  });
  assert.equal(freed.status, 200);
  const handoff = await callApi('POST', `/api/restaurants/${fullRestaurant.restaurantId}/dashboard/queue/handoff`, {
    token: staffTokenForFull,
    body: { tableId: fullRestaurant.table._id.toString(), partySize: 2 }
  });
  assert.equal(handoff.status, 200);
  const promoted = await promotion;
  assert.equal(promoted.bookingId, handoff.body.booking._id);
  assert.equal(promoted.restaurantId, fullRestaurant.restaurantId);
  assert.equal(await Booking.countDocuments({
    restaurantId: fullRestaurant.restaurant.restaurantId,
    userId: customerClaims.sub,
    source: 'queue',
    status: 'confirmed'
  }), 1);
});
