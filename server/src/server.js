import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { getConfig } from './config/env.js';
import './models/index.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { User } from './models/user.js';
import { Booking } from './models/booking.js';
import { AuthService } from './services/auth-service.js';
import { createBookingServiceFactory } from './services/booking-service-factory.js';
import { OtpStore } from './services/otp-store.js';
import { Restaurant } from './models/restaurant.js';
import { Table } from './models/table.js';
import { GooglePlacesClient } from './services/google-places-client.js';
import { RestaurantService } from './services/restaurant-service.js';
import { QueueService } from './services/queue-service.js';
import { SocketRealtimeService } from './services/socket-realtime.js';

async function start() {
  const config = getConfig();
  await connectDatabase(config);
  const redis = await connectRedis(config.redisUrl);
  const authService = new AuthService({
    users: User,
    otpStore: new OtpStore(redis, config.otpTtlSeconds),
    jwtSecret: config.jwtSecret,
    jwtExpiresIn: config.jwtExpiresIn,
    authPartitionRestaurantId: config.authPartitionRestaurantId
  });
  const restaurantService = new RestaurantService({ restaurants: Restaurant, tables: Table, mapsClient: new GooglePlacesClient(config.googleMapsApiKey) });
  const bookingServiceFactory = createBookingServiceFactory({
    restaurants: Restaurant,
    tables: Table,
    bookings: Booking,
    mongoClient: mongoose.connection.getClient()
  });
  const queueService = new QueueService(redis);

  const app = createApp({
    authService,
    restaurantService,
    bookingServiceFactory,
    queueService,
    restaurants: Restaurant,
    jwtSecret: config.jwtSecret,
    exposeOtp: config.env !== 'production'
  });
  const server = createServer(app);
  const socketRealtimeService = new SocketRealtimeService({ jwtSecret: config.jwtSecret, restaurants: Restaurant });
  socketRealtimeService.attach(server);

  server.listen(config.port, () => {
    console.info(`SeatSpot API listening on port ${config.port}`);
  });

  const shutdown = async (signal) => {
    console.info(`${signal} received; stopping SeatSpot API`);
    server.close(async () => {
      await disconnectDatabase();
      await disconnectRedis();
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
