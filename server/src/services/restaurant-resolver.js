import mongoose from 'mongoose';

export async function resolveRestaurantId(restaurants, restaurantId) {
  if (!mongoose.Types.ObjectId.isValid(restaurantId)) {
    throw Object.assign(new Error('Restaurant not found'), { status: 404 });
  }

  const restaurant = await restaurants.findOne({ restaurantId }).select('_id').lean();
  if (!restaurant) {
    throw Object.assign(new Error('Restaurant not found'), { status: 404 });
  }

  return new mongoose.Types.ObjectId(restaurantId);
}