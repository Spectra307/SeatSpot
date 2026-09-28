import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';

test('the /api HTTP rate limiter returns 429 after the configured limit', async () => {
  const app = createApp({ apiRateLimitOptions: { limit: 2, windowMs: 60_000 } });
  const first = await request(app).get('/api/unknown');
  const second = await request(app).get('/api/unknown');
  const limited = await request(app).get('/api/unknown');

  assert.equal(first.status, 404);
  assert.equal(second.status, 404);
  assert.equal(limited.status, 429);
});