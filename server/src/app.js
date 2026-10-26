import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import { databaseStatus } from './config/database.js';
import { createAuthRouter } from './routes/auth-routes.js';
import { createBookingRouter, createBookingCancelRouter } from './routes/booking-routes.js';
import { createDashboardRouter } from './routes/dashboard-routes.js';
import { createQueueRouter } from './routes/queue-routes.js';
import { createRestaurantRouter } from './routes/restaurant-routes.js';

const clientDistPath = fileURLToPath(new URL('../../client/dist', import.meta.url));

export function createApp({
  authService,
  restaurantService,
  bookingServiceFactory,
  queueService,
  dashboardService,
  restaurants,
  jwtSecret,
  apiRateLimitOptions = {},
  bookings,
  allowedOrigins = ['http://localhost:5173']
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: false
  }));
  app.use(express.json());

  app.get('/api/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.use('/api', rateLimit({
    windowMs: 60_000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...apiRateLimitOptions
  }));

  if (authService) app.use('/api/auth', createAuthRouter(authService));
  if (bookingServiceFactory) app.use('/api/restaurants', createBookingRouter({ bookingServiceFactory, jwtSecret }));
  if (bookingServiceFactory && bookings) app.use('/api/bookings', createBookingCancelRouter({ bookings, bookingServiceFactory, jwtSecret, restaurants }));
  if (queueService && restaurants) app.use('/api/restaurants', createQueueRouter({ queueService, restaurants, jwtSecret }));
  if (dashboardService && restaurants) app.use('/api/restaurants', createDashboardRouter({ dashboardService, restaurants, jwtSecret }));
  if (restaurantService) app.use('/api/restaurants', createRestaurantRouter(restaurantService, jwtSecret));

  app.get('/health', (_request, response) => {
    const database = databaseStatus();
    response.status(database === 'connected' ? 200 : 503).json({
      status: database === 'connected' ? 'ok' : 'degraded',
      database
    });
  });

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(clientDistPath));
    app.get('/{*splat}', (request, response, next) => {
      if (request.path.startsWith('/api') || request.path.startsWith('/socket.io')) {
        return next();
      }
      return response.sendFile(path.join(clientDistPath, 'index.html'));
    });
  }

  app.use((error, _request, response, _next) => {
    const payload = { error: error.message ?? 'Internal server error' };
    if (error.code) payload.code = error.code;
    if (error.retryAfterSeconds !== undefined) payload.retryAfterSeconds = error.retryAfterSeconds;
    response.status(error.status ?? 500).json(payload);
  });

  return app;
}
