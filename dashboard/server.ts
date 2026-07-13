import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config/index.js";
import { logger } from "../src/utils/logger.js";
import { RateLimiter } from "../src/middleware/rate-limiter.js";
import { RetryHandler } from "../src/middleware/retry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = config.port + 1; // Dashboard on port 4001 by default

// ─── Static files ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── In-memory metrics collector ──────────────────────────
interface MetricsSnapshot {
  timestamp: string;
  uptime: number;
  syncOperations: {
    total: number;
    success: number;
    failed: number;
    byDirection: Record<string, number>;
  };
  rateLimiter: {
    keys: Record<string, { allowed: boolean; remaining: number }>;
  };
  retryStats: {
    totalRetries: number;
    activeOperations: number;
  };
  recentErrors: Array<{
    timestamp: string;
    operation: string;
    error: string;
  }>;
  adapterStatus: {
    soap: "connected" | "disconnected" | "error";
    sql: "connected" | "disconnected" | "error";
    redis: "connected" | "disconnected" | "error";
  };
}

const metrics: MetricsSnapshot = {
  timestamp: new Date().toISOString(),
  uptime: 0,
  syncOperations: {
    total: 0,
    success: 0,
    failed: 0,
    byDirection: {},
  },
  rateLimiter: {
    keys: {},
  },
  retryStats: {
    totalRetries: 0,
    activeOperations: 0,
  },
  recentErrors: [],
  adapterStatus: {
    soap: "disconnected",
    sql: "disconnected",
    redis: "disconnected",
  },
};

// ─── Start time ───────────────────────────────────────────
const startTime = Date.now();

// ─── REST API Endpoints ───────────────────────────────────

// GET /api/metrics — full metrics snapshot
app.get("/api/metrics", (_req, res) => {
  metrics.timestamp = new Date().toISOString();
  metrics.uptime = Date.now() - startTime;
  res.json(metrics);
});

// GET /api/metrics/sync — sync operation stats
app.get("/api/metrics/sync", (_req, res) => {
  res.json(metrics.syncOperations);
});

// GET /api/metrics/rate-limit — rate limiter stats
app.get("/api/metrics/rate-limit", (_req, res) => {
  res.json(metrics.rateLimiter);
});

// GET /api/metrics/errors — recent errors
app.get("/api/metrics/errors", (_req, res) => {
  res.json(metrics.recentErrors);
});

// GET /api/metrics/health — health check
app.get("/api/metrics/health", (_req, res) => {
  res.json({
    status: "healthy",
    uptime: Date.now() - startTime,
    adapterStatus: metrics.adapterStatus,
    timestamp: new Date().toISOString(),
  });
});

// GET /api/metrics/adapters — adapter status
app.get("/api/metrics/adapters", (_req, res) => {
  res.json(metrics.adapterStatus);
});

// POST /api/metrics/sync/record — record a sync operation (called from main server)
app.post("/api/metrics/sync/record", express.json(), (req, res) => {
  const { direction, success, error } = req.body;

  metrics.syncOperations.total++;
  if (success) {
    metrics.syncOperations.success++;
  } else {
    metrics.syncOperations.failed++;
  }

  if (direction) {
    metrics.syncOperations.byDirection[direction] =
      (metrics.syncOperations.byDirection[direction] ?? 0) + 1;
  }

  if (error) {
    metrics.recentErrors.unshift({
      timestamp: new Date().toISOString(),
      operation: direction ?? "unknown",
      error,
    });
    // Keep last 50 errors
    if (metrics.recentErrors.length > 50) {
      metrics.recentErrors.pop();
    }
  }

  res.json({ ok: true });
});

// ─── Start server ─────────────────────────────────────────
async function startDashboard(): Promise<void> {
  // Try to connect Redis to check status
  let rateLimiter: RateLimiter | null = null;
  let retryHandler: RetryHandler | null = null;

  try {
    rateLimiter = new RateLimiter();
    await rateLimiter.connect();
    metrics.adapterStatus.redis = "connected";
    logger.info("Dashboard connected to Redis");
  } catch {
    metrics.adapterStatus.redis = "disconnected";
    logger.warn("Dashboard could not connect to Redis — rate limit metrics unavailable");
  }

  // Simulate adapter connection checks
  metrics.adapterStatus.soap = "connected";
  metrics.adapterStatus.sql = "connected";

  app.listen(PORT, () => {
    logger.info({ port: PORT }, `Dashboard server running on http://localhost:${PORT}`);
    logger.info({ apiEndpoint: `http://localhost:${PORT}/api/metrics` }, "Dashboard API");
  });
}

// ─── Graceful shutdown ────────────────────────────────────
process.on("SIGINT", () => {
  logger.info("Dashboard shutting down");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Dashboard shutting down");
  process.exit(0);
});

startDashboard().catch((err) => {
  logger.fatal({ err }, "Failed to start dashboard server");
  process.exit(1);
});
