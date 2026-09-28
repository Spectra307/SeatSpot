import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { QueueService } from '../src/services/queue-service.js';

const redisUrl = process.env.REDIS_URL
  ?? `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD ?? 'replace-with-a-strong-redis-password')}@127.0.0.1:6379`;
const queueKeyPrefix = `seatspot:queue-integration:${process.pid}:`;
const restaurantId = 'queue-integration-restaurant';
let redis;
let service;

before(async () => {
  redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  service = new QueueService(redis, { queueKeyPrefix });
});

beforeEach(async () => {
  await redis.del(`${queueKeyPrefix}${restaurantId}`);
});

after(async () => {
  if (redis?.status === 'ready') {
    const keys = await redis.keys(`${queueKeyPrefix}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
});

test('real Redis deduplicates joins and reports leaving a non-member as 404', async () => {
  const first = await service.joinQueue({ restaurantId, userId: 'user-a' });
  const duplicate = await service.joinQueue({ restaurantId, userId: 'user-a' });

  assert.equal(first.position, 1);
  assert.equal(first.alreadyInQueue, false);
  assert.equal(duplicate.position, 1);
  assert.equal(duplicate.alreadyInQueue, true);
  await assert.rejects(
    service.leaveQueue({ restaurantId, userId: 'not-queued' }),
    (error) => error.status === 404
  );
});

test('real Redis shifts positions after a user ahead leaves', async () => {
  await service.joinQueue({ restaurantId, userId: 'first' });
  await service.joinQueue({ restaurantId, userId: 'second' });
  await service.joinQueue({ restaurantId, userId: 'third' });

  await service.leaveQueue({ restaurantId, userId: 'first' });
  assert.equal(await service.getQueuePosition({ restaurantId, userId: 'second' }), 1);
  assert.equal(await service.getQueuePosition({ restaurantId, userId: 'third' }), 2);
});

test('twenty concurrent real Redis joins retain every user in order', async () => {
  const users = Array.from({ length: 20 }, (_, index) => `concurrent-${String(index).padStart(2, '0')}`);
  const results = await Promise.all(users.map((userId) => service.joinQueue({ restaurantId, userId })));

  assert.deepEqual(await redis.lrange(`${queueKeyPrefix}${restaurantId}`, 0, -1), users);
  assert.deepEqual(results.map((result) => result.position), users.map((_, index) => index + 1));
  assert.equal(results.every((result) => !result.alreadyInQueue), true);
});