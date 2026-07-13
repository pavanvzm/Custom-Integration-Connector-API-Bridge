import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Redis from "ioredis";
import { RetryHandler } from "../src/middleware/retry.js";
import { UpstreamServiceError } from "../src/utils/errors.js";

function createMockRedis(): Partial<Redis> {
  const store = new Map<string, string>();
  return {
    status: "ready" as any,
    connect: vi.fn().mockResolvedValue(undefined),
    quit: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  };
}

describe("RetryHandler", () => {
  let handler: RetryHandler;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    mockRedis = createMockRedis();
    handler = new RetryHandler(mockRedis as unknown as Redis, {
      maxAttempts: 3,
      baseDelayMs: 10, // Fast for tests
      maxDelayMs: 100,
    });
    await handler.connect();
  });

  afterEach(async () => {
    await handler.disconnect();
  });

  describe("execute", () => {
    it("succeeds on first attempt when operation succeeds", async () => {
      const op = vi.fn().mockResolvedValue("success");
      const result = await handler.execute(op, {
        operationName: "test",
      });
      expect(result).toBe("success");
      expect(op).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and eventually succeeds", async () => {
      const op = vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValue("success");

      const result = await handler.execute(op, {
        operationName: "test-retry",
      });
      expect(result).toBe("success");
      expect(op).toHaveBeenCalledTimes(3);
    });

    it("fails after exhausting all retry attempts", async () => {
      const op = vi.fn().mockRejectedValue(new Error("persistent failure"));

      await expect(
        handler.execute(op, { operationName: "test-fail" }),
      ).rejects.toThrow("persistent failure");
      expect(op).toHaveBeenCalledTimes(3); // maxAttempts = 3
    });

    it("does not retry non-retryable client errors (4xx)", async () => {
      const op = vi.fn().mockRejectedValue(
        new UpstreamServiceError("TEST", 400, "Bad request"),
      );

      await expect(
        handler.execute(op, { operationName: "test-4xx" }),
      ).rejects.toThrow(UpstreamServiceError);
      expect(op).toHaveBeenCalledTimes(1); // No retry
    });

    it("retries on 429 rate limit errors", async () => {
      const op = vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamServiceError("TEST", 429, "Too many requests"),
        )
        .mockResolvedValue("success");

      const result = await handler.execute(op, {
        operationName: "test-429",
      });
      expect(result).toBe("success");
      expect(op).toHaveBeenCalledTimes(2);
    });

    it("retries on 5xx server errors", async () => {
      const op = vi
        .fn()
        .mockRejectedValueOnce(
          new UpstreamServiceError("TEST", 503, "Service unavailable"),
        )
        .mockResolvedValue("success");

      const result = await handler.execute(op, {
        operationName: "test-5xx",
      });
      expect(result).toBe("success");
      expect(op).toHaveBeenCalledTimes(2);
    });

    it("clears retry state on success", async () => {
      const op = vi.fn().mockResolvedValue("ok");
      await handler.execute(op, {
        operationName: "test-clear",
        entityId: "entity-1",
      });
      // Redis del should have been called for the success
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });
});
