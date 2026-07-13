import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import { maskSensitiveData } from "./validators.js";

// ─── Audit Event Types ───────────────────────────────────

export type AuditEventType =
  // Authentication events
  | "AUTH_SUCCESS"
  | "AUTH_FAILURE"
  | "TOKEN_REFRESH"
  | "API_KEY_CREATED"
  | "API_KEY_REVOKED"
  // Authorization events
  | "PERMISSION_DENIED"
  | "UNAUTHORIZED_ACCESS"
  // Data events
  | "SYNC_STARTED"
  | "SYNC_COMPLETED"
  | "SYNC_FAILED"
  | "DATA_EXPORTED"
  | "DATA_IMPORTED"
  // Security events
  | "RATE_LIMIT_EXCEEDED"
  | "SUSPICIOUS_ACTIVITY"
  | "CONFIG_CHANGED"
  | "ENCRYPTION_ERROR"
  // Admin events
  | "ADMIN_ACTION"
  | "USER_ROLE_CHANGED"
  | "SYSTEM_STARTUP"
  | "SYSTEM_SHUTDOWN";

// ─── Audit Log Entry ─────────────────────────────────────

export interface AuditEntry {
  id: string;
  timestamp: string;
  eventType: AuditEventType;
  severity: "info" | "warn" | "error" | "critical";
  message: string;
  details: Record<string, unknown>;
  source: string;
  correlationId?: string;
  userId?: string;
  ipAddress?: string;
}

// ─── Audit Logger ────────────────────────────────────────

class AuditLogger {
  private entries: AuditEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.maxEntries = maxEntries;
  }

  /**
   * Log a security audit event.
   */
  log(
    severity: AuditEntry["severity"],
    eventType: AuditEventType,
    message: string,
    details: Record<string, unknown> = {},
    context?: { userId?: string; ipAddress?: string; correlationId?: string },
  ): void {
    const entry: AuditEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
      timestamp: new Date().toISOString(),
      eventType,
      severity,
      message,
      details: maskSensitiveData(details),
      source: "api-bridge",
      ...context,
    };

    // Store in ring buffer
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries / 2);
    }

    // Also emit to application logger with appropriate level
    const logFn = severity === "critical" || severity === "error"
      ? logger.error
      : severity === "warn"
        ? logger.warn
        : logger.info;

    logFn(
      {
        auditEvent: eventType,
        severity,
        ...maskSensitiveData(details),
        userId: context?.userId,
        ip: context?.ipAddress,
      },
      `[AUDIT] ${eventType}: ${message}`,
    );
  }

  info(
    eventType: AuditEventType,
    details?: Record<string, unknown>,
    context?: { userId?: string; ipAddress?: string; correlationId?: string },
  ): void {
    this.log("info", eventType, eventType.replace(/_/g, " ").toLowerCase(), details, context);
  }

  warn(
    eventType: AuditEventType,
    details?: Record<string, unknown>,
    context?: { userId?: string; ipAddress?: string; correlationId?: string },
  ): void {
    this.log("warn", eventType, eventType.replace(/_/g, " ").toLowerCase(), details, context);
  }

  error(
    eventType: AuditEventType,
    details?: Record<string, unknown>,
    context?: { userId?: string; ipAddress?: string; correlationId?: string },
  ): void {
    this.log("error", eventType, eventType.replace(/_/g, " ").toLowerCase(), details, context);
  }

  critical(
    eventType: AuditEventType,
    details?: Record<string, unknown>,
    context?: { userId?: string; ipAddress?: string; correlationId?: string },
  ): void {
    this.log("critical", eventType, eventType.replace(/_/g, " ").toLowerCase(), details, context);
  }

  /**
   * Get recent audit entries.
   */
  getRecent(limit = 100, severity?: AuditEntry["severity"]): AuditEntry[] {
    let result = this.entries.slice(-limit);
    if (severity) {
      result = result.filter((e) => e.severity === severity);
    }
    return result.reverse();
  }

  /**
   * Get audit entries for a specific event type.
   */
  getByEventType(eventType: AuditEventType, limit = 50): AuditEntry[] {
    return this.entries
      .filter((e) => e.eventType === eventType)
      .slice(-limit)
      .reverse();
  }
}

export const auditLogger = new AuditLogger();
