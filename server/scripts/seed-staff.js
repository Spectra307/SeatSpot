import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Restaurant } from '../src/models/restaurant.js';
import { User } from '../src/models/user.js';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const mongoUri = process.env.MONGO_URI ?? process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB_NAME ?? 'seatspot';
const { STAFF_NAME: name, STAFF_EMAIL: emailValue, STAFF_PASSWORD: password, STAFF_RESTAURANT_ID: restaurantIdValue } = process.env;

if (!mongoUri) throw new Error('MONGO_URI is required');
if (!name?.trim() || !emailValue?.trim() || String(password ?? '').length < 8 || !restaurantIdValue) {
  throw new Error('STAFF_NAME, STAFF_EMAIL, STAFF_PASSWORD (8+ characters), and STAFF_RESTAURANT_ID are required');
}
if (!mongoose.isValidObjectId(restaurantIdValue)) throw new Error('STAFF_RESTAURANT_ID must be a valid ObjectId');

const email = emailValue.trim().toLowerCase();
const restaurantId = new mongoose.Types.ObjectId(restaurantIdValue);
await connectDatabase({ mongoUri, mongoDbName });

try {
  const restaurant = await Restaurant.findOne({ restaurantId }).select('_id').lean();
  if (!restaurant) throw new Error('STAFF_RESTAURANT_ID does not match an existing restaurant');

  const passwordHash = await bcrypt.hash(password, 12);
  const staff = await User.findOneAndUpdate(
    { restaurantId, email },
    {
      $set: {
        name: name.trim(),
        passwordHash,
        role: 'staff',
        isVerified: true
      }
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );

  console.info(`Staff account provisioned: ${staff.email} for restaurant ${staff.restaurantId}`);
} finally {
  await disconnectDatabase();
}
