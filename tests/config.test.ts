import { describe, it, expect, beforeEach, vi } from "vitest";

describe("Config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("loads defaults when no env vars are set", async () => {
    // Set NODE_ENV to test to avoid it being test
    const { config } = await import("../src/config/index.js");

    expect(config.port).toBe(4000);
    expect(config.redis.host).toBe("localhost");
    expect(config.redis.port).toBe(6379);
    expect(config.rateLimiter.windowMs).toBe(60_000);
    expect(config.rateLimiter.maxRequests).toBe(100);
    expect(config.retry.maxAttempts).toBe(5);
    expect(config.retry.baseDelayMs).toBe(1_000);
    expect(config.retry.maxDelayMs).toBe(60_000);
    expect(config.soap.timeoutMs).toBe(10_000);
    expect(config.sql.timeoutMs).toBe(5_000);
    expect(config.sync.pollIntervalMs).toBe(30_000);
    expect(config.sync.batchSize).toBe(50);
  });

  it("overrides values from environment variables", async () => {
    process.env.PORT = "8080";
    process.env.NODE_ENV = "production";
    process.env.REDIS_HOST = "redis.example.com";
    process.env.REDIS_PORT = "6380";
    process.env.RATE_LIMIT_MAX_REQUESTS = "50";
    process.env.RETRY_MAX_ATTEMPTS = "10";
    process.env.LOG_PRETTY = "true";

    const { config } = await import("../src/config/index.js");

    expect(config.port).toBe(8080);
    expect(config.nodeEnv).toBe("production");
    expect(config.redis.host).toBe("redis.example.com");
    expect(config.redis.port).toBe(6380);
    expect(config.rateLimiter.maxRequests).toBe(50);
    expect(config.retry.maxAttempts).toBe(10);
    expect(config.log.prettyPrint).toBe(true);
  });
});
