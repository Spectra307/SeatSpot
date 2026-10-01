import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';

test('nearby restaurants require JWT and return availability to authenticated users', async () => {
  const restaurantService = { nearby: async () => [{ name: 'Garden Table', availability: { available: 3, total: 5 } }] };
  const server = createApp({ restaurantService, jwtSecret: 'test-secret' }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const request = (headers = {}) => new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/api/restaurants/nearby?latitude=12.9&longitude=80.2`, { headers }, (response) => { let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) })); }).on('error', reject));

  assert.equal((await request()).status, 401);
  const token = jwt.sign({ sub: 'user-1' }, 'test-secret');
  const result = await request({ authorization: `Bearer ${token}` });
  assert.equal(result.status, 200);
  assert.equal(result.body.restaurants[0].availability.available, 3);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('nearby search forwards radius, sort, open-only, and limit options to the service', async () => {
  const received = [];
  const restaurantService = {
    nearby: async (query) => {
      received.push(query);
      return [];
    }
  };
  const server = createApp({ restaurantService, jwtSecret: 'test-secret' }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const token = jwt.sign({ sub: 'user-1', role: 'customer' }, 'test-secret');

  const result = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/restaurants/nearby?latitude=12.9255&longitude=80.2201&radiusMeters=2500&sort=availability&openOnly=true&limit=12`, { headers: { authorization: `Bearer ${token}` } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });

  assert.equal(result.status, 200);
  assert.equal(received[0].radiusMeters, '2500');
  assert.equal(received[0].sort, 'availability');
  assert.equal(received[0].openOnly, 'true');
  assert.equal(received[0].limit, '12');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
