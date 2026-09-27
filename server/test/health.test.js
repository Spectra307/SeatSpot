import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';

test('GET /health returns a structured readiness response', async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const result = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { status: 'degraded', database: 'disconnected' });
});
