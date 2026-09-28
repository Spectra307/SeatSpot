import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { BookingService } from '../src/services/booking-service.js';
import { Booking } from '../src/models/booking.js';
import { Table } from '../src/models/table.js';

const mongoUri = process.env.MONGO_URI
  ?? process.env.MONGODB_URI
  ?? 'mongodb://127.0.0.1:27017/seatspot?replicaSet=rs0';
const databaseName = `seatspot_booking_tests_${process.pid}`;

before(async () => {
  await mongoose.connect(mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

async function createFixture({ capacity = 4, bookings = Booking } = {}) {
  const restaurantId = new mongoose.Types.ObjectId();
  const table = await Table.create({
    restaurantId,
    label: `table-${new mongoose.Types.ObjectId()}`,
    capacity,
    status: 'available'
  });

  return {
    restaurantId,
    table,
    service: new BookingService({
      tables: Table,
      bookings,
      restaurantId,
      mongoClient: mongoose.connection.getClient()
    })
  };
}

function reservationRequest(tableId, overrides = {}) {
  return {
    tableId,
    userId: new mongoose.Types.ObjectId(),
    partySize: 2,
    startsAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides
  };
}

test('an unavailable table rejects with HTTP 409', async () => {
  const { table, service } = await createFixture();
  await Table.updateOne({ _id: table._id }, { $set: { status: 'reserved' } });

  await assert.rejects(
    service.reserveTable(reservationRequest(table._id)),
    (error) => error.status === 409
  );
});

test('twenty concurrent reservations produce one success and nineteen HTTP 409 conflicts', async () => {
  const { table, service } = await createFixture();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () =>
    service.reserveTable(reservationRequest(table._id))
  ));

  const succeeded = results.filter((result) => result.status === 'fulfilled');
  const failed = results.filter((result) => result.status === 'rejected');

  assert.equal(succeeded.length, 1);
  assert.equal(failed.length, 19);
  assert.ok(failed.every((result) => result.reason.status === 409));
  assert.equal(await Booking.countDocuments({ tableId: table._id }), 1);
});

test('a booking insert failure rolls the table status back to available', async () => {
  const failingBookings = {
    findOne(...args) {
      return Booking.findOne(...args);
    },
    create() {
      throw new Error('forced booking insert failure');
    }
  };
  const { table, service } = await createFixture({ bookings: failingBookings });

  await assert.rejects(
    service.reserveTable(reservationRequest(table._id)),
    /forced booking insert failure/
  );

  const unchangedTable = await Table.findById(table._id).lean();
  assert.equal(unchangedTable.status, 'available');
  assert.equal(await Booking.countDocuments({ tableId: table._id }), 0);
});

test('an over-capacity party rejects with HTTP 409 and leaves the table available', async () => {
  const { table, service } = await createFixture({ capacity: 2 });

  await assert.rejects(
    service.reserveTable(reservationRequest(table._id, { partySize: 3 })),
    (error) => error.status === 409
  );

  const unchangedTable = await Table.findById(table._id).lean();
  assert.equal(unchangedTable.status, 'available');
  assert.equal(await Booking.countDocuments({ tableId: table._id }), 0);
});

test('invalid reservation input rejects with HTTP 400', async () => {
  const { table, service } = await createFixture();

  await assert.rejects(
    service.reserveTable(reservationRequest(table._id, { partySize: 0 })),
    (error) => error.status === 400
  );
  await assert.rejects(
    service.reserveTable(reservationRequest(table._id, { startsAt: 'not-a-date' })),
    (error) => error.status === 400
  );
});
