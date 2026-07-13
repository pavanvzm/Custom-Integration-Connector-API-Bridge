import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { UpstreamServiceError } from "../utils/errors.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class RetryHandler {
  private redis: Redis;
  private maxAttempts: number;
  private baseDelayMs: number;
  private maxDelayMs: number;

  constructor(redis?: Redis, options?: RetryOptions) {
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
    this.maxAttempts = options?.maxAttempts ?? config.retry.maxAttempts;
    this.baseDelayMs = options?.baseDelayMs ?? config.retry.baseDelayMs;
    this.maxDelayMs = options?.maxDelayMs ?? config.retry.maxDelayMs;
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
   * Calculate delay for attempt number using exponential backoff + jitter.
   * Attempt 1 has no delay; attempt 2 = baseDelay; attempt 3 = baseDelay*2; etc.
   */
  private calculateDelay(attempt: number): number {
    if (attempt <= 1) return 0;
    const exponentialDelay = this.baseDelayMs * 2 ** (attempt - 2);
    const clamped = Math.min(exponentialDelay, this.maxDelayMs);
    // Add up to 25% jitter
    const jitter = clamped * 0.25 * Math.random();
    return Math.floor(clamped + jitter);
  }

  /**
   * Track retry state in Redis to persist across restarts.
   */
  private async getRetryState(operationId: string): Promise<{ attempt: number }> {
    const key = `retry:${operationId}`;
    const raw = await this.redis.get(key);
    if (raw) {
      return JSON.parse(raw) as { attempt: number };
    }
    return { attempt: 0 };
  }

  private async saveRetryState(operationId: string, state: { attempt: number }): Promise<void> {
    const key = `retry:${operationId}`;
    await this.redis.setex(key, 86_400, JSON.stringify(state)); // TTL 24h
  }

  private async clearRetryState(operationId: string): Promise<void> {
    await this.redis.del(`retry:${operationId}`);
  }

  /**
   * Wrap an async operation with exponential backoff retry logic.
   * Tracks retry state in Redis for durability.
   */
  async execute<T>(
    operation: () => Promise<T>,
    context: { operationName: string; entityId?: string },
  ): Promise<T> {
    const operationId = `${context.operationName}:${context.entityId ?? uuidv4()}`;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const result = await operation();
        // Success — clear retry state
        await this.clearRetryState(operationId).catch(() => {});
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry if we've exhausted attempts
        if (attempt >= this.maxAttempts) {
          logger.error(
            { err: lastError, operationName: context.operationName, attempt, maxAttempts: this.maxAttempts },
            "Retry attempts exhausted — operation failed permanently",
          );
          throw lastError;
        }

        // Don't retry non-retryable errors (4xx client errors except 429)
        if (err instanceof UpstreamServiceError && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
          logger.warn(
            { err, operationName: context.operationName, statusCode: err.statusCode },
            "Non-retryable client error — aborting retry",
          );
          throw err;
        }

        // Save retry state
        await this.saveRetryState(operationId, { attempt }).catch(() => {});

        const delay = this.calculateDelay(attempt);
        logger.info(
          {
            operationName: context.operationName,
            attempt,
            nextDelayMs: delay,
            errMessage: lastError.message,
          },
          `Retrying after ${delay}ms (attempt ${attempt}/${this.maxAttempts})`,
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError ?? new Error("Retry loop terminated unexpectedly");
  }
}
