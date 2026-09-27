import test from 'node:test';
import assert from 'node:assert/strict';
import { BookingService } from '../src/services/booking-service.js';

test('reserveTable fails safely when the table is no longer available', async () => {
  const tables = {
    async findOneAndUpdate(query, update) {
      if (query._id !== 'table-1' || query.status !== 'available') return null;
      return { _id: 'table-1', restaurantId: 'restaurant-1', status: 'reserved', capacity: 4 };
    }
  };

  const bookings = {
    async create(data) {
      return { _id: 'booking-1', ...data };
    }
  };

  const service = new BookingService({ tables, bookings, restaurantId: 'restaurant-1' });
  const reservation = await service.reserveTable({ tableId: 'table-1', userId: 'user-1', partySize: 2, startsAt: new Date('2026-10-01T18:00:00.000Z') });

  assert.equal(reservation.tableId, 'table-1');
  assert.equal(reservation.status, 'confirmed');

  const unavailable = await service.reserveTable({ tableId: 'table-1', userId: 'user-2', partySize: 2, startsAt: new Date('2026-10-01T18:00:00.000Z') });
  assert.equal(unavailable, null);
});

test('two concurrent booking attempts on the same table leave one success and one clean failure', async () => {
  let tableState = { _id: 'table-1', restaurantId: 'restaurant-1', status: 'available', capacity: 4 };
  const tables = {
    async findOneAndUpdate(query, update) {
      if (query._id !== 'table-1' || query.status !== 'available') return null;
      if (tableState.status !== 'available') return null;

      tableState = {
        ...tableState,
        ...update.$set,
        status: 'reserved'
      };

      return { ...tableState };
    }
  };

  const bookings = {
    async create(data) {
      return { _id: `booking-${Math.random().toString(16).slice(2)}`, ...data };
    }
  };

  const service = new BookingService({ tables, bookings, restaurantId: 'restaurant-1' });
  const results = await Promise.allSettled([
    service.reserveTable({ tableId: 'table-1', userId: 'user-1', partySize: 2, startsAt: new Date('2026-10-01T18:00:00.000Z') }),
    service.reserveTable({ tableId: 'table-1', userId: 'user-2', partySize: 2, startsAt: new Date('2026-10-01T18:00:00.000Z') })
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 409);
  assert.equal(tableState.status, 'reserved');
});
