import express from 'express';
import { databaseStatus } from './config/database.js';
import { createAuthRouter } from './routes/auth-routes.js';
import { createBookingRouter } from './routes/booking-routes.js';
import { createDashboardRouter } from './routes/dashboard-routes.js';
import { createQueueRouter } from './routes/queue-routes.js';
import { createRestaurantRouter } from './routes/restaurant-routes.js';

export function createApp({ authService, restaurantService, bookingServiceFactory, queueService, dashboardService, restaurants, jwtSecret, exposeOtp = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  if (authService) app.use('/api/auth', createAuthRouter(authService, { exposeOtp }));
  if (bookingServiceFactory) app.use('/api/restaurants', createBookingRouter({ bookingServiceFactory, jwtSecret }));
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

  app.use((error, _request, response, _next) => {
    response.status(error.status ?? 500).json({ error: error.message ?? 'Internal server error' });
  });

  return app;
}
