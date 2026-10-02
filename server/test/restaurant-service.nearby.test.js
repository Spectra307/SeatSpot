import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { RestaurantService } from '../src/services/restaurant-service.js';

const objectId = () => new mongoose.Types.ObjectId();

function fakeRestaurants(documents) {
  const pipelines = [];
  return {
    pipelines,
    async aggregate(pipeline) {
      pipelines.push(pipeline);
      const limit = pipeline.find((stage) => stage.$limit)?.$limit ?? documents.length;
      return documents.slice(0, limit).map((document) => ({ ...document }));
    }
  };
}

function fakeTables(rows) {
  const pipelines = [];
  return {
    pipelines,
    async aggregate(pipeline) {
      pipelines.push(pipeline);
      return rows;
    }
  };
}

function restaurant(name, distanceMeters, restaurantId = objectId()) {
  return { _id: objectId(), restaurantId, name, address: `${name} street`, location: { type: 'Point', coordinates: [80.22, 12.93] }, distanceMeters };
}

function countsRow(restaurantId, status, count) {
  return { _id: { restaurantId, status }, count };
}

function buildService({ documents = [], rows = [], places = [], mapsEnabled = false } = {}) {
  const restaurants = fakeRestaurants(documents);
  const tables = fakeTables(rows);
  const service = new RestaurantService({
    restaurants,
    tables,
    mapsClient: { enabled: mapsEnabled, async searchNearby() { return places; } }
  });
  return { service, restaurants, tables };
}

test('nearby returns distance and batched availability counts from a single table query', async () => {
  const harbor = restaurant('Har Grill', 420);
  const garden = restaurant('Garden Table', 1800);
  const { service, restaurants, tables } = buildService({
    documents: [harbor, garden],
    rows: [
      countsRow(harbor.restaurantId, 'available', 3),
      countsRow(harbor.restaurantId, 'occupied', 2),
      countsRow(garden.restaurantId, 'available', 1),
      countsRow(garden.restaurantId, 'unavailable', 4)
    ]
  });

  const results = await service.nearby({ latitude: 12.9255, longitude: 80.2201, radiusMeters: 5000 });

  assert.equal(tables.pipelines.length, 1, 'availability is counted with one grouped query');
  assert.deepEqual(results.map((entry) => entry.name), ['Har Grill', 'Garden Table']);
  assert.deepEqual(results[0].availability, { available: 3, reserved: 0, occupied: 2, unavailable: 0, total: 5 });
  assert.deepEqual(results[1].availability, { available: 1, reserved: 0, occupied: 0, unavailable: 4, total: 5 });
  assert.equal(results[0].distanceMeters, 420);
  assert.equal(results[0].source, 'catalogue');
  const [geoNear] = restaurants.pipelines[0].map((stage) => stage.$geoNear);
  assert.equal(geoNear.key, 'location');
  assert.equal(geoNear.maxDistance, 5000);
  assert.equal(geoNear.distanceField, 'distanceMeters');
});

test('nearby honours the limit and the widest candidate window when ranking by availability', async () => {
  const documents = Array.from({ length: 6 }, (_, index) => restaurant(`Place ${index}`, index * 100));
  const { service, restaurants } = buildService({ documents });

  await service.nearby({ latitude: 12.9, longitude: 80.2, radiusMeters: 5000, limit: 2 });
  assert.equal(restaurants.pipelines[0].find((stage) => stage.$limit).$limit, 2);

  await service.nearby({ latitude: 12.9, longitude: 80.2, radiusMeters: 5000, limit: 2, sort: 'availability' });
  assert.equal(restaurants.pipelines[1].find((stage) => stage.$limit).$limit, 8, 'ranked searches widen the window so filtering does not hide nearby places');
});

test('openOnly keeps only restaurants with an available table', async () => {
  const full = restaurant('Fully Booked', 300);
  const open = restaurant('Two Seats Free', 900);
  const { service, tables } = buildService({
    documents: [full, open],
    rows: [countsRow(full.restaurantId, 'occupied', 6), countsRow(open.restaurantId, 'available', 1)]
  });

  const results = await service.nearby({ latitude: 12.9, longitude: 80.2, openOnly: 'true' });
  assert.deepEqual(results.map((entry) => entry.name), ['Two Seats Free']);
  assert.equal(tables.pipelines.length, 1);
});

test('availability sort ranks the most open tables first and keeps distance as a tie-breaker', async () => {
  const farButBusy = restaurant('Far Busy', 4000);
  const nearQuiet = restaurant('Near Quiet', 800);
  const nearOpen = restaurant('Near Open', 900);
  const nearAlsoOpen = restaurant('Near Also Open', 1200);
  const { service } = buildService({
    documents: [farButBusy, nearQuiet, nearOpen, nearAlsoOpen],
    rows: [
      countsRow(farButBusy.restaurantId, 'available', 5),
      countsRow(nearQuiet.restaurantId, 'occupied', 4),
      countsRow(nearOpen.restaurantId, 'available', 2),
      countsRow(nearAlsoOpen.restaurantId, 'available', 2)
    ]
  });

  const results = await service.nearby({ latitude: 12.9, longitude: 80.2, sort: 'availability' });
  assert.deepEqual(results.map((entry) => entry.name), ['Far Busy', 'Near Open', 'Near Also Open', 'Near Quiet']);
});

test('nearby falls back to Google Places with computed distances when the catalogue has no matches', async () => {
  const { service } = buildService({
    documents: [],
    mapsEnabled: true,
    places: [
      { googlePlaceId: 'place-1', name: 'Riverside', location: { type: 'Point', coordinates: [80.2301, 12.9351] } },
      { googlePlaceId: 'place-2', name: 'Corner Cafe', address: '12 Beach Road' }
    ]
  });

  const results = await service.nearby({ latitude: 12.9255, longitude: 80.2201, radiusMeters: 5000 });

  assert.deepEqual(results.map((entry) => entry.name), ['Riverside', 'Corner Cafe']);
  assert.equal(results[0].source, 'places');
  assert.ok(results[0].distanceMeters > 1400 && results[0].distanceMeters < 1700, 'haversine distance is reported in meters');
  assert.deepEqual(results[1].availability, { available: 0, reserved: 0, occupied: 0, unavailable: 0, total: 0 });
  assert.equal(results[1].distanceMeters, undefined);
});

test('nearby rejects malformed search parameters', async () => {
  const { service } = buildService({ documents: [restaurant('Har Grill', 100)] });

  await assert.rejects(() => service.nearby({ latitude: 'north', longitude: 80.2 }), (error) => error.status === 400);
  await assert.rejects(() => service.nearby({ latitude: 12.9, longitude: 80.2, radiusMeters: 90000 }), (error) => error.status === 400);
  await assert.rejects(() => service.nearby({ latitude: 12.9, longitude: 80.2, sort: 'rating' }), (error) => error.status === 400);
  await assert.rejects(() => service.nearby({ latitude: 12.9, longitude: 80.2, limit: 0 }), (error) => error.status === 400);
  await assert.rejects(() => service.nearby({ latitude: 12.9, longitude: 80.2, limit: 4.5 }), (error) => error.status === 400);
});
