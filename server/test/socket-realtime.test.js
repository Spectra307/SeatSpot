import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createServer } from 'node:http';
import { io as Client } from 'socket.io-client';
import { SocketRealtimeService } from '../src/services/socket-realtime.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('rejects malformed or expired JWT before connection', async () => {
  const server = createServer();
  const service = new SocketRealtimeService({ jwtSecret: 'test-secret' });
  service.attach(server);
  await new Promise((resolve) => server.listen(0, resolve));

  const port = server.address().port;

  const badSocket = Client(`http://localhost:${port}`, {
    transports: ['websocket'],
    auth: { token: 'not-a-jwt' },
    forceNew: true
  });

  const malformed = await new Promise((resolve) => {
    badSocket.on('connect_error', (error) => resolve(error.message));
  });
  assert.match(malformed, /Authentication token is invalid or expired|required/i);

  const expiredToken = jwt.sign({ sub: 'user-1', restaurantId: 'r-1' }, 'test-secret', { expiresIn: '-1s' });
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
  await new Promise((resolve) => server.close(resolve));
});

test('connection rate limit rejects excess clients and per-event rate limits disconnect the socket', async () => {
  const server = createServer();
  const service = new SocketRealtimeService({ jwtSecret: 'test-secret', connectionLimitPerMinute: 2, eventLimitPerMinute: 1 });
  service.attach(server);
  await new Promise((resolve) => server.listen(0, resolve));

  const port = server.address().port;
  const token = jwt.sign({ sub: 'u-1', restaurantId: 'r-1' }, 'test-secret');

  const socketA = Client(`http://localhost:${port}`, { transports: ['websocket'], auth: { token }, forceNew: true });
  const socketB = Client(`http://localhost:${port}`, { transports: ['websocket'], auth: { token }, forceNew: true });
  const socketC = Client(`http://localhost:${port}`, { transports: ['websocket'], auth: { token }, forceNew: true });

  const connected = await Promise.all([
    new Promise((resolve) => socketA.on('connect', resolve)),
    new Promise((resolve) => socketB.on('connect', resolve)),
    new Promise((resolve) => socketC.on('connect_error', resolve))
  ]);

  assert.ok(connected[2]);

  socketA.emit('availability:update', { tableId: 't-1' });
  socketA.emit('availability:update', { tableId: 't-2' });

  await wait(50);

  assert.equal(socketA.disconnected, true);
  socketA.close();
  socketB.close();
  socketC.close();
  await new Promise((resolve) => server.close(resolve));
});

test('disconnect cleanup prevents stale state and duplicate stale events after reconnect', async () => {
  const server = createServer();
  const service = new SocketRealtimeService({ jwtSecret: 'test-secret', eventLimitPerMinute: 5 });
  service.attach(server);
  await new Promise((resolve) => server.listen(0, resolve));

  const port = server.address().port;
  const token = jwt.sign({ sub: 'u-1', restaurantId: 'r-1' }, 'test-secret');

  const socket = Client(`http://localhost:${port}`, { transports: ['websocket'], auth: { token }, forceNew: true });
  await new Promise((resolve) => socket.on('connect', resolve));

  socket.emit('join-restaurant', 'r-1');
  await new Promise((resolve) => socket.on('joined-restaurant', resolve));

  socket.close();
  await wait(50);

  const reconnected = Client(`http://localhost:${port}`, { transports: ['websocket'], auth: { token }, forceNew: true });
  await new Promise((resolve) => reconnected.on('connect', resolve));

  service.broadcastQueueUpdate('r-1', { queueLength: 2 });
  const updateCount = await new Promise((resolve) => {
    let count = 0;
    reconnected.on('queue:update', () => {
      count += 1;
      if (count >= 1) resolve(count);
    });
  });

  assert.equal(updateCount, 1);
  reconnected.close();
  await new Promise((resolve) => server.close(resolve));
});

test('broadcasting to zero connected clients is a no-op and does not throw', async () => {
  const server = createServer();
  const service = new SocketRealtimeService({ jwtSecret: 'test-secret' });
  service.attach(server);
  await new Promise((resolve) => server.listen(0, resolve));

  assert.doesNotThrow(() => service.broadcastQueueUpdate('empty-restaurant', { queueLength: 0 }));
  assert.doesNotThrow(() => service.broadcastAvailability('empty-restaurant', { tableId: 't-1', available: true }));

  await new Promise((resolve) => server.close(resolve));
});
