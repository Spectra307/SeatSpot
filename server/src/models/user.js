import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  restaurantId: {
    type: mongoose.Schema.Types.ObjectId,
    default: '000000000000000000000001',
    immutable: true
  },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  isVerified: { type: Boolean, default: false },
  role: { type: String, enum: ['customer', 'staff', 'owner'], default: 'customer' }
}, { timestamps: true });

// Every operational collection carries restaurantId for co-location in a sharded cluster.
userSchema.index({ restaurantId: 1, _id: 1 });
userSchema.index({ restaurantId: 1, email: 1 }, { unique: true });

export const User = mongoose.model('User', userSchema);
