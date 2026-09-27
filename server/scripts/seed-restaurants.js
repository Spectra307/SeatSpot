import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { Restaurant } from '../src/models/restaurant.js';
import { Table } from '../src/models/table.js';

dotenv.config({ quiet: true });
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

const seedRestaurants = [
  { name: 'Harbor & Hearth', address: 'Easwari Engineering College, Chennai', location: [80.2201, 12.9255], tables: 12 },
  { name: 'Garden Table', address: 'Ramapuram, Chennai', location: [80.2178, 12.9271], tables: 8 }
];

await connectDatabase({ mongoUri: process.env.MONGODB_URI, mongoDbName: process.env.MONGODB_DB_NAME ?? 'seatspot' });
for (const seed of seedRestaurants) {
  let restaurant = await Restaurant.findOne({ name: seed.name });
  if (!restaurant) restaurant = await Restaurant.create({ restaurantId: new mongoose.Types.ObjectId(), name: seed.name, address: seed.address, location: { type: 'Point', coordinates: seed.location } });
  for (let number = 1; number <= seed.tables; number += 1) {
    await Table.updateOne({ restaurantId: restaurant.restaurantId, label: `T${number}` }, { $setOnInsert: { capacity: number % 3 === 0 ? 4 : 2, status: 'available' } }, { upsert: true });
  }
}
await disconnectDatabase();
console.info('Restaurant seed data is ready');
