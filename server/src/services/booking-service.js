function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export class BookingService {
  constructor({ tables, bookings, restaurantId, mongoClient }) {
    this.tables = tables;
    this.bookings = bookings;
    this.restaurantId = restaurantId;
    this.mongoClient = mongoClient;
  }

  async reserveTable({ tableId, userId, partySize, startsAt }) {
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
              status: 'confirmed'
            }],
            { session }
          )
        );

        booking = Array.isArray(created) ? created[0] : created;
      });

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
}
