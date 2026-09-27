import mongoose from 'mongoose';

const queueEntrySchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  partySize: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['waiting', 'notified', 'seated', 'cancelled'], default: 'waiting' },
  joinedAt: { type: Date, default: Date.now }
}, { timestamps: true });

queueEntrySchema.index({ restaurantId: 1, _id: 1 });
queueEntrySchema.index({ restaurantId: 1, status: 1, joinedAt: 1 });

export const QueueEntry = mongoose.model('QueueEntry', queueEntrySchema);
