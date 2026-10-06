import { Router } from 'express';
import mongoose from 'mongoose';
import { authenticate } from '../middleware/authenticate.js';

export function createBookingCancelRouter({ bookings, bookingServiceFactory, jwtSecret }) {
  const router = Router();
  router.use(authenticate(jwtSecret));

  router.patch('/:id/cancel', async (request, response, next) => {
    try {
      const bookingId = request.params.id;
      if (!mongoose.isValidObjectId(bookingId)) {
        const error = new Error('Booking not found');
        error.status = 404;
        throw error;
      }
      const existing = await bookings.findOne({ _id: bookingId, userId: request.auth.sub }).select('restaurantId').lean();
      if (!existing) {
        const error = new Error('Booking not found');
        error.status = 404;
        throw error;
      }
      const bookingService = await bookingServiceFactory(existing.restaurantId.toString());
      const booking = await bookingService.cancelBooking({ bookingId, userId: request.auth.sub });
      response.json(booking);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

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