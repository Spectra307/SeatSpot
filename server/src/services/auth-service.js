import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const OTP_LENGTH = 6;

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function createOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export class AuthService {
  constructor({ users, otpStore, jwtSecret, jwtExpiresIn, authPartitionRestaurantId }) {
    this.users = users;
    this.otpStore = otpStore;
    this.jwtSecret = jwtSecret;
    this.jwtExpiresIn = jwtExpiresIn;
    this.authPartitionRestaurantId = authPartitionRestaurantId;
  }

  async signup({ name, email, password }) {
    const normalizedEmail = normalizeEmail(email);
    if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(normalizedEmail) || String(password ?? '').length < 8) {
      throw Object.assign(new Error('Name, a valid email, and an 8-character password are required'), { status: 400 });
    }

    const query = { restaurantId: this.authPartitionRestaurantId, email: normalizedEmail };
    if (await this.users.findOne(query)) {
      throw Object.assign(new Error('An account with this email already exists'), { status: 409 });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await this.users.create({ restaurantId: this.authPartitionRestaurantId, name: name.trim(), email: normalizedEmail, passwordHash });
    const otp = createOtp();
    await this.otpStore.save(normalizedEmail, otp);
    return { otp };
  }

  async verifyOtp({ email, otp }) {
    const normalizedEmail = normalizeEmail(email);
    const expectedOtp = await this.otpStore.consume(normalizedEmail);
    if (!expectedOtp || String(otp ?? '') !== expectedOtp || String(otp).length !== OTP_LENGTH) {
      throw Object.assign(new Error('OTP is invalid or has expired'), { status: 400 });
    }

    const user = await this.users.findOneAndUpdate(
      { restaurantId: this.authPartitionRestaurantId, email: normalizedEmail },
      { isVerified: true },
      { new: true }
    );
    if (!user) throw Object.assign(new Error('Account not found'), { status: 404 });
    return this.issueToken(user);
  }

  async login({ email, password }) {
    const user = await this.users.findOne({ restaurantId: this.authPartitionRestaurantId, email: normalizeEmail(email) }).select('+passwordHash');
    if (!user || !await bcrypt.compare(String(password ?? ''), user.passwordHash)) {
      throw Object.assign(new Error('Email or password is incorrect'), { status: 401 });
    }
    if (!user.isVerified) throw Object.assign(new Error('Verify your email before signing in'), { status: 403 });
    return this.issueToken(user);
  }

  issueToken(user) {
    return jwt.sign({ sub: user._id.toString(), role: user.role, restaurantId: user.restaurantId.toString() }, this.jwtSecret, { expiresIn: this.jwtExpiresIn });
  }
}
