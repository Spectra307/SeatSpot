import mongoose from 'mongoose';

const restaurantSchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, immutable: true },
  name: { type: String, required: true, trim: true },
  address: { type: String, trim: true },
  timezone: { type: String, default: 'Asia/Kolkata' }
}, { timestamps: true });

restaurantSchema.index({ restaurantId: 1, _id: 1 });

export const Restaurant = mongoose.model('Restaurant', restaurantSchema);
