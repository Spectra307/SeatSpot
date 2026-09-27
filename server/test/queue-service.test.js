import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueService } from '../src/services/queue-service.js';

class FakeRedis {
  constructor(initialQueue = []) {
    this.store = new Map();
    this.watchKeys = new Set();
    this.versions = new Map();
    this.queueKey = 'queue:restaurant-1';
    if (initialQueue.length > 0) {
      this.store.set(this.queueKey, [...initialQueue]);
      this.versions.set(this.queueKey, 0);
    }
  }

  _touch(key) {
    const nextVersion = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, nextVersion);
  }

  async lpos(key, value) {
    const items = this.store.get(key) ?? [];
    const index = items.indexOf(value);
    return index === -1 ? null : index;
  }

  async rpush(key, ...values) {
    const list = this.store.get(key) ?? [];
    list.push(...values);
    this.store.set(key, list);
    this._touch(key);
    return list.length;
  }

  async lrem(key, count, value) {
    const list = this.store.get(key) ?? [];
    if (count === 0) {
      const next = list.filter((entry) => entry !== value);
      const removed = list.length - next.length;
      this.store.set(key, next);
      this._touch(key);
      return removed;
    }

    const remaining = [...list];
    let removed = 0;
    const next = [];
    for (const entry of remaining) {
      if (removed < count && entry === value) {
        removed += 1;
        continue;
      }
      next.push(entry);
    }

    this.store.set(key, next);
    this._touch(key);
    return removed;
  }

  async llen(key) {
    return (this.store.get(key) ?? []).length;
  }

  async lrange(key, start, end) {
    const items = this.store.get(key) ?? [];
    return items.slice(start, end === -1 ? undefined : end + 1);
  }

  async watch(key) {
    this.watchKeys.add(key);
    this.currentWatchVersion = this.versions.get(key) ?? 0;
  }

  async unwatch() {
    this.watchKeys.clear();
    this.currentWatchVersion = undefined;
  }

  multi() {
    const tx = this;
    const watchedKey = this.queueKey;
    const watchedVersion = this.currentWatchVersion ?? (this.versions.get(watchedKey) ?? 0);

    return {
      lrem(key, count, value) {
        tx.pendingRemovals = { key, count, value };
        return this;
      },
      async exec() {
        const latestVersion = tx.versions.get(watchedKey) ?? 0;
        if (latestVersion !== watchedVersion) {
          return null;
        }

        if (tx.pendingRemovals) {
          await tx.lrem(tx.pendingRemovals.key, tx.pendingRemovals.count, tx.pendingRemovals.value);
        }

        return ['OK'];
      }
    };
  }
}

test('joinQueue deduplicates and returns the current position', async () => {
  const redis = new FakeRedis(['user-1', 'user-2']);
  const service = new QueueService(redis);

  const firstJoin = await service.joinQueue({ restaurantId: 'restaurant-1', userId: 'user-3' });
  assert.equal(firstJoin.position, 3);
  assert.deepEqual(await redis.lrange('queue:restaurant-1', 0, -1), ['user-1', 'user-2', 'user-3']);

  const duplicateJoin = await service.joinQueue({ restaurantId: 'restaurant-1', userId: 'user-3' });
  assert.equal(duplicateJoin.alreadyInQueue, true);
  assert.equal(duplicateJoin.position, 3);
});

test('leaveQueue removes a valid member and rejects a non-member', async () => {
  const redis = new FakeRedis(['user-1', 'user-2', 'user-3']);
  const service = new QueueService(redis);

  const removed = await service.leaveQueue({ restaurantId: 'restaurant-1', userId: 'user-2' });
  assert.equal(removed.removed, 1);
  assert.deepEqual(await redis.lrange('queue:restaurant-1', 0, -1), ['user-1', 'user-3']);

  await assert.rejects(() => service.leaveQueue({ restaurantId: 'restaurant-1', userId: 'user-9' }), (error) => error.status === 404);
});

test('queue positions update correctly when someone ahead leaves or gets seated', async () => {
  const redis = new FakeRedis(['user-1', 'user-2', 'user-3']);
  const service = new QueueService(redis);

  await service.leaveQueue({ restaurantId: 'restaurant-1', userId: 'user-1' });
  assert.equal(await service.getQueuePosition({ restaurantId: 'restaurant-1', userId: 'user-2' }), 1);
  assert.equal(await service.getQueuePosition({ restaurantId: 'restaurant-1', userId: 'user-3' }), 2);

  const seated = await service.seatNextCustomer({ restaurantId: 'restaurant-1', staffId: 'staff-1' });
  assert.equal(seated.seatedUserId, 'user-2');
  assert.equal(await service.getQueuePosition({ restaurantId: 'restaurant-1', userId: 'user-3' }), 1);
});

test('zero-entry restaurants do not throw when checking position', async () => {
  const redis = new FakeRedis([]);
  const service = new QueueService(redis);

  const position = await service.getQueuePosition({ restaurantId: 'restaurant-1', userId: 'user-9' });
  assert.equal(position, 0);
  assert.deepEqual((await service.getQueueState({ restaurantId: 'restaurant-1' })).queue, []);
});

test('Redis failures fail safely without silently discarding state', async () => {
  const redis = {
    async lpos() {
      throw new Error('Redis unavailable');
    },
    async llen() {
      throw new Error('Redis unavailable');
    },
    async lrange() {
      throw new Error('Redis unavailable');
    },
    async rpush() {
      throw new Error('Redis unavailable');
    },
    async lrem() {
      throw new Error('Redis unavailable');
    },
    async watch() {},
    async unwatch() {},
    multi() {
      return {
        async exec() {
          throw new Error('Redis unavailable');
        }
      };
    }
  };

  const service = new QueueService(redis);

  await assert.rejects(() => service.joinQueue({ restaurantId: 'restaurant-1', userId: 'user-1' }), (error) => error.status === 503);
  await assert.rejects(() => service.seatNextCustomer({ restaurantId: 'restaurant-1', staffId: 'staff-1' }), (error) => error.status === 503);
});

test('two staff members cannot seat the same front-of-queue customer simultaneously', async () => {
  const redis = new FakeRedis(['user-1', 'user-2']);
  const service = new QueueService(redis);

  const [first, second] = await Promise.all([
    service.seatNextCustomer({ restaurantId: 'restaurant-1', staffId: 'staff-1' }),
    service.seatNextCustomer({ restaurantId: 'restaurant-1', staffId: 'staff-2' })
  ]);

  assert.equal(first.seatedUserId, 'user-1');
  assert.equal(second, null);
  assert.deepEqual(await redis.lrange('queue:restaurant-1', 0, -1), ['user-2']);
});
