export class OtpStore {
  constructor(redis, ttlSeconds) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
  }

  key(email) {
    return `otp:${email.trim().toLowerCase()}`;
  }

  async save(email, otp) {
    await this.redis.set(this.key(email), otp, 'EX', this.ttlSeconds);
  }

  async consume(email) {
    const key = this.key(email);
    const otp = await this.redis.get(key);
    if (otp) await this.redis.del(key);
    return otp;
  }
}
