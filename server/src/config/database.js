import mongoose from 'mongoose';

export async function connectDatabase({ mongoUri, mongoDbName }) {
  try {
    await mongoose.connect(mongoUri, {
      dbName: mongoDbName,
      serverSelectionTimeoutMS: 10000
    });
    console.info('[SeatSpot] MongoDB connected');
    return mongoose.connection;
  } catch (error) {
    console.error('[SeatSpot] MongoDB connection failed:', error?.message ?? error);
    throw error;
  }
}

export function databaseStatus() {
  return mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
