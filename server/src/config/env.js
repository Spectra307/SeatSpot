import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const required = ['JWT_SECRET'];

function trimTrailingSlash(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

function resolveRedisUrl() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;

  const host = process.env.REDIS_HOST ?? '127.0.0.1';
  const port = process.env.REDIS_PORT ?? '6379';
  const password = process.env.REDIS_PASSWORD
    ? `:${encodeURIComponent(process.env.REDIS_PASSWORD)}@`
    : '';
  return `redis://${password}${host}:${port}`;
}

export function getConfig() {
  const env = process.env.NODE_ENV ?? 'development';
  const mongoUri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
  const redisUrl = resolveRedisUrl();

  const missing = required.filter((key) => !process.env[key]);
  if (!mongoUri) missing.push('MONGODB_URI');

  const configuredOrigin = trimTrailingSlash(process.env.CLIENT_ORIGIN);
  if (env === 'production') {
    for (const key of ['REDIS_URL', 'CLIENT_ORIGIN', 'EMAIL_FROM', 'BREVO_API_KEY']) {
      if (!process.env[key]) missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const port = Number(process.env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  const clientOrigins = [];
  if (configuredOrigin) clientOrigins.push(configuredOrigin);
  if (env !== 'production') {
    const localOrigin = 'http://localhost:5173';
    if (!clientOrigins.includes(localOrigin)) clientOrigins.push(localOrigin);
  }

  return Object.freeze({
    env,
    port,
    mongoUri,
    mongoDbName: process.env.MONGODB_DB_NAME ?? 'seatspot',
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
    redisUrl,
    otpTtlSeconds: Number(process.env.OTP_TTL_SECONDS ?? 300),
    authPartitionRestaurantId: process.env.AUTH_PARTITION_RESTAURANT_ID ?? '000000000000000000000001',
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
    clientOrigins,
    emailFrom: process.env.EMAIL_FROM ?? process.env.MAIL_FROM,
    brevoApiKey: process.env.BREVO_API_KEY
  });
}
