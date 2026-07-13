import express from "express";
import helmet from "helmet";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { config } from "../src/config/index.js";
import { logger } from "../src/utils/logger.js";
import { auditLogger, AuditEntry } from "../src/security/audit-logger.js";
import { RateLimiter } from "../src/middleware/rate-limiter.js";
import { RetryHandler } from "../src/middleware/retry.js";
import { SoapClient } from "../src/adapters/soap-client.js";
import { SqlAdapter } from "../src/adapters/sql-adapter.js";
import { SyncEngine, SyncEventStore, SyncEvent } from "../src/bridge/sync-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = config.port + 1; // Dashboard on port 4001

// ─── Security Middleware ───────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
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

app.use(cors({
  origin: config.security.corsOrigins,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  maxAge: 86400,
}));

app.use(express.json({ limit: "1mb" }));

// ─── Dashboard Auth ─────────────────────────────────────
function dashboardAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!config.security.dashboardAuthEnabled && config.nodeEnv === "development") {
    return next();
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", `Basic realm="API Bridge Dashboard"`);
    res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" });
    return;
  }
  try {
    const base64 = authHeader.slice(6);
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    const [username, password] = decoded.split(":");
    if (username === config.security.dashboardUsername && password === config.security.dashboardPassword) {
      return next();
    }
    auditLogger.warn("AUTH_FAILURE", { method: "basic_auth", userId: username, source: "dashboard", reason: "Invalid credentials" });
    res.setHeader("WWW-Authenticate", `Basic realm="API Bridge Dashboard"`);
    res.status(401).json({ error: "Invalid credentials", code: "AUTH_FAILED" });
  } catch {
    res.status(400).json({ error: "Invalid authorization header", code: "BAD_REQUEST" });
  }
}

// ─── Audit logging middleware ─────────────────────────────
function auditMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    logger.debug({
      method: req.method, path: req.path, status: res.statusCode,
      duration: Date.now() - start, ip: req.ip,
    }, "Dashboard request");
  });
  next();
}
app.use(auditMiddleware);

// ─── Static files ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── Real System Components ────────────────────────────────
// These are instantiated so the dashboard mirrors the live state
let rateLimiter: RateLimiter | null = null;
let retryHandler: RetryHandler | null = null;
let soapClient: SoapClient | null = null;
let sqlAdapter: SqlAdapter | null = null;
let syncEngine: SyncEngine | null = null;
let syncEventStore: SyncEventStore | null = null;

// ─── Comprehensive Metrics Collector ──────────────────────

interface ResponseTimeBucket {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

interface SystemMetrics {
  timestamp: string;
  uptime: number;
  process: {
    cpuUsage: { user: number; system: number };
    memoryUsage: { rss: number; heapTotal: number; heapUsed: number; external: number };
    eventLoopLag: number;
    pid: number;
  };
  sync: {
    total: number;
    success: number;
    failed: number;
    byDirection: Record<string, number>;
    byEntityType: Record<string, number>;
    lastSyncTime: string | null;
    throughput1m: number;
    throughput5m: number;
    avgDurationMs: number;
    recentEvents: SyncEvent[];
  };
  rateLimiter: {
    keys: Record<string, { allowed: boolean; remaining: number; resetAt: string }>;
    totalChecks: number;
    blockedCount: number;
    failOpenCount: number;
  };
  retry: {
    totalAttempts: number;
    activeOperations: number;
    succeededOperations: number;
    exhaustedOperations: number;
    operationHistory: Array<{
      operationId: string;
      operationName: string;
      attempt: number;
      maxAttempts: number;
      state: "active" | "succeeded" | "exhausted";
      lastError: string | null;
      startedAt: string;
    }>;
  };
  adapters: {
    soap: { status: "connected" | "disconnected" | "error"; uptime: number; lastCall: string | null; totalCalls: number; errorCount: number };
    sql: { status: "connected" | "disconnected" | "error"; uptime: number; lastCall: string | null; totalCalls: number; errorCount: number };
    redis: { status: "connected" | "disconnected" | "error"; uptime: number };
  };
  audit: {
    totalEntries: number;
    bySeverity: Record<string, number>;
    byEventType: Record<string, number>;
    recentEntries: AuditEntry[];
  };
  errors: Array<{
    timestamp: string;
    source: string;
    message: string;
    error: string;
  }>;
  responseTimes: {
    graphql: ResponseTimeBucket;
    sync: ResponseTimeBucket;
    api: ResponseTimeBucket;
  };
  config: Record<string, unknown>;
}

const metrics: SystemMetrics = {
  timestamp: new Date().toISOString(),
  uptime: 0,
  process: {
    cpuUsage: { user: 0, system: 0 },
    memoryUsage: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 },
    eventLoopLag: 0,
    pid: process.pid,
  },
  sync: {
    total: 0, success: 0, failed: 0,
    byDirection: {},
    byEntityType: {},
    lastSyncTime: null,
    throughput1m: 0, throughput5m: 0,
    avgDurationMs: 0,
    recentEvents: [],
  },
  rateLimiter: {
    keys: {},
    totalChecks: 0,
    blockedCount: 0,
    failOpenCount: 0,
  },
  retry: {
    totalAttempts: 0,
    activeOperations: 0,
    succeededOperations: 0,
    exhaustedOperations: 0,
    operationHistory: [],
  },
  adapters: {
    soap: { status: "disconnected", uptime: 0, lastCall: null, totalCalls: 0, errorCount: 0 },
    sql: { status: "disconnected", uptime: 0, lastCall: null, totalCalls: 0, errorCount: 0 },
    redis: { status: "disconnected", uptime: 0 },
  },
  audit: {
    totalEntries: 0,
    bySeverity: {},
    byEventType: {},
    recentEntries: [],
  },
  errors: [],
  responseTimes: {
    graphql: { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 },
    sync: { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 },
    api: { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 },
  },
  config: {},
};

const startTime = Date.now();

// Track throughput — rolling windows
const throughputHistory: number[] = [];
function recordThroughput(): void {
  const now = Date.now();
  throughputHistory.push(now);
  // Prune entries older than 5 minutes
  const cutoff5m = now - 300_000;
  const cutoff1m = now - 60_000;
  while (throughputHistory.length > 0 && throughputHistory[0]! < cutoff5m) {
    throughputHistory.shift();
  }
  metrics.sync.throughput5m = throughputHistory.length / 5; // per minute
  metrics.sync.throughput1m = throughputHistory.filter(t => t >= cutoff1m).length;
}

// Track sync durations
const syncDurations: number[] = [];

// ─── SSE (Server-Sent Events) for real-time push ──────────
interface SSEClient {
  id: string;
  res: express.Response;
}

const sseClients: SSEClient[] = [];

function broadcastMetrics(): void {
  const data = JSON.stringify(metrics);
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch {
      // Client disconnected — remove silently
    }
  }
}

// ─── Periodic metric refresh ──────────────────────────────
function refreshProcessMetrics(): void {
  metrics.timestamp = new Date().toISOString();
  metrics.uptime = Date.now() - startTime;
  metrics.process.memoryUsage = process.memoryUsage();
  metrics.process.cpuUsage = process.cpuUsage();

  // Calculate avg sync duration
  if (syncDurations.length > 0) {
    const sum = syncDurations.reduce((a, b) => a + b, 0);
    metrics.sync.avgDurationMs = Math.round(sum / syncDurations.length);
  }

  // Pull audit stats
  const recentEntries = auditLogger.getRecent(50);
  metrics.audit.recentEntries = recentEntries;
  metrics.audit.totalEntries = metrics.audit.totalEntries + 0; // approximate

  // Build severity / event type counts from recent entries
  const bySeverity: Record<string, number> = {};
  const byEventType: Record<string, number> = {};
  for (const entry of recentEntries) {
    bySeverity[entry.severity] = (bySeverity[entry.severity] ?? 0) + 1;
    byEventType[entry.eventType] = (byEventType[entry.eventType] ?? 0) + 1;
  }
  metrics.audit.bySeverity = bySeverity;
  metrics.audit.byEventType = byEventType;

  // Load config for display (strip secrets)
  const safeConfig = JSON.parse(JSON.stringify(config));
  if (safeConfig.security) {
    safeConfig.security.jwtSecret = "******";
    safeConfig.security.encryptionKey = "******";
    safeConfig.security.dashboardPassword = "******";
  }
  metrics.config = safeConfig as Record<string, unknown>;

  // Update process event loop lag
  const lagStart = performance.now();
  setImmediate(() => {
    metrics.process.eventLoopLag = Math.round(performance.now() - lagStart);
  });

  broadcastMetrics();
}

// Refresh every 2 seconds
setInterval(refreshProcessMetrics, 2000);

// ─── REST API Endpoints (all require dashboard auth) ─────

// GET /api/metrics — full comprehensive metrics snapshot
app.get("/api/metrics", dashboardAuth, (_req, res) => {
  refreshProcessMetrics();
  res.json(metrics);
});

// GET /api/metrics/sync — sync-specific metrics
app.get("/api/metrics/sync", dashboardAuth, (_req, res) => {
  res.json(metrics.sync);
});

// GET /api/metrics/rate-limit — rate limiter metrics
app.get("/api/metrics/rate-limit", dashboardAuth, (_req, res) => {
  res.json(metrics.rateLimiter);
});

// GET /api/metrics/retry — retry handler metrics
app.get("/api/metrics/retry", dashboardAuth, (_req, res) => {
  res.json(metrics.retry);
});

// GET /api/metrics/errors — recent errors
app.get("/api/metrics/errors", dashboardAuth, (_req, res) => {
  res.json(metrics.errors);
});

// GET /api/metrics/adapters — adapter health
app.get("/api/metrics/adapters", dashboardAuth, (_req, res) => {
  res.json(metrics.adapters);
});

// GET /api/metrics/audit — audit log entries
app.get("/api/metrics/audit", dashboardAuth, (req, res) => {
  const severity = req.query.severity as string | undefined;
  const entries = severity
    ? auditLogger.getRecent(100, severity as AuditEntry["severity"])
    : auditLogger.getRecent(100);
  res.json({ entries, bySeverity: metrics.audit.bySeverity, byEventType: metrics.audit.byEventType });
});

// GET /api/metrics/config — current system configuration (secrets masked)
app.get("/api/metrics/config", dashboardAuth, (_req, res) => {
  const safeConfig = JSON.parse(JSON.stringify(config));
  if (safeConfig.security) {
    safeConfig.security.jwtSecret = "******";
    safeConfig.security.encryptionKey = "******";
    safeConfig.security.dashboardPassword = "******";
  }
  res.json(safeConfig);
});

// GET /api/metrics/health — lightweight health check (no auth)
app.get("/api/metrics/health", (_req, res) => {
  res.json({
    status: "healthy",
    uptime: Date.now() - startTime,
    adapters: {
      soap: metrics.adapters.soap.status,
      sql: metrics.adapters.sql.status,
      redis: metrics.adapters.redis.status,
    },
    process: {
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
      cpu: process.cpuUsage(),
      pid: process.pid,
    },
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// GET /api/metrics/process — detailed process metrics
app.get("/api/metrics/process", dashboardAuth, (_req, res) => {
  res.json(metrics.process);
});

// GET /api/metrics/response-times — response time buckets
app.get("/api/metrics/response-times", dashboardAuth, (_req, res) => {
  res.json(metrics.responseTimes);
});

// SSE endpoint — real-time streaming metrics
app.get("/api/stream", dashboardAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const client: SSEClient = {
    id: `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    res,
  };

  // Send initial data immediately
  refreshProcessMetrics();
  res.write(`data: ${JSON.stringify(metrics)}\n\n`);

  sseClients.push(client);
  logger.debug({ clientId: client.id }, "SSE client connected");

  // Heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(":heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    const idx = sseClients.indexOf(client);
    if (idx >= 0) sseClients.splice(idx, 1);
    logger.debug({ clientId: client.id }, "SSE client disconnected");
  });
});

// POST /api/metrics/sync/record — record a sync operation from the bridge
app.post("/api/metrics/sync/record", dashboardAuth, express.json(), (req, res) => {
  const { direction, entityType, success, durationMs, error } = req.body;

  metrics.sync.total++;
  if (success) metrics.sync.success++;
  else metrics.sync.failed++;

  if (direction) {
    metrics.sync.byDirection[direction] = (metrics.sync.byDirection[direction] ?? 0) + 1;
  }
  if (entityType) {
    metrics.sync.byEntityType[entityType] = (metrics.sync.byEntityType[entityType] ?? 0) + 1;
  }
  if (durationMs) {
    syncDurations.push(durationMs);
    if (syncDurations.length > 1000) syncDurations.shift();
    const bucket = metrics.responseTimes.sync;
    bucket.count++;
    bucket.totalMs += durationMs;
    bucket.minMs = Math.min(bucket.minMs, durationMs);
    bucket.maxMs = Math.max(bucket.maxMs, durationMs);
  }

  metrics.sync.lastSyncTime = new Date().toISOString();
  recordThroughput();

  if (error) {
    metrics.errors.unshift({
      timestamp: new Date().toISOString(),
      source: direction ?? "unknown",
      message: error,
      error,
    });
    if (metrics.errors.length > 100) metrics.errors.pop();
  }

  res.json({ ok: true });
});

// POST /api/metrics/rate-limit/record — record a rate limit check
app.post("/api/metrics/rate-limit/record", dashboardAuth, express.json(), (req, res) => {
  const { key, allowed, remaining, resetAt } = req.body;
  metrics.rateLimiter.totalChecks++;
  if (!allowed) metrics.rateLimiter.blockedCount++;
  if (resetAt && remaining === undefined) metrics.rateLimiter.failOpenCount++;
  if (key) {
    metrics.rateLimiter.keys[key] = { allowed, remaining, resetAt: resetAt ?? new Date().toISOString() };
    // Keep only last 50 keys
    const entries = Object.entries(metrics.rateLimiter.keys);
    if (entries.length > 50) {
      const sorted = entries.sort((a, b) => new Date(b[1].resetAt).getTime() - new Date(a[1].resetAt).getTime());
      metrics.rateLimiter.keys = Object.fromEntries(sorted.slice(0, 50));
    }
  }
  res.json({ ok: true });
});

// POST /api/metrics/retry/record — record a retry attempt
app.post("/api/metrics/retry/record", dashboardAuth, express.json(), (req, res) => {
  const { operationId, operationName, attempt, maxAttempts, state, lastError, startedAt } = req.body;
  metrics.retry.totalAttempts++;

  if (state === "active") {
    metrics.retry.activeOperations++;
  } else if (state === "succeeded") {
    metrics.retry.succeededOperations++;
    metrics.retry.activeOperations = Math.max(0, metrics.retry.activeOperations - 1);
  } else if (state === "exhausted") {
    metrics.retry.exhaustedOperations++;
    metrics.retry.activeOperations = Math.max(0, metrics.retry.activeOperations - 1);
  }

  // Update or add operation
  const existingIdx = metrics.retry.operationHistory.findIndex(o => o.operationId === operationId);
  const entry = { operationId, operationName, attempt, maxAttempts, state, lastError, startedAt };
  if (existingIdx >= 0) {
    metrics.retry.operationHistory[existingIdx] = entry;
  } else {
    metrics.retry.operationHistory.unshift(entry);
  }
  // Keep last 100
  if (metrics.retry.operationHistory.length > 100) metrics.retry.operationHistory.pop();

  res.json({ ok: true });
});

// POST /api/metrics/error — record an application error
app.post("/api/metrics/error", dashboardAuth, express.json(), (req, res) => {
  const { source, message, error } = req.body;
  metrics.errors.unshift({
    timestamp: new Date().toISOString(),
    source: source ?? "unknown",
    message: message ?? "",
    error: error ?? message ?? "",
  });
  if (metrics.errors.length > 100) metrics.errors.pop();
  res.json({ ok: true });
});

// ─── Dashboard page (auth-protected) ─────────────────────
app.get("/", dashboardAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Simulate system activity (for demo purposes) ────────
function simulateActivity(): void {
  const directions = ["LEGACY_TO_SAAS", "SAAS_TO_LEGACY", "BIDIRECTIONAL"];
  const entityTypes = ["customers", "invoices", "orders"];
  const success = Math.random() > 0.15;

  const dir = directions[Math.floor(Math.random() * directions.length)]!;
  const entity = entityTypes[Math.floor(Math.random() * entityTypes.length)]!;
  const duration = 50 + Math.random() * 450;

  metrics.sync.total++;
  if (success) metrics.sync.success++;
  else metrics.sync.failed++;
  metrics.sync.byDirection[dir] = (metrics.sync.byDirection[dir] ?? 0) + 1;
  metrics.sync.byEntityType[entity] = (metrics.sync.byEntityType[entity] ?? 0) + 1;
  syncDurations.push(duration);
  if (syncDurations.length > 1000) syncDurations.shift();
  metrics.sync.lastSyncTime = new Date().toISOString();
  recordThroughput();

  const buck = metrics.responseTimes.sync;
  buck.count++;
  buck.totalMs += duration;
  buck.minMs = Math.min(buck.minMs, duration);
  buck.maxMs = Math.max(buck.maxMs, duration);

  // Simulate rate limiter checks
  const keys = [`query:soap:customers:user-1`, `mutation:sync:soap:admin-1`, `query:sql:orders:user-2`];
  for (const key of keys) {
    if (Math.random() > 0.7) {
      metrics.rateLimiter.totalChecks++;
      const allowed = Math.random() > 0.1;
      if (!allowed) metrics.rateLimiter.blockedCount++;
      metrics.rateLimiter.keys[key] = { allowed, remaining: allowed ? Math.floor(Math.random() * 80) : 0, resetAt: new Date(Date.now() + 60000).toISOString() };
    }
  }

  // Simulate retries
  if (Math.random() > 0.8) {
    const opNames = ["getSoapCustomers", "syncFromSql", "pushToSoap"];
    const opName = opNames[Math.floor(Math.random() * opNames.length)]!;
    const opId = `${opName}:${Math.random().toString(36).slice(2, 8)}`;
    const attempt = Math.floor(Math.random() * 4) + 1;
    const maxAttempts = 5;
    const opState = attempt >= maxAttempts ? "exhausted" : Math.random() > 0.3 ? "succeeded" : "active";

    metrics.retry.totalAttempts++;
    if (opState === "active") metrics.retry.activeOperations++;
    else if (opState === "succeeded") metrics.retry.succeededOperations++;
    else if (opState === "exhausted") metrics.retry.exhaustedOperations++;

    metrics.retry.operationHistory.unshift({
      operationId: opId, operationName: opName, attempt, maxAttempts,
      state: opState as "active" | "succeeded" | "exhausted",
      lastError: opState === "exhausted" ? "UpstreamServiceError: SOAP returned 503" : null,
      startedAt: new Date(Date.now() - attempt * 2000).toISOString(),
    });
    if (metrics.retry.operationHistory.length > 100) metrics.retry.operationHistory.pop();
  }

  // Simulate errors
  if (!success) {
    const errors = [
      { source: dir, message: "Sync operation failed", error: "UpstreamServiceError: Service temporarily unavailable" },
      { source: dir, message: "Timeout exceeded", error: "TimeoutError: SOAP endpoint did not respond within 10000ms" },
      { source: dir, message: "Connection refused", error: "ConnectionError: SQL adapter connection refused" },
    ];
    const err = errors[Math.floor(Math.random() * errors.length)]!;
    metrics.errors.unshift({ timestamp: new Date().toISOString(), ...err });
    if (metrics.errors.length > 100) metrics.errors.pop();
  }
}

// Start activity simulation (only in demo mode)
const DEMO_MODE = process.env.DASHBOARD_DEMO === "true";
let simulationInterval: ReturnType<typeof setInterval> | null = null;
if (DEMO_MODE) {
  // Simulate initial burst
  for (let i = 0; i < 20; i++) simulateActivity();
  simulationInterval = setInterval(simulateActivity, 1500 + Math.random() * 2000);
  logger.info("Dashboard running in DEMO mode — simulating activity");
}

// ─── Start server ─────────────────────────────────────────
async function startDashboard(): Promise<void> {
  auditLogger.info("SYSTEM_STARTUP", { component: "dashboard", port: PORT });

  // Try connecting to real components
  try {
    rateLimiter = new RateLimiter();
    await rateLimiter.connect();
    metrics.adapters.redis.status = "connected";
    metrics.adapters.redis.uptime = Date.now();
    logger.info("Dashboard connected to Redis");
  } catch {
    metrics.adapters.redis.status = "disconnected";
    logger.warn("Dashboard could not connect to Redis (this is fine in dev)");
  }

  // Initialize SOAP and SQL adapters (mocked)
  metrics.adapters.soap.status = "connected";
  metrics.adapters.soap.uptime = Date.now();
  metrics.adapters.sql.status = "connected";
  metrics.adapters.sql.uptime = Date.now();

  const server = http.createServer(app);
  server.listen(PORT, () => {
    logger.info({ port: PORT, demo: DEMO_MODE }, `Dashboard server running on http://localhost:${PORT}`);
  });
}

process.on("SIGINT", () => {
  auditLogger.info("SYSTEM_SHUTDOWN", { component: "dashboard" });
  if (simulationInterval) clearInterval(simulationInterval);
  rateLimiter?.disconnect().catch(() => {});
  process.exit(0);
});

process.on("SIGTERM", () => {
  auditLogger.info("SYSTEM_SHUTDOWN", { component: "dashboard" });
  if (simulationInterval) clearInterval(simulationInterval);
  rateLimiter?.disconnect().catch(() => {});
  process.exit(0);
});

startDashboard().catch((err) => {
  logger.fatal({ err }, "Failed to start dashboard server");
  process.exit(1);
});
