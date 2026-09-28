import { BookingService } from './booking-service.js';
import { resolveRestaurantId } from './restaurant-resolver.js';

export function createBookingServiceFactory({ restaurants, tables, bookings, mongoClient, notificationService, socketRealtimeService }) {
  return async (restaurantParam) => {
    const restaurantId = await resolveRestaurantId(restaurants, restaurantParam);
    return new BookingService({ tables, bookings, restaurantId, mongoClient, notificationService, socketRealtimeService });
  };
}