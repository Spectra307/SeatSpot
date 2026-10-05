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
    cuisine: 'Modern European',
    address: '12 Harbor View Road, Egmore, Chennai',
    coordinates: [80.2201, 12.9255],
    slug: 'harbor',
    tables: [
      { capacity: 2, status: 'available' },
      { capacity: 2, status: 'available' },
      { capacity: 4, status: 'occupied' },
      { capacity: 4, status: 'available' },
      { capacity: 6, status: 'available' },
      { capacity: 8, status: 'occupied' },
      { capacity: 4, status: 'available' },
      { capacity: 2, status: 'available' },
      { capacity: 10, status: 'occupied' },
      { capacity: 6, status: 'reserved' },
      { capacity: 8, status: 'available' },
      { capacity: 12, status: 'available' }
    ]
  },
  {
    name: 'Garden Table',
    cuisine: 'South Indian',
    address: 'Ramapuram Main Road, Chennai',
    coordinates: [80.2178, 12.9271],
    slug: 'garden',
    tables: [
      { capacity: 2, status: 'available' },
      { capacity: 4, status: 'available' },
      { capacity: 4, status: 'occupied' },
      { capacity: 2, status: 'available' },
      { capacity: 6, status: 'available' },
      { capacity: 8, status: 'occupied' },
      { capacity: 4, status: 'available' },
      { capacity: 10, status: 'available' }
    ]
  },
  {
    name: 'Tandoori Nights',
    cuisine: 'North Indian BBQ',
    address: '48 Bazaar Road, Kilpauk, Chennai',
    coordinates: [80.2331, 12.9412],
    slug: 'tandoori',
    tables: [
      { capacity: 2, status: 'available' },
      { capacity: 4, status: 'available' },
      { capacity: 4, status: 'occupied' },
      { capacity: 6, status: 'available' },
      { capacity: 2, status: 'available' },
      { capacity: 8, status: 'reserved' },
      { capacity: 4, status: 'available' },
      { capacity: 10, status: 'occupied' },
      { capacity: 6, status: 'available' },
      { capacity: 4, status: 'unavailable' }
    ]
  },
  {
    name: 'Sushi Bay',
    cuisine: 'Japanese',
    address: '7 Beach View Lane, Besant Nagar, Chennai',
    coordinates: [80.2103, 12.9345],
    slug: 'sushi',
    tables: [
      { capacity: 2, status: 'available' },
      { capacity: 2, status: 'occupied' },
      { capacity: 4, status: 'available' },
      { capacity: 4, status: 'reserved' },
      { capacity: 6, status: 'available' },
      { capacity: 2, status: 'available' }
    ]
  },
  {
    name: 'Coastal Catch',
    cuisine: 'Seafood',
    address: '23 Marina Esplanade, Chennai',
    coordinates: [80.227, 12.9105],
    slug: 'coastal',
    tables: [
      { capacity: 2, status: 'available' },
      { capacity: 4, status: 'occupied' },
      { capacity: 4, status: 'available' },
      { capacity: 6, status: 'reserved' },
      { capacity: 2, status: 'available' },
      { capacity: 8, status: 'occupied' },
      { capacity: 4, status: 'available' },
      { capacity: 10, status: 'available' },
      { capacity: 6, status: 'available' }
    ]
  },
  {
    // Deliberately the smallest room in the demo: three bookable tables, so a
    // live demo can watch it drop 3 -> 2 -> Full as bookings land.
    name: 'Spice House Anna Nagar',
    cuisine: 'Chettinad',
    address: 'AG Block, Anna Nagar, Chennai',
    coordinates: [80.2081, 12.975],
    slug: 'spice',
    tables: [
      { capacity: 4, status: 'available' },
      { capacity: 4, status: 'available' },
      { capacity: 6, status: 'reserved' },
      { capacity: 4, status: 'available' },
      { capacity: 2, status: 'unavailable' }
    ]
  }
];

await connectDatabase({ mongoUri, mongoDbName });
try {
  for (const demo of demos) {
    const restaurant = await Restaurant.findOneAndUpdate(
      { name: demo.name },
      {
        $set: {
          cuisine: demo.cuisine,
          address: demo.address,
          location: { type: 'Point', coordinates: demo.coordinates }
        },
        $setOnInsert: { restaurantId: new mongoose.Types.ObjectId() }
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    for (let index = 0; index < demo.tables.length; index += 1) {
      const { capacity, status } = demo.tables[index];
      await Table.findOneAndUpdate(
        { restaurantId: restaurant.restaurantId, label: `T${index + 1}` },
        { $set: { capacity, status } },
        { upsert: true, runValidators: true }
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

    const available = demo.tables.filter((table) => table.status === 'available').length;
    console.info(`Seeded ${demo.name} (${demo.cuisine}) - ${available} of ${demo.tables.length} tables free, staff account ${email}`);
  }
  console.info(`Demo reset complete: ${demos.length} restaurants. Re-running this script restores the table states above.`);
} finally {
  await disconnectDatabase();
}