import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const required = ['MONGODB_URI', 'JWT_SECRET', 'REDIS_URL'];

export function getConfig() {
  const missing = required.filter((key) => !process.env[key]);
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
    mongoUri: process.env.MONGODB_URI,
    mongoDbName: process.env.MONGODB_DB_NAME ?? 'seatspot',
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '1h',
    redisUrl: process.env.REDIS_URL,
    otpTtlSeconds: Number(process.env.OTP_TTL_SECONDS ?? 300),
    authPartitionRestaurantId: process.env.AUTH_PARTITION_RESTAURANT_ID ?? '000000000000000000000001',
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY
  });
}
