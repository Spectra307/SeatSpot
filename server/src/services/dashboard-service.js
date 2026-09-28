function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const OVERRIDABLE_STATUSES = new Set(['available', 'occupied', 'unavailable']);

export class DashboardService {
  constructor({ tables, bookings, queueService, bookingServiceFactory, mongoClient }) {
    this.tables = tables;
    this.bookings = bookings;
    this.queueService = queueService;
    this.bookingServiceFactory = bookingServiceFactory;
    this.mongoClient = mongoClient;
  }

  async getTableGrid(restaurantId) {
    return this.tables.find({ restaurantId }).sort({ label: 1 }).lean();
  }

  async getQueue(restaurantId) {
    return this.queueService.getQueueState({ restaurantId: restaurantId.toString() });
  }

  async seatWalkIn({ restaurantId, tableId, userId, partySize, startsAt }) {
    const bookingService = await this.bookingServiceFactory(restaurantId.toString());
    return bookingService.reserveTable({
      tableId,
      userId,
      partySize,
      startsAt: startsAt ?? new Date(Date.now() + 60 * 1000)
    });
  }

  async overrideTableStatus({ restaurantId, tableId, status }) {
    if (!OVERRIDABLE_STATUSES.has(status)) {
      throw createHttpError('Table status must be available, occupied, or unavailable', 400);
    }

    const session = this.mongoClient.startSession();
    try {
      let updatedTable;
      await session.withTransaction(async () => {
        const table = await this.tables.findOne({ _id: tableId, restaurantId }).session(session).lean();
        if (!table) throw createHttpError('Table not found', 404);

        if (status === 'available') {
          const activeBooking = await this.bookings.findOne({
            restaurantId,
            tableId,
            status: 'confirmed'
          }).session(session).select('_id').lean();
          if (activeBooking) {
            throw createHttpError('Cannot make a table available while it has a confirmed booking', 409);
          }
        }

        updatedTable = await this.tables.findOneAndUpdate(
          { _id: tableId, restaurantId, status: table.status },
          { $set: { status } },
          { new: true, session, runValidators: true }
        ).lean();
        if (!updatedTable) throw createHttpError('Table status changed; retry the override', 409);
      });
      return updatedTable;
    } finally {
      await session.endSession();
    }
  }
}