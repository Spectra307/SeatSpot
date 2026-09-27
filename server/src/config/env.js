import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const required = ['MONGODB_URI'];

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
    mongoDbName: process.env.MONGODB_DB_NAME ?? 'seatspot'
  });
}
