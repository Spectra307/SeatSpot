import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// OtpStore — Redis-backed OTP storage with hashed codes.
//
// Redis key layout
//   otp:code:<email>      — SHA-256 hash of the OTP, TTL = otpTtlSeconds
//   otp:attempts:<email>  — wrong-attempt counter, same TTL as the code
//   otp:requests:<email>  — request rate-limit counter, TTL = windowSeconds
//   otp:cooldown:<email>  — 60-second per-send cooldown flag
// ---------------------------------------------------------------------------

function hashOtp(otp) {
  return createHash('sha256').update(String(otp)).digest('hex');
}

export class OtpStore {
  constructor(redis, ttlSeconds) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
  }

  key(email, purpose = 'code') {
    return `otp:${purpose}:${email.trim().toLowerCase()}`;
  }

  /**
   * Returns true if another OTP request is allowed under the hourly cap.
   * Increments the counter atomically; sets TTL only on the first increment.
   */
  async allowRequest(email, limit = 3, windowSeconds = 3600) {
    const allowed = await this.redis.eval(`
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
      if count > tonumber(ARGV[1]) then return 0 end
      return 1
    `, 1, this.key(email, 'requests'), limit, windowSeconds);
    return Number(allowed) === 1;
  }

  /**
   * Returns true if the per-send cooldown (60 s) has NOT elapsed yet.
   * A staff member who resends too quickly gets a 429 before burning a slot
   * in the hourly cap.
   */
  async isCooldown(email, cooldownSeconds = 60) {
    const exists = await this.redis.exists(this.key(email, 'cooldown'));
    return exists === 1;
  }

  /**
   * Persist a new OTP (hashed).  Atomically replaces any existing code and
   * resets the attempt counter; also sets the 60-second per-send cooldown.
   */
  async save(email, otp) {
    const hash = hashOtp(otp);
    await this.redis.multi()
      .set(this.key(email), hash, 'EX', this.ttlSeconds)
      .set(this.key(email, 'attempts'), '0', 'EX', this.ttlSeconds)
      .set(this.key(email, 'cooldown'), '1', 'EX', 60)
      .exec();
  }

  /**
   * Verify a supplied OTP against the stored hash.
   *
   * Returns true on a match and deletes the code + attempt keys.
   * Returns false on mismatch; increments attempt counter.
   * Deletes the code when maxAttempts is reached (locks out further guesses).
   *
   * The comparison is done in Lua so it is atomic.  We pass the *hash* of the
   * supplied OTP rather than the OTP itself — Redis never sees the plaintext.
   */
  async verify(email, suppliedOtp, maxAttempts = 5) {
    const suppliedHash = hashOtp(String(suppliedOtp ?? ''));
    const result = await this.redis.eval(`
      local stored = redis.call('GET', KEYS[1])
      if not stored then return 0 end

      local attempts = tonumber(redis.call('GET', KEYS[2]) or '0')
      local maximum  = tonumber(ARGV[2])
      if attempts >= maximum then
        redis.call('DEL', KEYS[1])
        return 0
      end

      if stored == ARGV[1] then
        redis.call('DEL', KEYS[1], KEYS[2])
        return 1
      end

      local ttl   = redis.call('TTL', KEYS[1])
      local count = redis.call('INCR', KEYS[2])
      if count == 1 and ttl > 0 then redis.call('EXPIRE', KEYS[2], ttl) end
      if count >= maximum then redis.call('DEL', KEYS[1]) end
      return 0
    `, 2, this.key(email), this.key(email, 'attempts'), suppliedHash, maxAttempts);
    return Number(result) === 1;
  }
}
