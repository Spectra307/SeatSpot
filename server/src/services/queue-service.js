import { randomUUID } from 'node:crypto';

function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export class QueueService {
  constructor(redis, { queueKeyPrefix = 'queue:', bookings, bookingServiceFactory, handoffLockMilliseconds = 30000 } = {}) {
    this.redis = redis;
    this.queueKeyPrefix = queueKeyPrefix;
    this.bookings = bookings;
    this.bookingServiceFactory = bookingServiceFactory;
    this.handoffLockMilliseconds = handoffLockMilliseconds;
  }

  _queueKey(restaurantId) {
    return `${this.queueKeyPrefix}${restaurantId}`;
  }

  async joinQueue({ restaurantId, userId }) {
    if (!restaurantId || !userId) {
      throw createHttpError('restaurantId and userId are required', 400);
    }

    const queueKey = this._queueKey(restaurantId);

    try {
      if (typeof this.redis.eval === 'function') {
        const [position, alreadyInQueue, queueLength] = await this.redis.eval(`
          local existing = redis.call('LPOS', KEYS[1], ARGV[1])
          if existing then
            return { existing + 1, 1, redis.call('LLEN', KEYS[1]) }
          end
          local length = redis.call('RPUSH', KEYS[1], ARGV[1])
          return { length, 0, length }
        `, 1, queueKey, userId);

        return {
          restaurantId,
          userId,
          position: Number(position),
          alreadyInQueue: Number(alreadyInQueue) === 1,
          queueLength: Number(queueLength)
        };
      }

      const existingPosition = await this.redis.lpos(queueKey, userId);
      if (existingPosition !== null) {
        return {
          restaurantId,
          userId,
          position: existingPosition + 1,
          alreadyInQueue: true,
          queueLength: await this.redis.llen(queueKey)
        };
      }

      await this.redis.rpush(queueKey, userId);
      const position = await this.getQueuePosition({ restaurantId, userId });

      return {
        restaurantId,
        userId,
        position,
        alreadyInQueue: false,
        queueLength: await this.redis.llen(queueKey)
      };
    } catch (error) {
      if (error?.status) throw error;
      throw createHttpError('Queue service unavailable while joining queue', 503);
    }
  }

  async leaveQueue({ restaurantId, userId }) {
    if (!restaurantId || !userId) {
      throw createHttpError('restaurantId and userId are required', 400);
    }

    const queueKey = this._queueKey(restaurantId);

    try {
      const removedCount = await this.redis.lrem(queueKey, 0, userId);
      if (removedCount === 0) {
        throw createHttpError('User is not in the queue', 404);
      }

      return {
        restaurantId,
        userId,
        removed: removedCount,
        queueLength: await this.redis.llen(queueKey)
      };
    } catch (error) {
      if (error?.status) throw error;
      throw createHttpError('Queue service unavailable while leaving queue', 503);
    }
  }

  async getQueuePosition({ restaurantId, userId }) {
    if (!restaurantId || !userId) {
      throw createHttpError('restaurantId and userId are required', 400);
    }

    const queueKey = this._queueKey(restaurantId);

    try {
      const queueLength = await this.redis.llen(queueKey);
      if (queueLength === 0) return 0;

      const index = await this.redis.lpos(queueKey, userId);
      if (index === null) return 0;

      return index + 1;
    } catch (error) {
      if (error?.status) throw error;
      throw createHttpError('Queue service unavailable while checking position', 503);
    }
  }

  async getQueueState({ restaurantId }) {
    if (!restaurantId) {
      throw createHttpError('restaurantId is required', 400);
    }

    const queueKey = this._queueKey(restaurantId);

    try {
      const queue = await this.redis.lrange(queueKey, 0, -1);
      return {
        restaurantId,
        queue,
        queueLength: queue.length
      };
    } catch (error) {
      if (error?.status) throw error;
      throw createHttpError('Queue service unavailable while reading queue state', 503);
    }
  }

  async seatNextCustomer({ restaurantId, staffId, userId }) {
    if (!restaurantId || !staffId) {
      throw createHttpError('restaurantId and staffId are required', 400);
    }

    const queueKey = this._queueKey(restaurantId);

    try {
      await this.redis.watch(queueKey);
      const queue = await this.redis.lrange(queueKey, 0, -1);

      if (queue.length === 0) {
        return null;
      }

      const customerId = userId ?? queue[0];
      if (userId && !queue.includes(userId)) {
        throw createHttpError('User is not in the queue', 404);
      }

      const tx = this.redis.multi();
      tx.lrem(queueKey, 1, customerId);
      const result = await tx.exec();

      if (!result) {
        return null;
      }

      return {
        restaurantId,
        staffId,
        seatedUserId: customerId,
        previousPosition: 1,
        queueLength: await this.redis.llen(queueKey)
      };
    } catch (error) {
      if (error?.status) throw error;
      throw createHttpError('Queue service unavailable while seating customer', 503);
    } finally {
      await this.redis.unwatch().catch(() => undefined);
    }
  }

  async handoffNextCustomer({ restaurantId, staffId, tableId, partySize = 1, startsAt }) {
    if (!restaurantId || !staffId || !tableId) {
      throw createHttpError('restaurantId, staffId, and tableId are required', 400);
    }
    if (!this.bookings || !this.bookingServiceFactory) {
      throw createHttpError('Queue handoff service is not configured', 503);
    }

    const queueKey = this._queueKey(restaurantId);
    const lockKey = `${queueKey}:handoff-lock`;
    const lockToken = randomUUID();

    try {
      const lock = await this.redis.set(lockKey, lockToken, 'PX', this.handoffLockMilliseconds, 'NX');
      if (lock !== 'OK') {
        throw createHttpError('A queue handoff is already in progress', 409);
      }
    } catch (error) {
      if (error?.status) throw error;
      throw createHttpError('Queue service unavailable while starting handoff', 503);
    }

    try {
      while (true) {
        const queue = await this.redis.lrange(queueKey, 0, -1);
        const customerId = queue[0];
        if (!customerId) return null;

        const existingBooking = await this.bookings.findOne({
          restaurantId,
          userId: customerId,
          status: 'confirmed'
        }).select('_id').lean();
        if (existingBooking) {
          await this.redis.lrem(queueKey, 0, customerId);
          continue;
        }

        const bookingService = await this.bookingServiceFactory(restaurantId.toString());
        const booking = await bookingService.reserveTable({
          tableId,
          userId: customerId,
          partySize,
          startsAt: startsAt ?? new Date(Date.now() + 60 * 1000)
        });

        try {
          await this.redis.lrem(queueKey, 1, customerId);
        } catch {
          throw createHttpError('Booking committed but queue cleanup failed; retry the handoff', 503);
        }

        return {
          restaurantId: restaurantId.toString(),
          staffId,
          seatedUserId: customerId,
          booking,
          queueLength: await this.redis.llen(queueKey)
        };
      }
    } catch (error) {
      if (error?.status) throw error;
      throw createHttpError('Queue service unavailable while handing off table', 503);
    } finally {
      await this.redis.eval(`
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `, 1, lockKey, lockToken).catch(() => undefined);
    }
  }
}
