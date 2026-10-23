import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const OTP_MAX_ATTEMPTS = 5;
const OTP_REQUEST_LIMIT = 3;
const OTP_REQUEST_WINDOW_SECONDS = 3600; // 1 hour
const OTP_TTL_MINUTES = 5;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('seatspot-invalid-password', 12);

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function createOtp() {
  // crypto.randomInt(min, max) — max is exclusive, so this produces [100000, 999999]
  return String(randomInt(100000, 1000000));
}

export class AuthService {
  constructor({ users, otpStore, loginAttemptStore, emailService, jwtSecret, jwtExpiresIn, authPartitionRestaurantId }) {
    this.users = users;
    this.otpStore = otpStore;
    this.loginAttemptStore = loginAttemptStore;
    this.emailService = emailService; // optional — no-op when absent
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

    // Send OTP email — fire-and-forget so email failure never blocks signup.
    // In development with no SMTP config, emailService.sendOtp() logs to console.
    // The OTP is NEVER returned in the API response.
    if (this.emailService) {
      void this.emailService.sendOtp(normalizedEmail, otp, { expiresMinutes: OTP_TTL_MINUTES });
    }

    return {};
  }

  async requestOtp({ email }) {
    const normalizedEmail = normalizeEmail(email);
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      throw Object.assign(new Error('A valid email is required'), { status: 400 });
    }

    // Check 60-second cooldown before burning an hourly-cap slot.
    if (await this.otpStore.isCooldown(normalizedEmail)) {
      throw Object.assign(new Error('Please wait 60 seconds before requesting another code.'), { status: 429 });
    }

    if (!await this.otpStore.allowRequest(normalizedEmail, OTP_REQUEST_LIMIT, OTP_REQUEST_WINDOW_SECONDS)) {
      throw Object.assign(new Error('Too many OTP requests. Try again later.'), { status: 429 });
    }

    // Look up the user but return the SAME response regardless of whether the
    // email is known — this prevents email enumeration.
    const user = await this.users.findOne({ restaurantId: this.authPartitionRestaurantId, email: normalizedEmail });
    if (user && !user.isVerified) {
      const otp = createOtp();
      await this.otpStore.save(normalizedEmail, otp);
      if (this.emailService) {
        void this.emailService.sendOtp(normalizedEmail, otp, { expiresMinutes: OTP_TTL_MINUTES });
      }
    }

    // Generic message — same body whether the email exists or not.
    return {};
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
