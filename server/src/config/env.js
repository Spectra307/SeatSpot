import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const required = ['JWT_SECRET'];

export function getConfig() {
  const mongoUri = process.env.MONGO_URI ?? process.env.MONGODB_URI;
  const redisUrl = process.env.REDIS_URL ?? (process.env.REDIS_PASSWORD
    ? `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD)}@127.0.0.1:6379`
    : undefined);
  const missing = required.filter((key) => !process.env[key]);
  if (!mongoUri) missing.push('MONGO_URI');
  if (!redisUrl) missing.push('REDIS_URL or REDIS_PASSWORD');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const port = Number(process.env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  return Object.freeze({
    env: process.env.NODE_ENV ?? 'development',
    port,
    mongoUri,
    mongoDbName: process.env.MONGODB_DB_NAME ?? 'seatspot',
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
    redisUrl,
    otpTtlSeconds: Number(process.env.OTP_TTL_SECONDS ?? 300),
    authPartitionRestaurantId: process.env.AUTH_PARTITION_RESTAURANT_ID ?? '000000000000000000000001',
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY
  });
}
