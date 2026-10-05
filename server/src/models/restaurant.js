import mongoose from 'mongoose';

const restaurantSchema = new mongoose.Schema({
  restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, immutable: true },
  name: { type: String, required: true, trim: true },
  cuisine: { type: String, trim: true },
  address: { type: String, trim: true },
  googlePlaceId: { type: String, trim: true, sparse: true },
  location: {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true }
  },
  timezone: { type: String, default: 'Asia/Kolkata' }
}, { timestamps: true });

restaurantSchema.index({ restaurantId: 1, _id: 1 });
restaurantSchema.index({ location: '2dsphere' });

export const Restaurant = mongoose.model('Restaurant', restaurantSchema);
