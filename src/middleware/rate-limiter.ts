import { Redis } from "ioredis";
import { config } from "../config/index.js";
import { RateLimitError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export class RateLimiter {
  private redis: Redis;
  private windowMs: number;
  private maxRequests: number;

  constructor(redis?: Redis) {
    this.redis =
      redis ??
      new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        keyPrefix: config.redis.keyPrefix,
        lazyConnect: true,
        enableOfflineQueue: false,
      });
    this.windowMs = config.rateLimiter.windowMs;
    this.maxRequests = config.rateLimiter.maxRequests;
  }

  async connect(): Promise<void> {
    if (this.redis.status !== "ready") {
      await this.redis.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.redis.status === "ready") {
      await this.redis.quit();
    }
  }

  /**
   * Sliding-window rate check using Redis sorted set.
   * Returns whether the request is allowed and metadata.
   */
  async check(key: string): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const redisKey = `ratelimit:${key}`;

    try {
      // Remove expired entries and count requests in window
      const result = await this.redis
        .multi()
        .zremrangebyscore(redisKey, 0, windowStart)
        .zadd(redisKey, now, `${now}:${Math.random()}`)
        .zcard(redisKey)
        .expire(redisKey, Math.ceil(this.windowMs / 1000) + 1)
        .exec();

      const count = (result?.[2]?.[1] as number) ?? 0;
      const allowed = count <= this.maxRequests;

      if (!allowed) {
        // Get the expiry TTL for the reset time
        const ttl = await this.redis.pttl(redisKey);
        const resetAt = ttl > 0 ? now + ttl : now + this.windowMs;

        return {
          allowed: false,
          remaining: 0,
          resetAt,
        };
      }

      return {
        allowed: true,
        remaining: Math.max(0, this.maxRequests - count),
        resetAt: now + this.windowMs,
      };
    } catch (err) {
      logger.error({ err, key }, "Rate limiter Redis error — allowing request by default");
      return { allowed: true, remaining: 1, resetAt: now + this.windowMs };
    }
  }

  /**
   * Throws RateLimitError if the request exceeds the limit.
   */
  async assertAllowed(key: string): Promise<void> {
    const result = await this.check(key);
    if (!result.allowed) {
      throw new RateLimitError(
        `Rate limit exceeded for key "${key}". Retry after ${result.resetAt}.`,
        result.resetAt - Date.now(),
      );
    }
  }
}
