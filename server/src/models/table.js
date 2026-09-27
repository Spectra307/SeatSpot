import mongoose from 'mongoose';

const tableSchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  label: { type: String, required: true, trim: true },
  capacity: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['available', 'reserved', 'occupied', 'unavailable'], default: 'available' }
}, { timestamps: true });

tableSchema.index({ restaurantId: 1, _id: 1 });
tableSchema.index({ restaurantId: 1, label: 1 }, { unique: true });

export const Table = mongoose.model('Table', tableSchema);
