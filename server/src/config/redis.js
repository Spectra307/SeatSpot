import Redis from 'ioredis';

let client;

export async function connectRedis(redisUrl) {
  const useTls = typeof redisUrl === 'string' && redisUrl.startsWith('rediss://');

  client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      if (times > 15) return null;
      return Math.min(times * 250, 2000);
    },
    ...(useTls ? { tls: {} } : {})
  });

  client.on('error', (error) => {
    console.error('[SeatSpot] Redis error:', error?.message ?? error);
  });

  try {
    await client.connect();
    console.info('[SeatSpot] Redis connected');
    return client;
  } catch (error) {
    console.error('[SeatSpot] Redis connection failed:', error?.message ?? error);
    throw error;
  }
}

export function getRedis() {
  if (!client) throw new Error('Redis has not been initialized');
  return client;
}

export async function disconnectRedis() {
  if (client) await client.quit();
  client = undefined;
}
