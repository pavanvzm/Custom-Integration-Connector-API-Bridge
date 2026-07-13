import express from "express";
import helmet from "helmet";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config/index.js";
import { logger } from "../src/utils/logger.js";
import { auditLogger } from "../src/security/audit-logger.js";
import { AuthenticationError } from "../src/utils/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = config.port + 1; // Dashboard on port 4001 by default

// ─── Security Middleware ───────────────────────────────────

// Helmet — HTTP security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  hidePoweredBy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true },
  noSniff: true,
  xssFilter: true,
  frameguard: { action: "deny" },
}));

// CORS — restrict to configured origins
app.use(cors({
  origin: config.security.corsOrigins,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  maxAge: 86400,
}));

// Payload size limit
app.use(express.json({ limit: "1mb" }));

// ─── Dashboard Authentication ─────────────────────────────
function dashboardAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  // Skip auth for static assets in development
  if (!config.security.dashboardAuthEnabled && config.nodeEnv === "development") {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", "Basic realm=\"API Bridge Dashboard\"");
    res.status(401).json({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
    return;
  }

  try {
    const base64 = authHeader.slice(6);
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    const [username, password] = decoded.split(":");

    if (
      username === config.security.dashboardUsername &&
      password === config.security.dashboardPassword
    ) {
      auditLogger.info("AUTH_SUCCESS", {
        method: "basic_auth",
        userId: username,
        source: "dashboard",
      });
      return next();
    }

    auditLogger.warn("AUTH_FAILURE", {
      method: "basic_auth",
      userId: username,
      source: "dashboard",
      reason: "Invalid credentials",
    });

    res.setHeader("WWW-Authenticate", "Basic realm=\"API Bridge Dashboard\"");
    res.status(401).json({
      error: "Invalid credentials",
      code: "AUTH_FAILED",
    });
  } catch {
    res.status(400).json({ error: "Invalid authorization header", code: "BAD_REQUEST" });
  }
}

// ─── Audit logging middleware ─────────────────────────────
function auditMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    logger.debug({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - start,
      ip: req.ip,
    }, "Dashboard request");
  });
  next();
}

app.use(auditMiddleware);

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

const startTime = Date.now();

// ─── REST API Endpoints ───────────────────────────────────

// GET /api/metrics — full metrics snapshot (requires auth)
app.get("/api/metrics", dashboardAuth, (_req, res) => {
  metrics.timestamp = new Date().toISOString();
  metrics.uptime = Date.now() - startTime;
  res.json(metrics);
});

app.get("/api/metrics/sync", dashboardAuth, (_req, res) => {
  res.json(metrics.syncOperations);
});

app.get("/api/metrics/rate-limit", dashboardAuth, (_req, res) => {
  res.json(metrics.rateLimiter);
});

app.get("/api/metrics/errors", dashboardAuth, (_req, res) => {
  res.json(metrics.recentErrors);
});

app.get("/api/metrics/health", (_req, res) => {
  res.json({
    status: "healthy",
    uptime: Date.now() - startTime,
    adapterStatus: metrics.adapterStatus,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/metrics/adapters", dashboardAuth, (_req, res) => {
  res.json(metrics.adapterStatus);
});

app.post("/api/metrics/sync/record", dashboardAuth, express.json(), (req, res) => {
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
    if (metrics.recentErrors.length > 50) {
      metrics.recentErrors.pop();
    }
  }

  res.json({ ok: true });
});

// ─── Dashboard page (auth-protected) ─────────────────────
app.get("/", dashboardAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start server ─────────────────────────────────────────
async function startDashboard(): Promise<void> {
  auditLogger.info("SYSTEM_STARTUP", { component: "dashboard", port: PORT });

  try {
    const { RateLimiter } = await import("../src/middleware/rate-limiter.js");
    const rateLimiter = new RateLimiter();
    await rateLimiter.connect();
    metrics.adapterStatus.redis = "connected";
    logger.info("Dashboard connected to Redis");
  } catch {
    metrics.adapterStatus.redis = "disconnected";
    logger.warn("Dashboard could not connect to Redis");
  }

  metrics.adapterStatus.soap = "connected";
  metrics.adapterStatus.sql = "connected";

  app.listen(PORT, () => {
    logger.info({ port: PORT }, `Dashboard server running on http://localhost:${PORT}`);
  });
}

process.on("SIGINT", () => {
  auditLogger.info("SYSTEM_SHUTDOWN", { component: "dashboard" });
  process.exit(0);
});

process.on("SIGTERM", () => {
  auditLogger.info("SYSTEM_SHUTDOWN", { component: "dashboard" });
  process.exit(0);
});

startDashboard().catch((err) => {
  logger.fatal({ err }, "Failed to start dashboard server");
  process.exit(1);
});
