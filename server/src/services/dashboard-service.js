import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const OVERRIDABLE_STATUSES = new Set(['available', 'occupied', 'unavailable']);

export class DashboardService {
  constructor({ tables, bookings, users, queueService, bookingServiceFactory, mongoClient, socketRealtimeService }) {
    this.tables = tables;
    this.bookings = bookings;
    this.users = users;
    this.queueService = queueService;
    this.bookingServiceFactory = bookingServiceFactory;
    this.mongoClient = mongoClient;
    this.socketRealtimeService = socketRealtimeService;
  }

  async getTableGrid(restaurantId) {
    return this.tables.find({ restaurantId }).sort({ label: 1 }).lean();
  }

  async getQueue(restaurantId) {
    return this.queueService.getQueueState({ restaurantId: restaurantId.toString() });
  }

  async seatWalkIn({ restaurantId, tableId, guestName, partySize, startsAt }) {
    if (!this.users) throw createHttpError('Walk-in customer provisioning is unavailable', 503);
    const walkInUser = await this.users.create({
      restaurantId,
      name: guestName?.trim() || 'Walk-in Guest',
      email: `walk-in-${randomUUID()}@seatspot.local`,
      passwordHash: await bcrypt.hash(randomUUID(), 12),
      role: 'customer',
      isVerified: false
    });
    const bookingService = await this.bookingServiceFactory(restaurantId.toString());
    try {
      return await bookingService.reserveTable({
        tableId,
        userId: walkInUser._id,
        partySize,
        startsAt: startsAt ?? new Date(Date.now() + 60 * 1000),
        source: 'walk-in'
      });
    } catch (error) {
      await this.users.deleteOne({ _id: walkInUser._id, restaurantId }).catch(() => undefined);
      throw error;
    }
  }

  async handoffNextCustomer({ restaurantId, staffId, tableId, partySize, startsAt }) {
    return this.queueService.handoffNextCustomer({
      restaurantId: restaurantId.toString(),
      staffId,
      tableId,
      partySize,
      startsAt
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
      if (updatedTable) await this._publishAvailability(restaurantId);
      return updatedTable;
    } finally {
      await session.endSession();
    }
  }

  async _publishAvailability(restaurantId) {
    try {
      const rows = await this.tables.aggregate([
        { $match: { restaurantId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      const availability = { available: 0, reserved: 0, occupied: 0, unavailable: 0, total: 0 };
      for (const row of rows) {
        availability[row._id] = row.count;
        availability.total += row.count;
      }
      this.socketRealtimeService?.broadcastAvailability(restaurantId.toString(), availability);
    } catch {
      // Availability publication is best-effort after a committed status override.
    }
  }
}