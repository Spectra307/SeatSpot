import mongoose from 'mongoose';

function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export class BookingService {
  constructor({ tables, bookings, restaurantId, mongoClient, notificationService, socketRealtimeService, queueService }) {
    this.tables = tables;
    this.bookings = bookings;
    this.restaurantId = restaurantId;
    this.mongoClient = mongoClient;
    this.notificationService = notificationService;
    this.socketRealtimeService = socketRealtimeService;
    this.queueService = queueService;
  }

  async reserveTable({ tableId, userId, partySize, startsAt, source = 'customer' }) {
    const normalizedStartsAt = startsAt instanceof Date ? new Date(startsAt) : new Date(startsAt);

    if (!tableId || !userId || !Number.isInteger(partySize) || partySize < 1) {
      throw createHttpError('Invalid booking request', 400);
    }

    if (Number.isNaN(normalizedStartsAt.getTime()) || normalizedStartsAt.getTime() <= Date.now()) {
      throw createHttpError('Booking start time must be a valid future datetime', 400);
    }

    if (!this.mongoClient || typeof this.mongoClient.startSession !== 'function') {
      throw createHttpError('MongoDB transaction session is required for reservations', 500);
    }

    const session = this.mongoClient.startSession();

    try {
      let booking;

      await session.withTransaction(async () => {
        const existingBooking = await this.bookings.findOne({
          restaurantId: this.restaurantId,
          userId,
          status: 'confirmed'
        }).session(session).select('_id').lean();
        if (existingBooking) {
          throw createHttpError('User already has an active booking', 409);
        }

        const table = await this.tables.findOneAndUpdate(
          {
            _id: tableId,
            restaurantId: this.restaurantId,
            status: 'available'
          },
          {
            $set: {
              status: 'reserved'
            }
          },
          { new: true, session }
        );

        if (!table) {
          throw createHttpError('Table is no longer available', 409);
        }

        if (table.capacity < partySize) {
          throw createHttpError('Party size exceeds table capacity', 409);
        }

        const created = await Promise.resolve(
          this.bookings.create(
            [{
              restaurantId: this.restaurantId,
              tableId,
              userId,
              partySize,
              startsAt: normalizedStartsAt,
              source,
              status: 'confirmed'
            }],
            { session }
          )
        );

        booking = Array.isArray(created) ? created[0] : created;
      });

      await this._publishBooking(booking, userId);
      return booking;
    } catch (error) {
      if (error?.code === 11000) {
        throw createHttpError('User already has an active booking', 409);
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async cancelBooking({ bookingId, userId }) {
    if (!bookingId || !userId || !mongoose.isValidObjectId(bookingId)) {
      throw createHttpError('Booking not found', 404);
    }
    if (!this.mongoClient || typeof this.mongoClient.startSession !== 'function') {
      throw createHttpError('MongoDB transaction session is required for cancellations', 500);
    }

    const session = this.mongoClient.startSession();

    try {
      let booking;

      await session.withTransaction(async () => {
        booking = await this.bookings.findOneAndUpdate(
          { _id: bookingId, userId, status: 'confirmed' },
          { $set: { status: 'cancelled', cancelledAt: new Date() } },
          { new: true, session }
        );

        if (!booking) {
          const existing = await this.bookings.findOne({ _id: bookingId, userId }).session(session).select('_id').lean();
          if (existing) {
            throw createHttpError('Booking is not in a confirmed state', 409);
          }
          throw createHttpError('Booking not found', 404);
        }

        const table = await this.tables.findOneAndUpdate(
          { _id: booking.tableId, status: 'reserved' },
          { $set: { status: 'available' } },
          { new: true, session }
        );

        if (!table) {
          throw createHttpError('Table is not reserved for this booking', 409);
        }
      });

      await this._publishCancellation(booking, userId);
      return booking;
    } finally {
      await session.endSession();
    }
  }

  async _publishCancellation(booking, userId) {
    try {
      this.socketRealtimeService?.emitToUser(String(userId), 'booking:cancelled', {
        bookingId: booking._id.toString(),
        restaurantId: booking.restaurantId.toString(),
        tableId: booking.tableId.toString(),
        status: booking.status
      });
    } catch {
      // Realtime delivery must not affect a committed cancellation.
    }

    try {
      const rows = await this.tables.aggregate([
        { $match: { restaurantId: booking.restaurantId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      const availability = { available: 0, reserved: 0, occupied: 0, unavailable: 0, total: 0 };
      for (const row of rows) {
        availability[row._id] = row.count;
        availability.total += row.count;
      }
      this.socketRealtimeService?.broadcastAvailability(booking.restaurantId.toString(), availability);
    } catch {
      // Availability publication is best-effort after the transaction commits.
    }

    try {
      await this.queueService?.promoteNextFromQueue({ restaurantId: booking.restaurantId.toString() });
    } catch (error) {
      console.error('Queue promotion after cancellation failed:', error?.message ?? error);
    }
  }

  async _publishBooking(booking, userId) {
    try {
      this.socketRealtimeService?.emitToUser(String(userId), 'booking:confirmed', {
        bookingId: booking._id.toString(),
        restaurantId: this.restaurantId.toString(),
        tableId: booking.tableId.toString(),
        status: booking.status
      });
    } catch {
      // Realtime delivery must not affect a committed reservation.
    }

    try {
      const rows = await this.tables.aggregate([
        { $match: { restaurantId: this.restaurantId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      const availability = { available: 0, reserved: 0, occupied: 0, unavailable: 0, total: 0 };
      for (const row of rows) {
        availability[row._id] = row.count;
        availability.total += row.count;
      }
      this.socketRealtimeService?.broadcastAvailability(this.restaurantId.toString(), availability);
    } catch {
      // Availability publication is best-effort after the transaction commits.
    }

    await this.notificationService?.notifySafely({
      type: 'booking-confirmed',
      userId: String(userId),
      restaurantId: this.restaurantId.toString(),
      bookingId: booking._id.toString()
    });
  }
}
