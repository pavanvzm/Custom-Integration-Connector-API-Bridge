import { z } from "zod";

// ─── SOAP Operation Schemas ───────────────────────────────

export const soapCustomerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(255).trim(),
  email: z.string().email().max(255).trim().toLowerCase(),
  accountNumber: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const soapInvoiceSchema = z.object({
  id: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  amount: z.number().positive().max(999_999_999),
  currency: z.string().length(3).toUpperCase(),
  status: z.enum(["pending", "paid", "overdue"] as const),
  issuedAt: z.string().datetime(),
});

export const soapCustomerUpsertSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(255).trim(),
  email: z.string().email().max(255).trim().toLowerCase(),
  accountNumber: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
});

// ─── SQL Operation Schemas ────────────────────────────────

export const sqlQuerySchema = z.object({
  tableName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Invalid table name")
    .trim(),
  since: z.string().datetime().optional(),
});

export const sqlUpsertSchema = z.object({
  tableName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Invalid table name")
    .trim(),
  id: z.string().min(1).max(128),
  data: z.record(z.string(), z.unknown()),
});

// ─── Sync Operation Schemas ───────────────────────────────

export const syncFromSoapSchema = z.object({
  entityType: z.enum(["customers", "invoices"] as const),
  since: z.string().datetime().optional(),
});

export const syncFromSqlSchema = z.object({
  tableName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Invalid table name")
    .trim(),
  since: z.string().datetime().optional(),
});

export const pushToSoapSchema = z.object({
  customerId: z.string().min(1).max(64),
  data: z.record(z.string(), z.unknown()),
});

export const pushToSqlSchema = z.object({
  tableName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Invalid table name")
    .trim(),
  id: z.string().min(1).max(128),
  data: z.record(z.string(), z.unknown()),
});

export const bidirectionalSyncSchema = z.object({
  entityType: z.enum(["customers", "invoices", "orders"] as const),
  entityId: z.string().min(1).max(128),
});

// ─── Auth Schemas ─────────────────────────────────────────

export const loginSchema = z.object({
  apiKey: z.string().min(8).max(256),
});

export const createApiKeySchema = z.object({
  label: z.string().min(1).max(128).trim(),
  role: z.enum(["admin", "operator", "readonly"] as const),
});

// ─── Rate Limit Schemas ──────────────────────────────────

export const rateLimitCheckSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9:_-]+$/, "Invalid rate limit key format"),
});

// ─── Pagination Schema ───────────────────────────────────

export const paginationSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

// ─── Date/Time Schema ────────────────────────────────────

export const dateTimeSchema = z.string().datetime().optional();

// ─── Sanitizer ────────────────────────────────────────────

/**
 * Deeply sanitize user input by stripping HTML/script tags
 * and trimming strings to prevent XSS in downstream systems.
 */
export function sanitizeInput<T>(data: T): T {
  if (typeof data === "string") {
    return data
      .replace(/<[^>]*>/g, "") // Strip HTML tags
      .replace(/[<>]/g, "")     // Remove remaining angle brackets
      .replace(/javascript\s*:/gi, "js_protocol") // Replace JS protocol
      .replace(/\s+on\w+\s*=/gi, " has_event=")  // Replace event handlers
      .trim() as T;
  }
  if (Array.isArray(data)) {
    return data.map(sanitizeInput) as T;
  }
  if (data && typeof data === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      sanitized[key] = sanitizeInput(value);
    }
    return sanitized as T;
  }
  return data;
}

/**
 * Mask sensitive data in logs. Preserves structure but
 * replaces sensitive field values with asterisks.
 */
export function maskSensitiveData<T>(data: T, sensitiveFields: string[] = []): T {
  const defaultSensitive = [
    "password", "secret", "token", "apiKey", "api_key",
    "authorization", "auth", "creditCard", "ssn", "email",
  ];
  const fields = [...new Set([...defaultSensitive, ...sensitiveFields])];

  if (data && typeof data === "object") {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (fields.some((f) => key.toLowerCase().includes(f.toLowerCase()))) {
        masked[key] = "***REDACTED***";
      } else {
        masked[key] = maskSensitiveData(value, fields);
      }
    }
    return masked as T;
  }
  return data;
}
