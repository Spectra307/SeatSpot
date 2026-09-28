import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';

export function createBookingRouter({ bookingServiceFactory, jwtSecret }) {
  const router = Router();
  router.use(authenticate(jwtSecret));

  router.post('/:restaurantId/bookings', async (request, response, next) => {
    try {
      const bookingService = await bookingServiceFactory(request.params.restaurantId);
      const booking = await bookingService.reserveTable({
        ...(request.body ?? {}),
        userId: request.auth.sub
      });
      response.status(201).json(booking);
    } catch (error) {
      next(error);
    }
  });

  return router;
}