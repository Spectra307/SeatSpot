export class OtpStore {
  constructor(redis, ttlSeconds) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
  }

  key(email, purpose = 'code') {
    return `otp:${purpose}:${email.trim().toLowerCase()}`;
  }

  async allowRequest(email, limit = 3, windowSeconds = 900) {
    const allowed = await this.redis.eval(`
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
      if count > tonumber(ARGV[1]) then return 0 end
      return 1
    `, 1, this.key(email, 'requests'), limit, windowSeconds);
    return Number(allowed) === 1;
  }

  async save(email, otp) {
    await this.redis.multi()
      .set(this.key(email), otp, 'EX', this.ttlSeconds)
      .set(this.key(email, 'attempts'), '0', 'EX', this.ttlSeconds)
      .exec();
  }

  async verify(email, suppliedOtp, maxAttempts = 5) {
    const result = await this.redis.eval(`
      local otp = redis.call('GET', KEYS[1])
      if not otp then return 0 end

      local attempts = tonumber(redis.call('GET', KEYS[2]) or '0')
      local maximum = tonumber(ARGV[2])
      if attempts >= maximum then
        redis.call('DEL', KEYS[1])
        return 0
      end

      if otp == ARGV[1] then
        redis.call('DEL', KEYS[1], KEYS[2])
        return 1
      end

      local ttl = redis.call('TTL', KEYS[1])
      local count = redis.call('INCR', KEYS[2])
      if count == 1 and ttl > 0 then redis.call('EXPIRE', KEYS[2], ttl) end
      if count >= maximum then redis.call('DEL', KEYS[1]) end
      return 0
    `, 2, this.key(email), this.key(email, 'attempts'), String(suppliedOtp ?? ''), maxAttempts);
    return Number(result) === 1;
  }
}
