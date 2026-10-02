import mongoose from 'mongoose';

const NEARBY_SORTS = new Set(['distance', 'availability']);
const DEFAULT_NEARBY_LIMIT = 24;
const MAX_NEARBY_LIMIT = 100;
const MAX_NEARBY_CANDIDATES = 200;
const EARTH_RADIUS_METERS = 6371008.8;

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function objectIdKey(value) {
  return String(new mongoose.Types.ObjectId(value));
}

function validateCoordinates(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw httpError('Valid latitude and longitude are required', 400);
  }
}

function emptyCounts() {
  return { available: 0, reserved: 0, occupied: 0, unavailable: 0, total: 0 };
}

function applyCount(counts, status, count) {
  if (Object.hasOwn(counts, status)) counts[status] += count;
  counts.total += count;
}

function toBoolean(value) {
  if (value === undefined || value === null || value === '') return false;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function parseLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_NEARBY_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NEARBY_LIMIT) {
    throw httpError(`limit must be a whole number between 1 and ${MAX_NEARBY_LIMIT}`, 400);
  }
  return limit;
}

function haversineMeters(fromLatitude, fromLongitude, toLatitude, toLongitude) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(toLatitude - fromLatitude);
  const longitudeDelta = toRadians(toLongitude - fromLongitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(fromLatitude)) * Math.cos(toRadians(toLatitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

function byAvailability(first, second) {
  if (second.availability.available !== first.availability.available) return second.availability.available - first.availability.available;
  if (second.availability.total !== first.availability.total) return second.availability.total - first.availability.total;
  return (first.distanceMeters ?? Infinity) - (second.distanceMeters ?? Infinity);
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
    if (!input.name?.trim()) throw httpError('Restaurant name is required', 400);
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
    if (!restaurant) throw httpError('Restaurant not found', 404);
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
    if (!restaurant) throw httpError('Restaurant not found', 404);
    return restaurant;
  }

  async remove(restaurantId) {
    const result = await this.restaurants.deleteOne({ restaurantId });
    if (!result.deletedCount) throw httpError('Restaurant not found', 404);
  }

  async availability(restaurantId) {
    const counts = await this.availabilityForMany([restaurantId]);
    return counts.get(objectIdKey(restaurantId)) ?? emptyCounts();
  }

  async availabilityForMany(restaurantIds) {
    const ids = [...new Set(restaurantIds.map((restaurantId) => String(restaurantId)))].filter((id) => mongoose.isValidObjectId(id));
    if (!ids.length) return new Map();
    const rows = await this.tables.aggregate([
      { $match: { restaurantId: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } } },
      { $group: { _id: { restaurantId: '$restaurantId', status: '$status' }, count: { $sum: 1 } } }
    ]);
    const countsByRestaurant = new Map();
    for (const row of rows) {
      const key = String(row._id.restaurantId);
      const counts = countsByRestaurant.get(key) ?? emptyCounts();
      applyCount(counts, row._id.status, row.count);
      countsByRestaurant.set(key, counts);
    }
    return countsByRestaurant;
  }

  async tableGrid(restaurantId) {
    return this.tables.find({ restaurantId: new mongoose.Types.ObjectId(restaurantId) })
      .select('_id restaurantId label capacity status')
      .sort({ label: 1 })
      .lean();
  }

  async nearby({ latitude, longitude, radiusMeters = 5000, sort = 'distance', openOnly = false, limit: limitInput } = {}) {
    latitude = Number(latitude);
    longitude = Number(longitude);
    radiusMeters = Number(radiusMeters);
    validateCoordinates(latitude, longitude);
    if (!Number.isFinite(radiusMeters) || radiusMeters < 1 || radiusMeters > 50000) throw httpError('radiusMeters must be between 1 and 50000', 400);
    const requestedSort = sort ?? 'distance';
    if (!NEARBY_SORTS.has(requestedSort)) throw httpError('sort must be either distance or availability', 400);
    const openOnlyRequested = toBoolean(openOnly);
    const limit = parseLimit(limitInput);

    const ranked = requestedSort === 'availability' || openOnlyRequested;
    const candidateLimit = Math.min(ranked ? limit * 4 : limit, MAX_NEARBY_CANDIDATES);
    const local = await this.restaurants.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [longitude, latitude] },
          key: 'location',
          distanceField: 'distanceMeters',
          maxDistance: radiusMeters,
          spherical: true
        }
      },
      { $limit: candidateLimit }
    ]);

    if (local.length || !this.mapsClient.enabled) {
      const countsByRestaurant = await this.availabilityForMany(local.map((restaurant) => restaurant.restaurantId));
      let results = local.map((restaurant) => ({
        ...restaurant,
        source: 'catalogue',
        availability: countsByRestaurant.get(objectIdKey(restaurant.restaurantId)) ?? emptyCounts()
      }));
      if (openOnlyRequested) results = results.filter((restaurant) => restaurant.availability.available > 0);
      if (requestedSort === 'availability') results.sort(byAvailability);
      return results.slice(0, limit);
    }

    const places = await this.mapsClient.searchNearby({ latitude, longitude, radiusMeters });
    return places.map((place) => ({
      ...place,
      source: 'places',
      distanceMeters: place.location
        ? Math.round(haversineMeters(latitude, longitude, place.location.coordinates[1], place.location.coordinates[0]))
        : undefined,
      availability: emptyCounts()
    })).sort((first, second) => (first.distanceMeters ?? Infinity) - (second.distanceMeters ?? Infinity)).slice(0, limit);
  }
}
