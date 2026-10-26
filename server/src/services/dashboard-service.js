import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

function createHttpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const OVERRIDABLE_STATUSES = new Set(['available', 'occupied', 'unavailable']);

const ALLOWED_TRANSITIONS = {
  confirmed: ['seated', 'cancelled', 'no-show'],
  seated: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  'no-show': []
};

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

  async getOverview(restaurantId) {
    const restObjId = new mongoose.Types.ObjectId(restaurantId);
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const [tableRows, bookingsToday, cancellationsToday, noShowsToday, queueState] = await Promise.all([
      this.tables.aggregate([
        { $match: { restaurantId: restObjId } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      this.bookings.countDocuments({
        restaurantId: restObjId,
        startsAt: { $gte: startOfDay, $lte: endOfDay }
      }),
      this.bookings.countDocuments({
        restaurantId: restObjId,
        status: 'cancelled',
        $or: [
          { cancelledAt: { $gte: startOfDay, $lte: endOfDay } },
          { updatedAt: { $gte: startOfDay, $lte: endOfDay } }
        ]
      }),
      this.bookings.countDocuments({
        restaurantId: restObjId,
        status: 'no-show',
        updatedAt: { $gte: startOfDay, $lte: endOfDay }
      }),
      this.queueService ? this.queueService.getQueueState({ restaurantId: restaurantId.toString() }).catch(() => ({ queueLength: 0 })) : { queueLength: 0 }
    ]);

    const tables = { available: 0, reserved: 0, occupied: 0, unavailable: 0, total: 0 };
    for (const row of tableRows) {
      tables[row._id] = row.count;
      tables.total += row.count;
    }

    return {
      tables,
      bookingsToday,
      queueLength: queueState?.queueLength ?? 0,
      cancellationsToday,
      noShowsToday
    };
  }

  async getBookings({ restaurantId, date, status, q, page = 1, limit = 20 }) {
    const restObjId = new mongoose.Types.ObjectId(restaurantId);
    const pageNum = Math.max(1, Number(page) || 1);
    const pageLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const skip = (pageNum - 1) * pageLimit;

    const matchQuery = { restaurantId: restObjId };

    if (status && status !== 'all') {
      matchQuery.status = status;
    }

    if (date) {
      const parsedDate = new Date(date);
      if (!Number.isNaN(parsedDate.getTime())) {
        const startOfDay = new Date(parsedDate);
        startOfDay.setUTCHours(0, 0, 0, 0);
        const endOfDay = new Date(parsedDate);
        endOfDay.setUTCHours(23, 59, 59, 999);
        matchQuery.startsAt = { $gte: startOfDay, $lte: endOfDay };
      }
    }

    const pipeline = [
      { $match: matchQuery },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'tables',
          localField: 'tableId',
          foreignField: '_id',
          as: 'table'
        }
      },
      { $unwind: { path: '$table', preserveNullAndEmptyArrays: true } }
    ];

    if (q && String(q).trim()) {
      pipeline.push({
        $match: {
          'user.name': { $regex: String(q).trim(), $options: 'i' }
        }
      });
    }

    const countPipeline = [...pipeline, { $count: 'total' }];

    pipeline.push(
      { $sort: { startsAt: -1, createdAt: -1 } },
      { $skip: skip },
      { $limit: pageLimit },
      {
        $project: {
          _id: 1,
          partySize: 1,
          startsAt: 1,
          status: 1,
          source: 1,
          seatedAt: 1,
          completedAt: 1,
          cancelledAt: 1,
          createdAt: 1,
          customerName: { $ifNull: ['$user.name', 'Guest'] },
          tableLabel: { $ifNull: ['$table.label', 'Unassigned'] }
        }
      }
    );

    const [countResult, bookings] = await Promise.all([
      this.bookings.aggregate(countPipeline),
      this.bookings.aggregate(pipeline)
    ]);

    const total = countResult[0]?.total ?? 0;
    const totalPages = Math.ceil(total / pageLimit) || 1;

    return {
      bookings,
      total,
      page: pageNum,
      totalPages,
      limit: pageLimit
    };
  }

  async updateBookingStatus({ restaurantId, bookingId, status }) {
    if (!['seated', 'completed', 'cancelled', 'no-show'].includes(status)) {
      throw createHttpError('Invalid status specified', 400);
    }
    if (!mongoose.isValidObjectId(bookingId)) {
      throw createHttpError('Booking not found', 404);
    }

    const restObjId = new mongoose.Types.ObjectId(restaurantId);
    const existing = await this.bookings.findOne({ _id: bookingId, restaurantId: restObjId });
    if (!existing) {
      throw createHttpError('Booking not found', 404);
    }

    const allowedNext = ALLOWED_TRANSITIONS[existing.status] ?? [];
    if (!allowedNext.includes(status)) {
      throw createHttpError(`Cannot transition booking from ${existing.status} to ${status}`, 400);
    }

    const session = this.mongoClient?.startSession ? this.mongoClient.startSession() : null;
    let updatedBooking;

    const execute = async (sess) => {
      const updateFields = { status };
      const now = new Date();

      if (status === 'seated') {
        updateFields.seatedAt = now;
        await this.tables.updateOne(
          { _id: existing.tableId, restaurantId: restObjId },
          { $set: { status: 'occupied' } },
          sess ? { session: sess } : {}
        );
      } else if (status === 'completed') {
        updateFields.completedAt = now;
        await this.tables.updateOne(
          { _id: existing.tableId, restaurantId: restObjId },
          { $set: { status: 'available' } },
          sess ? { session: sess } : {}
        );
      } else if (status === 'no-show') {
        await this.tables.updateOne(
          { _id: existing.tableId, restaurantId: restObjId },
          { $set: { status: 'available' } },
          sess ? { session: sess } : {}
        );
      } else if (status === 'cancelled') {
        updateFields.cancelledAt = now;
        await this.tables.updateOne(
          { _id: existing.tableId, restaurantId: restObjId },
          { $set: { status: 'available' } },
          sess ? { session: sess } : {}
        );
      }

      updatedBooking = await this.bookings.findOneAndUpdate(
        { _id: bookingId, restaurantId: restObjId },
        { $set: updateFields },
        { new: true, ...(sess ? { session: sess } : {}) }
      ).lean();
    };

    if (session) {
      try {
        await session.withTransaction(async () => {
          await execute(session);
        });
      } finally {
        await session.endSession();
      }
    } else {
      await execute(null);
    }

    await this._publishAvailability(restaurantId);
    this.socketRealtimeService?.broadcastBookingUpdate(restaurantId.toString(), 'status_changed', updatedBooking);

    return updatedBooking;
  }

  async getStats({ restaurantId, range = '7d' }) {
    const restObjId = new mongoose.Types.ObjectId(restaurantId);
    const days = range === '30d' ? 30 : 7;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // 1. Bookings per day (using index on { restaurantId: 1, createdAt: 1 })
    const dailyBookingsAgg = await this.bookings.aggregate([
      {
        $match: {
          restaurantId: restObjId,
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const dailyMap = new Map(dailyBookingsAgg.map((item) => [item._id, item.count]));
    const bookingsPerDay = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      bookingsPerDay.push({ date: dateStr, count: dailyMap.get(dateStr) ?? 0 });
    }

    // 2. Peak hours
    const peakHoursAgg = await this.bookings.aggregate([
      {
        $match: {
          restaurantId: restObjId,
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: { $hour: '$startsAt' },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    const hourMap = new Map(peakHoursAgg.map((item) => [item._id, item.count]));
    const peakHours = [];
    for (let h = 0; h < 24; h++) {
      const hourLabel = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
      peakHours.push({ hour: h, label: hourLabel, count: hourMap.get(h) ?? 0 });
    }

    // 3. Average turnover time (seated -> completed)
    const turnoverAgg = await this.bookings.aggregate([
      {
        $match: {
          restaurantId: restObjId,
          status: 'completed',
          seatedAt: { $exists: true, $ne: null },
          completedAt: { $exists: true, $ne: null }
        }
      },
      {
        $project: {
          durationMinutes: {
            $divide: [{ $subtract: ['$completedAt', '$seatedAt'] }, 1000 * 60]
          }
        }
      },
      {
        $match: {
          durationMinutes: { $gt: 0, $lte: 480 }
        }
      },
      {
        $group: {
          _id: null,
          avgMinutes: { $avg: '$durationMinutes' }
        }
      }
    ]);
    const avgTurnoverMinutes = turnoverAgg.length > 0 ? Math.round(turnoverAgg[0].avgMinutes) : 0;

    // 4. Cancellation and no-show rate (using index on { restaurantId: 1, status: 1 })
    const statusBreakdown = await this.bookings.aggregate([
      {
        $match: {
          restaurantId: restObjId,
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);
    let totalBookings = 0;
    let cancellations = 0;
    let noShows = 0;
    for (const item of statusBreakdown) {
      totalBookings += item.count;
      if (item._id === 'cancelled') cancellations += item.count;
      if (item._id === 'no-show') noShows += item.count;
    }
    const cancellationRate = totalBookings > 0 ? Number(((cancellations / totalBookings) * 100).toFixed(1)) : 0;
    const noShowRate = totalBookings > 0 ? Number(((noShows / totalBookings) * 100).toFixed(1)) : 0;

    return {
      range,
      days,
      bookingsPerDay,
      peakHours,
      avgTurnoverMinutes,
      totalBookings,
      cancellations,
      noShows,
      cancellationRate,
      noShowRate
    };
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
          // Allow freeing table even if there is a confirmed booking
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
        { $match: { restaurantId: new mongoose.Types.ObjectId(restaurantId) } },
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