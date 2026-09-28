import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createServer } from 'node:http';
import { io as Client } from 'socket.io-client';
import { Restaurant } from '../src/models/restaurant.js';
import { SocketRealtimeService } from '../src/services/socket-realtime.js';

const jwtSecret = 'test-secret';
const mongoUri = process.env.MONGO_URI
  ?? process.env.MONGODB_URI
  ?? 'mongodb://127.0.0.1:27017/seatspot?replicaSet=rs0';
const databaseName = `seatspot_socket_tests_${process.pid}`;
const customerPartitionId = '000000000000000000000001';
const servers = [];
const sockets = [];

before(async () => {
  await mongoose.connect(mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  await Promise.all(servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))));
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

function createToken({ sub, role = 'customer', restaurantId = customerPartitionId }) {
  return jwt.sign({ sub, role, restaurantId }, jwtSecret);
}

async function startSocketServer(options = {}) {
  const server = createServer();
  const service = new SocketRealtimeService({ jwtSecret, restaurants: Restaurant, ...options });
  service.attach(server);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, service, port: server.address().port };
}

function connectSocket(port, token) {
  const socket = Client(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth: { token },
    forceNew: true,
    reconnection: false
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function waitForEvent(socket, eventName, emittedEvent, payload) {
  return new Promise((resolve) => {
    socket.once(eventName, resolve);
    socket.emit(emittedEvent, payload);
  });
}

async function createRestaurant() {
  const restaurantId = new mongoose.Types.ObjectId();
  await Restaurant.create({
    restaurantId,
    name: `Socket test ${restaurantId}`,
    location: { type: 'Point', coordinates: [0, 0] }
  });
  return restaurantId.toString();
}

test('rejects malformed or expired JWT before connection', async () => {
  const { port } = await startSocketServer();

  const badSocket = Client(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth: { token: 'not-a-jwt' },
    forceNew: true
  });

  const malformed = await new Promise((resolve) => {
    badSocket.on('connect_error', (error) => resolve(error.message));
  });
  assert.match(malformed, /Authentication token is invalid or expired|required/i);

  const expiredToken = jwt.sign({ sub: 'user-1', role: 'customer', restaurantId: customerPartitionId }, jwtSecret, { expiresIn: '-1s' });
  const expiredSocket = Client(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth: { token: expiredToken },
    forceNew: true
  });

  const expired = await new Promise((resolve) => {
    expiredSocket.on('connect_error', (error) => resolve(error.message));
  });
  assert.match(expired, /expired|invalid/i);

  badSocket.close();
  expiredSocket.close();
});

test('connection rate limit rejects excess clients and per-event rate limits disconnect the socket', async () => {
  const restaurantId = new mongoose.Types.ObjectId().toString();
  const { port } = await startSocketServer({ connectionLimitPerMinute: 2, eventLimitPerMinute: 1 });
  const token = createToken({ sub: 'staff-1', role: 'staff', restaurantId });

  const socketA = await connectSocket(port, token);
  const socketB = await connectSocket(port, token);
  const socketC = Client(`http://localhost:${port}`, { transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false });
  sockets.push(socketC);

  const limitedConnection = await new Promise((resolve) => socketC.once('connect_error', resolve));
  assert.match(limitedConnection.message, /Connection rate limit exceeded/);

  const disconnected = new Promise((resolve) => socketA.once('disconnect', resolve));
  socketA.emit('availability:update', { tableId: 't-1' });
  socketA.emit('availability:update', { tableId: 't-2' });
  await disconnected;
  assert.equal(socketA.disconnected, true);
  socketA.close();
  socketB.close();
  socketC.close();
});

test('disconnect cleanup prevents stale state and duplicate stale events after reconnect', async () => {
  const { port, service } = await startSocketServer({ eventLimitPerMinute: 5 });
  const token = createToken({ sub: 'user-reconnect', role: 'customer' });
  const socket = await connectSocket(port, token);
  assert.equal(service.socketState.size, 1);

  const serverSocket = service.io.of('/').sockets.get(socket.id);
  const disconnected = new Promise((resolve) => serverSocket.once('disconnect', resolve));
  socket.close();
  await disconnected;
  assert.equal(service.socketState.size, 0);
  assert.equal(service.eventBuckets.size, 0);

  const reconnected = await connectSocket(port, token);
  const promoted = waitForEvent(reconnected, 'queue:promoted', 'noop');
  service.emitToUser('user-reconnect', 'queue:promoted', { position: 1 });
  assert.deepEqual(await promoted, { position: 1 });
  reconnected.close();
});

test('broadcasting to zero connected clients is a no-op and does not throw', async () => {
  const { service } = await startSocketServer();

  assert.doesNotThrow(() => service.broadcastQueueUpdate('empty-restaurant', { queueLength: 0 }));
  assert.doesNotThrow(() => service.broadcastAvailability('empty-restaurant', { available: 0, total: 0 }));
});

test('staff can join only their token restaurant staff room', async () => {
  const restaurantA = await createRestaurant();
  const restaurantB = await createRestaurant();
  const { port } = await startSocketServer();
  const socket = await connectSocket(port, createToken({ sub: 'staff-a', role: 'staff', restaurantId: restaurantA }));

  const denied = await waitForEvent(socket, 'room:error', 'join-room', `staff:${restaurantB}`);
  assert.equal(denied.room, `staff:${restaurantB}`);
  assert.equal(socket.connected, true);

  const allowed = await waitForEvent(socket, 'room:joined', 'join-room', `staff:${restaurantA}`);
  assert.equal(allowed.room, `staff:${restaurantA}`);
});

test('customers cannot request staff or another user room and may join only existing availability rooms', async () => {
  const restaurantId = await createRestaurant();
  const nonexistentRestaurantId = new mongoose.Types.ObjectId().toString();
  const { port } = await startSocketServer();
  const socket = await connectSocket(port, createToken({ sub: 'customer-a', role: 'customer' }));

  const staffDenied = await waitForEvent(socket, 'room:error', 'join-room', `staff:${restaurantId}`);
  assert.equal(staffDenied.room, `staff:${restaurantId}`);
  assert.equal(socket.connected, true);

  const userDenied = await waitForEvent(socket, 'room:error', 'join-room', 'user:customer-b');
  assert.equal(userDenied.room, 'user:customer-b');
  assert.equal(socket.connected, true);

  const allowed = await waitForEvent(socket, 'room:joined', 'join-room', `availability:${restaurantId}`);
  assert.equal(allowed.room, `availability:${restaurantId}`);

  const missing = await waitForEvent(socket, 'room:error', 'join-room', `availability:${nonexistentRestaurantId}`);
  assert.equal(missing.room, `availability:${nonexistentRestaurantId}`);
  assert.equal(socket.connected, true);
});

test('private booking events reach only the target user and public availability omits identifiers', async () => {
  const restaurantId = await createRestaurant();
  const { port, service } = await startSocketServer();
  const userA = await connectSocket(port, createToken({ sub: 'user-a', role: 'customer' }));
  const userB = await connectSocket(port, createToken({ sub: 'user-b', role: 'customer' }));
  const publicClient = await connectSocket(port, createToken({ sub: 'user-public', role: 'customer' }));
  await waitForEvent(publicClient, 'room:joined', 'join-room', `availability:${restaurantId}`);

  const eventsForB = [];
  const eventsForPublic = [];
  userB.on('booking:confirmed', (payload) => eventsForB.push(payload));
  publicClient.on('booking:confirmed', (payload) => eventsForPublic.push(payload));
  const privateEvent = new Promise((resolve) => userA.once('booking:confirmed', resolve));
  service.emitToUser('user-a', 'booking:confirmed', { bookingId: 'booking-a' });
  assert.deepEqual(await privateEvent, { bookingId: 'booking-a' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(eventsForB, []);
  assert.deepEqual(eventsForPublic, []);

  const availability = new Promise((resolve) => publicClient.once('availability:update', resolve));
  service.broadcastAvailability(restaurantId, {
    available: 3,
    total: 5,
    userId: 'user-a',
    bookingId: 'booking-a',
    tableId: 'private-table-id'
  });
  const update = await availability;
  assert.deepEqual(update.payload, { available: 3, total: 5 });

});
