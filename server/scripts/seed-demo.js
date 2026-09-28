import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Restaurant } from '../src/models/restaurant.js';
import { Table } from '../src/models/table.js';
import { User } from '../src/models/user.js';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

const mongoUri = process.env.MONGO_URI ?? process.env.MONGODB_URI;
const mongoDbName = process.env.MONGODB_DB_NAME ?? 'seatspot';
const staffPassword = process.env.DEMO_STAFF_PASSWORD;
if (!mongoUri) throw new Error('MONGO_URI is required');
if (String(staffPassword ?? '').length < 8) throw new Error('DEMO_STAFF_PASSWORD must contain at least 8 characters');

const demos = [
  {
    name: 'Harbor & Hearth',
    address: 'Easwari Engineering College, Chennai',
    coordinates: [80.2201, 12.9255],
    slug: 'harbor',
    capacities: [2, 2, 4, 4, 6, 8]
  },
  {
    name: 'Garden Table',
    address: 'Ramapuram, Chennai',
    coordinates: [80.2178, 12.9271],
    slug: 'garden',
    capacities: [2, 4, 4, 6, 8, 10]
  }
];

await connectDatabase({ mongoUri, mongoDbName });
try {
  for (const demo of demos) {
    let restaurant = await Restaurant.findOne({ name: demo.name });
    if (!restaurant) {
      restaurant = await Restaurant.create({
        restaurantId: new mongoose.Types.ObjectId(),
        name: demo.name,
        address: demo.address,
        location: { type: 'Point', coordinates: demo.coordinates }
      });
    }

    for (let index = 0; index < demo.capacities.length; index += 1) {
      await Table.updateOne(
        { restaurantId: restaurant.restaurantId, label: `T${index + 1}` },
        { $setOnInsert: { capacity: demo.capacities[index], status: 'available' } },
        { upsert: true }
      );
    }

    const email = `staff.${demo.slug}@seatspot.local`;
    await User.findOneAndUpdate(
      { restaurantId: restaurant.restaurantId, email },
      {
        $set: {
          name: `${demo.name} Staff`,
          passwordHash: await bcrypt.hash(staffPassword, 12),
          role: 'staff',
          isVerified: true
        }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    console.info(`Seeded ${demo.name} with ${demo.capacities.length} tables and staff account ${email}`);
  }
} finally {
  await disconnectDatabase();
}
