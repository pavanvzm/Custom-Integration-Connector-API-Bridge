import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import { RateLimiter } from "../src/middleware/rate-limiter.js";
import { RateLimitError } from "../src/utils/errors.js";

// Helper: create a mock Redis
function createMockRedis(): Partial<Redis> {
  const store = new Map<string, string>();
  return {
    status: "ready" as any,
    multi: vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([
        [null, 0],
        [null, 1],
        [null, 3],
        [null, 1],
      ]),
    })),
    pttl: vi.fn().mockResolvedValue(30000),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
  };
}

describe("RateLimiter", () => {
  let limiter: RateLimiter;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    limiter = new RateLimiter(mockRedis as unknown as Redis);
    await limiter.connect();
  });

  afterEach(async () => {
    await limiter.disconnect();
  });

  describe("check", () => {
    it("returns allowed=true when under limit", async () => {
      const result = await limiter.check("test:key");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
      expect(result.resetAt).toBeGreaterThan(Date.now());
    });

    it("returns allowed=false when over limit", async () => {
      // Mock exec to return count > maxRequests
      const overLimitMock = {
        ...mockRedis,
        multi: vi.fn(() => ({
          zremrangebyscore: vi.fn().mockReturnThis(),
          zadd: vi.fn().mockReturnThis(),
          zcard: vi.fn().mockReturnThis(),
          expire: vi.fn().mockReturnThis(),
          exec: vi.fn().mockResolvedValue([
            [null, 0],
            [null, 1],
            [null, 150], // Over limit
            [null, 1],
          ]),
        })),
      };

      const overLimiter = new RateLimiter(overLimitMock as unknown as Redis);
      const result = await overLimiter.check("test:over");
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("fails open when Redis errors", async () => {
      const errorMock = {
        ...mockRedis,
        multi: vi.fn(() => ({
          zremrangebyscore: vi.fn().mockReturnThis(),
          zadd: vi.fn().mockReturnThis(),
          zcard: vi.fn().mockReturnThis(),
          expire: vi.fn().mockReturnThis(),
          exec: vi.fn().mockRejectedValue(new Error("Redis down")),
        })),
      };

      const failOpen = new RateLimiter(errorMock as unknown as Redis);
      const result = await failOpen.check("test:failopen");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });
  });

  describe("assertAllowed", () => {
    it("does not throw when under limit", async () => {
      await expect(
        limiter.assertAllowed("test:safe"),
      ).resolves.toBeUndefined();
    });

    it("throws RateLimitError when over limit", async () => {
      const overLimitMock = {
        ...mockRedis,
        multi: vi.fn(() => ({
          zremrangebyscore: vi.fn().mockReturnThis(),
          zadd: vi.fn().mockReturnThis(),
          zcard: vi.fn().mockReturnThis(),
          expire: vi.fn().mockReturnThis(),
          exec: vi.fn().mockResolvedValue([
            [null, 0],
            [null, 1],
            [null, 150],
            [null, 1],
          ]),
        })),
      };

      const overLimiter = new RateLimiter(overLimitMock as unknown as Redis);
      await expect(
        overLimiter.assertAllowed("test:over"),
      ).rejects.toThrow(RateLimitError);
    });
  });
});
