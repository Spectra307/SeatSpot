import { BookingService } from './booking-service.js';
import { resolveRestaurantId } from './restaurant-resolver.js';

export function createBookingServiceFactory({ restaurants, tables, bookings, users, mongoClient, notificationService, socketRealtimeService, queueService, emailService }) {
  return async (restaurantParam) => {
    const restaurantId = await resolveRestaurantId(restaurants, restaurantParam);
    return new BookingService({ tables, bookings, users, restaurantId, mongoClient, notificationService, socketRealtimeService, queueService, emailService });
  };
}