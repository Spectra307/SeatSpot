import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { getConfig } from './config/env.js';
import './models/index.js';

async function start() {
  const config = getConfig();
  await connectDatabase(config);

  const server = createApp().listen(config.port, () => {
    console.info(`SeatSpot API listening on port ${config.port}`);
  });

  const shutdown = async (signal) => {
    console.info(`${signal} received; stopping SeatSpot API`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((error) => {
  console.error('SeatSpot API failed to start:', error.message);
  process.exit(1);
});
