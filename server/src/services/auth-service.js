import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const OTP_MAX_ATTEMPTS = 5;
const OTP_REQUEST_LIMIT = 3;
const OTP_REQUEST_WINDOW_SECONDS = 900;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('seatspot-invalid-password', 12);

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function createOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export class AuthService {
  constructor({ users, otpStore, loginAttemptStore, jwtSecret, jwtExpiresIn, authPartitionRestaurantId }) {
    this.users = users;
    this.otpStore = otpStore;
    this.loginAttemptStore = loginAttemptStore;
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
    if (!await this.otpStore.allowRequest(normalizedEmail, OTP_REQUEST_LIMIT, OTP_REQUEST_WINDOW_SECONDS)) {
      throw Object.assign(new Error('Too many OTP requests. Try again later.'), { status: 429 });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await this.users.create({
      restaurantId: this.authPartitionRestaurantId,
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      role: 'customer'
    });
    const otp = createOtp();
    await this.otpStore.save(normalizedEmail, otp);
    return { otp };
  }

  async requestOtp({ email }) {
    const normalizedEmail = normalizeEmail(email);
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      throw Object.assign(new Error('A valid email is required'), { status: 400 });
    }
    if (!await this.otpStore.allowRequest(normalizedEmail, OTP_REQUEST_LIMIT, OTP_REQUEST_WINDOW_SECONDS)) {
      throw Object.assign(new Error('Too many OTP requests. Try again later.'), { status: 429 });
    }

    const user = await this.users.findOne({ restaurantId: this.authPartitionRestaurantId, email: normalizedEmail });
    if (!user || user.isVerified) return { otp: undefined };

    const otp = createOtp();
    await this.otpStore.save(normalizedEmail, otp);
    return { otp };
  }

  async verifyOtp({ email, otp }) {
    const normalizedEmail = normalizeEmail(email);
    const valid = await this.otpStore.verify(normalizedEmail, otp, OTP_MAX_ATTEMPTS);
    if (!valid) {
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

  async login({ email, password, restaurantId }, ipAddress = 'unknown') {
    const normalizedEmail = normalizeEmail(email);
    const user = await this.users.findOne({
      restaurantId: restaurantId ?? this.authPartitionRestaurantId,
      email: normalizedEmail
    }).select('+passwordHash');
    const passwordMatches = await bcrypt.compare(String(password ?? ''), user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    const locked = this.loginAttemptStore
      ? await this.loginAttemptStore.isLocked(normalizedEmail, ipAddress)
      : false;

    if (locked || !user || !passwordMatches || !user.isVerified) {
      if (this.loginAttemptStore && !locked) {
        await this.loginAttemptStore.recordFailure(normalizedEmail, ipAddress);
      }
      throw Object.assign(new Error('Email or password is incorrect'), { status: 401 });
    }
    if (this.loginAttemptStore) await this.loginAttemptStore.clear(normalizedEmail, ipAddress);
    return this.issueToken(user);
  }

  issueToken(user) {
    return jwt.sign({ sub: user._id.toString(), role: user.role, restaurantId: user.restaurantId.toString(), name: user.name }, this.jwtSecret, { expiresIn: this.jwtExpiresIn });
  }
}
