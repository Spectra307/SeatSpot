import mongoose from 'mongoose';

export async function connectDatabase({ mongoUri, mongoDbName }) {
  await mongoose.connect(mongoUri, { dbName: mongoDbName });
  return mongoose.connection;
}

export function databaseStatus() {
  return mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
