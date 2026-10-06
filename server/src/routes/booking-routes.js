import { Router } from 'express';
import mongoose from 'mongoose';
import { authenticate } from '../middleware/authenticate.js';

export function createBookingCancelRouter({ bookings, bookingServiceFactory, jwtSecret, restaurants }) {
  const router = Router();
  router.use(authenticate(jwtSecret));

  router.get('/', async (request, response, next) => {
    try {
      const mine = await bookings
        .find({ userId: request.auth.sub, status: 'confirmed' })
        .sort({ startsAt: 1 })
        .lean();
      const restaurantIds = [...new Set(mine.map((booking) => String(booking.restaurantId)))];
      const restaurantRows = restaurants
        ? await restaurants.find({ restaurantId: { $in: restaurantIds } }).select('restaurantId name address').lean()
        : [];
      const namesById = new Map(restaurantRows.map((restaurant) => [String(restaurant.restaurantId), restaurant]));
      response.json({
        bookings: mine.map((booking) => ({
          ...booking,
          restaurantName: namesById.get(String(booking.restaurantId))?.name ?? null,
          restaurantAddress: namesById.get(String(booking.restaurantId))?.address ?? null
        }))
      });
    } catch (error) {
      next(error);
    }
  });

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