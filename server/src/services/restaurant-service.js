import mongoose from 'mongoose';

function validateCoordinates(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw Object.assign(new Error('Valid latitude and longitude are required'), { status: 400 });
  }
}

function availabilityByStatus(rows) {
  const counts = { available: 0, reserved: 0, occupied: 0, unavailable: 0, total: 0 };
  for (const row of rows) {
    counts[row._id] = row.count;
    counts.total += row.count;
  }
  return counts;
}

export class RestaurantService {
  constructor({ restaurants, tables, mapsClient }) {
    this.restaurants = restaurants;
    this.tables = tables;
    this.mapsClient = mapsClient;
  }

  async create(input) {
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    validateCoordinates(latitude, longitude);
    if (!input.name?.trim()) throw Object.assign(new Error('Restaurant name is required'), { status: 400 });
    const restaurantId = new mongoose.Types.ObjectId();
    return this.restaurants.create({
      restaurantId,
      name: input.name.trim(),
      address: input.address?.trim(),
      googlePlaceId: input.googlePlaceId?.trim(),
      location: { type: 'Point', coordinates: [longitude, latitude] },
      timezone: input.timezone ?? 'Asia/Kolkata'
    });
  }

  async get(restaurantId) {
    const restaurant = await this.restaurants.findOne({ restaurantId }).lean();
    if (!restaurant) throw Object.assign(new Error('Restaurant not found'), { status: 404 });
    return restaurant;
  }

  async update(restaurantId, input) {
    const update = {};
    for (const key of ['name', 'address', 'timezone', 'googlePlaceId']) if (input[key] !== undefined) update[key] = input[key];
    if (input.latitude !== undefined || input.longitude !== undefined) {
      const latitude = Number(input.latitude);
      const longitude = Number(input.longitude);
      validateCoordinates(latitude, longitude);
      update.location = { type: 'Point', coordinates: [longitude, latitude] };
    }
    const restaurant = await this.restaurants.findOneAndUpdate({ restaurantId }, update, { new: true, runValidators: true }).lean();
    if (!restaurant) throw Object.assign(new Error('Restaurant not found'), { status: 404 });
    return restaurant;
  }

  async remove(restaurantId) {
    const result = await this.restaurants.deleteOne({ restaurantId });
    if (!result.deletedCount) throw Object.assign(new Error('Restaurant not found'), { status: 404 });
  }

  async availability(restaurantId) {
    const rows = await this.tables.aggregate([
      { $match: { restaurantId: new mongoose.Types.ObjectId(restaurantId) } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    return availabilityByStatus(rows);
  }

  async nearby({ latitude, longitude, radiusMeters = 5000 }) {
    latitude = Number(latitude);
    longitude = Number(longitude);
    radiusMeters = Number(radiusMeters);
    validateCoordinates(latitude, longitude);
    if (!Number.isFinite(radiusMeters) || radiusMeters < 1 || radiusMeters > 50000) throw Object.assign(new Error('radiusMeters must be between 1 and 50000'), { status: 400 });

    const local = await this.restaurants.find({ location: { $near: { $geometry: { type: 'Point', coordinates: [longitude, latitude] }, $maxDistance: radiusMeters } } }).lean();
    if (local.length || !this.mapsClient.enabled) return Promise.all(local.map(async (restaurant) => ({ ...restaurant, availability: await this.availability(restaurant.restaurantId) })));

    const places = await this.mapsClient.searchNearby({ latitude, longitude, radiusMeters });
    return places.map((place) => ({ ...place, availability: { available: 0, reserved: 0, occupied: 0, unavailable: 0, total: 0 } }));
  }
}
