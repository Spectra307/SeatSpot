import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Restaurant } from '../src/models/restaurant.js';
import { Table } from '../src/models/table.js';
import { RestaurantService } from '../src/services/restaurant-service.js';

const jwtSecret = 'nearby-routes-test-secret';
const mongoUri = process.env.MONGO_URI
  ?? process.env.MONGODB_URI
  ?? 'mongodb://127.0.0.1:27017/seatspot?replicaSet=rs0';
const databaseName = `seatspot_nearby_tests_${process.pid}`;
const searchPoint = { latitude: 12.9255, longitude: 80.2201 };
let app;

function customerToken() {
  return jwt.sign({ sub: new mongoose.Types.ObjectId().toString(), role: 'customer', restaurantId: '000000000000000000000001' }, jwtSecret);
}

function query(overrides = {}) {
  const params = new URLSearchParams({
    latitude: String(searchPoint.latitude),
    longitude: String(searchPoint.longitude),
    radiusMeters: '12000',
    ...overrides
  });
  return `/api/restaurants/nearby?${params}`;
}

async function seedRestaurant({ name, cuisine, coordinates, tables }) {
  const restaurantId = new mongoose.Types.ObjectId();
  await Restaurant.create({
    restaurantId,
    name,
    cuisine,
    address: `${name} address, Chennai`,
    location: { type: 'Point', coordinates }
  });
  await Table.insertMany(tables.map((table, index) => ({
    restaurantId,
    label: `T${index + 1}`,
    capacity: table.capacity,
    status: table.status
  })));
  return restaurantId;
}

before(async () => {
  await mongoose.connect(mongoUri, { dbName: databaseName, serverSelectionTimeoutMS: 5000 });
  await Promise.all([Restaurant.init(), Table.init()]);
  app = createApp({
    restaurantService: new RestaurantService({ restaurants: Restaurant, tables: Table, mapsClient: { enabled: false } }),
    jwtSecret
  });

  await seedRestaurant({
    name: 'Harbor & Hearth',
    cuisine: 'Modern European',
    coordinates: [80.2201, 12.9255],
    tables: [
      { capacity: 2, status: 'available' },
      { capacity: 4, status: 'available' },
      { capacity: 6, status: 'occupied' }
    ]
  });
  await seedRestaurant({
    name: 'Spice House Anna Nagar',
    cuisine: 'Chettinad',
    coordinates: [80.2081, 12.975],
    tables: [
      { capacity: 6, status: 'available' },
      { capacity: 8, status: 'available' },
      { capacity: 4, status: 'reserved' }
    ]
  });
});

after(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test('nearby search requires authentication', async () => {
  await request(app).get(query()).expect(401);
});

test('nearby search returns name, cuisine, distance, and availability for every restaurant', async () => {
  const response = await request(app)
    .get(query())
    .set('authorization', `Bearer ${customerToken()}`)
    .expect(200);

  assert.equal(response.body.restaurants.length, 2);
  for (const entry of response.body.restaurants) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.length > 0, 'name is present');
    assert.equal(typeof entry.cuisine, 'string');
    assert.ok(entry.cuisine.length > 0, 'cuisine tag is present');
    assert.equal(typeof entry.distanceMeters, 'number');
    assert.ok(entry.distanceMeters >= 0 && entry.distanceMeters < 12000, 'distance is within the searched radius');
    assert.equal(typeof entry.availability, 'object');
    assert.equal(typeof entry.availability.available, 'number');
    assert.equal(typeof entry.availability.total, 'number');
    assert.equal(typeof entry.availability.reserved, 'number');
    assert.equal(typeof entry.availability.occupied, 'number');
    assert.equal(entry.source, 'catalogue');
  }

  const harbor = response.body.restaurants.find((entry) => entry.name === 'Harbor & Hearth');
  const spice = response.body.restaurants.find((entry) => entry.name === 'Spice House Anna Nagar');
  assert.equal(harbor.cuisine, 'Modern European');
  assert.ok(harbor.distanceMeters < 50, 'the restaurant at the search point is reported as the closest');
  assert.deepEqual(harbor.availability, { available: 2, reserved: 0, occupied: 1, unavailable: 0, total: 3 });
  assert.equal(spice.cuisine, 'Chettinad');
  assert.ok(spice.distanceMeters > 1000, 'a further restaurant reports a longer distance');
  assert.deepEqual(spice.availability, { available: 2, reserved: 1, occupied: 0, unavailable: 0, total: 3 });
});

test('nearby results are ordered by distance and honour the limit', async () => {
  const response = await request(app)
    .get(query({ limit: '1' }))
    .set('authorization', `Bearer ${customerToken()}`)
    .expect(200);

  assert.equal(response.body.restaurants.length, 1);
  assert.equal(response.body.restaurants[0].name, 'Harbor & Hearth');
});

test('party size keeps only restaurants with a free table that can seat the party', async () => {
  const response = await request(app)
    .get(query({ partySize: '6' }))
    .set('authorization', `Bearer ${customerToken()}`)
    .expect(200);

  assert.deepEqual(response.body.restaurants.map((entry) => entry.name), ['Spice House Anna Nagar']);
  assert.equal(response.body.restaurants[0].tablesForParty, 2, 'both 6- and 8-seat tables are counted');
});

test('party size can be reported without hiding restaurants that cannot seat it', async () => {
  const response = await request(app)
    .get(query({ partySize: '6', fitsParty: 'false' }))
    .set('authorization', `Bearer ${customerToken()}`)
    .expect(200);

  const harbor = response.body.restaurants.find((entry) => entry.name === 'Harbor & Hearth');
  assert.equal(response.body.restaurants.length, 2);
  assert.equal(harbor.tablesForParty, 0);
  assert.equal(harbor.availability.available, 2);
});

test('nearby search rejects an out-of-range party size', async () => {
  const response = await request(app)
    .get(query({ partySize: '99' }))
    .set('authorization', `Bearer ${customerToken()}`)
    .expect(400);

  assert.match(response.body.error, /partySize/);
});

test('area search reports a clear error when Google Maps is not configured', async () => {
  await request(app).get('/api/restaurants/geocode?q=Anna%20Nagar').expect(401);

  const tooShort = await request(app)
    .get('/api/restaurants/geocode?q=ab')
    .set('authorization', `Bearer ${customerToken()}`)
    .expect(400);
  assert.match(tooShort.body.error, /at least 3 characters/);

  const unavailable = await request(app)
    .get('/api/restaurants/geocode?q=Anna%20Nagar')
    .set('authorization', `Bearer ${customerToken()}`)
    .expect(503);
  assert.match(unavailable.body.error, /GOOGLE_MAPS_API_KEY/);
});