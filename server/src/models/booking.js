import mongoose from 'mongoose';

/**
 * Migration note:
 * Schema extended to support restaurant staff dashboard tracking:
 * - Added 'seated' and 'no-show' to status enum (additive; existing documents remain valid).
 * - Added optional 'seatedAt' and 'completedAt' timestamp fields.
 * - Added compound indexes on { restaurantId: 1, createdAt: 1 } and { restaurantId: 1, status: 1 }
 *   for fast dashboard filtering, pagination, and aggregation stats.
 * - The existing partial unique index on { restaurantId: 1, userId: 1 } for status 'confirmed'
 *   is preserved unmodified, ensuring 20-way concurrency protection is unaffected.
 */
const bookingSchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  tableId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Table' },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  partySize: { type: Number, required: true, min: 1 },
  startsAt: { type: Date, required: true },
  source: { type: String, enum: ['customer', 'walk-in', 'queue'], default: 'customer' },
  status: {
    type: String,
    enum: ['confirmed', 'seated', 'completed', 'cancelled', 'no-show'],
    default: 'confirmed'
  },
  seatedAt: { type: Date },
  completedAt: { type: Date },
  cancelledAt: { type: Date }
}, { timestamps: true });

bookingSchema.index({ restaurantId: 1, _id: 1 });
bookingSchema.index({ restaurantId: 1, tableId: 1, startsAt: 1 });
bookingSchema.index({ restaurantId: 1, createdAt: 1 });
bookingSchema.index({ restaurantId: 1, status: 1 });
bookingSchema.index(
  { restaurantId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: 'confirmed' } }
);

export const Booking = mongoose.model('Booking', bookingSchema);
