import Redis from 'ioredis';

let client;

export async function connectRedis(redisUrl) {
  client = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await client.connect();
  return client;
}

export function getRedis() {
  if (!client) throw new Error('Redis has not been initialized');
  return client;
}

export async function disconnectRedis() {
  if (client) await client.quit();
  client = undefined;
}
