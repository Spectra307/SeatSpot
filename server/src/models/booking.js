import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  tableId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Table' },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  partySize: { type: Number, required: true, min: 1 },
  startsAt: { type: Date, required: true },
  source: { type: String, enum: ['customer', 'walk-in', 'queue'], default: 'customer' },
  status: { type: String, enum: ['confirmed', 'cancelled', 'completed'], default: 'confirmed' },
  cancelledAt: { type: Date }
}, { timestamps: true });

bookingSchema.index({ restaurantId: 1, _id: 1 });
bookingSchema.index({ restaurantId: 1, tableId: 1, startsAt: 1 });
bookingSchema.index(
  { restaurantId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: 'confirmed' } }
);

export const Booking = mongoose.model('Booking', bookingSchema);
