export class BridgeError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp: string;

  constructor(
    message: string,
    code: string,
    statusCode = 500,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

export class RateLimitError extends BridgeError {
  constructor(message = "Rate limit exceeded", retryAfterMs?: number) {
    super(message, "RATE_LIMIT_EXCEEDED", 429, { retryAfterMs });
    this.name = "RateLimitError";
  }
}

export class UpstreamServiceError extends BridgeError {
  constructor(
    service: string,
    statusCode: number,
    body?: string,
  ) {
    super(
      `Upstream service "${service}" returned ${statusCode}`,
      "UPSTREAM_ERROR",
      statusCode,
      { service, body },
    );
    this.name = "UpstreamServiceError";
  }
}

export class SyncConflictError extends BridgeError {
  constructor(entity: string, id: string, cause: string) {
    super(
      `Sync conflict on ${entity} ${id}: ${cause}`,
      "SYNC_CONFLICT",
      409,
      { entity, id, cause },
    );
    this.name = "SyncConflictError";
  }
}

export class ConfigurationError extends BridgeError {
  constructor(message: string) {
    super(message, "CONFIGURATION_ERROR", 500);
    this.name = "ConfigurationError";
  }
}

// ─── Security Error Classes ──────────────────────────────

export class AuthenticationError extends BridgeError {
  constructor(message = "Authentication required") {
    super(message, "AUTHENTICATION_REQUIRED", 401);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends BridgeError {
  constructor(message = "Insufficient permissions", role?: string, requiredPermission?: string) {
    super(message, "FORBIDDEN", 403, { role, requiredPermission });
    this.name = "AuthorizationError";
  }
}

export class ValidationError extends BridgeError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", 400, details);
    this.name = "ValidationError";
  }
}

export class EncryptionError extends BridgeError {
  constructor(message = "Encryption operation failed") {
    super(message, "ENCRYPTION_ERROR", 500);
    this.name = "EncryptionError";
  }
}

export class RateLimitExceededError extends BridgeError {
  constructor(key: string, retryAfterMs: number) {
    super(`Rate limit exceeded for "${key}"`, "RATE_LIMIT_EXCEEDED", 429, {
      key,
      retryAfterMs,
    });
    this.name = "RateLimitExceededError";
  }
}
