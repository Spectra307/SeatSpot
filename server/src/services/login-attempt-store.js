import { createHash } from 'node:crypto';

export class LoginAttemptStore {
  constructor(redis, { maxAttempts = 5, windowSeconds = 900, lockoutSeconds = 60, keyPrefix = 'auth:login:' } = {}) {
    this.redis = redis;
    this.maxAttempts = maxAttempts;
    this.windowSeconds = windowSeconds;
    this.lockoutSeconds = lockoutSeconds;
    this.keyPrefix = keyPrefix;
  }

  _key(kind, value) {
    const normalized = String(value ?? 'unknown').trim().toLowerCase();
    const hash = createHash('sha256').update(normalized).digest('hex');
    return `${this.keyPrefix}${kind}:${hash}`;
  }

  _keys(email, ipAddress) {
    return [
      this._key('email:attempts', email),
      this._key('ip:attempts', ipAddress),
      this._key('email:locked', email),
      this._key('ip:locked', ipAddress)
    ];
  }

  async isLocked(email, ipAddress) {
    const [, , emailLock, ipLock] = this._keys(email, ipAddress);
    const [emailLocked, ipLocked] = await this.redis.mget(emailLock, ipLock);
    return Boolean(emailLocked || ipLocked);
  }

  async recordFailure(email, ipAddress) {
    const keys = this._keys(email, ipAddress);
    const locked = await this.redis.eval(`
      local maximum = tonumber(ARGV[1])
      local window = tonumber(ARGV[2])
      local lockout = tonumber(ARGV[3])
      local locked = 0

      for index = 1, 2 do
        local count = redis.call('INCR', KEYS[index])
        if count == 1 then redis.call('EXPIRE', KEYS[index], window) end
        if count >= maximum then
          redis.call('SET', KEYS[index + 2], '1', 'EX', lockout)
          locked = 1
        end
      end

      return locked
    `, 4, ...keys, this.maxAttempts, this.windowSeconds, this.lockoutSeconds);
    return Number(locked) === 1;
  }

  async clear(email, ipAddress) {
    await this.redis.del(...this._keys(email, ipAddress));
  }
}