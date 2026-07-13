import dotenv from "dotenv";

dotenv.config();

export interface Config {
  port: number;
  nodeEnv: string;
  redis: {
    host: string;
    port: number;
    password: string | undefined;
    keyPrefix: string;
  };
  rateLimiter: {
    windowMs: number;
    maxRequests: number;
  };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  soap: {
    wsdlUrl: string;
    username: string;
    password: string;
    timeoutMs: number;
  };
  sql: {
    connectionString: string;
    schema: string;
    timeoutMs: number;
  };
  sync: {
    pollIntervalMs: number;
    batchSize: number;
  };
  log: {
    level: string;
    prettyPrint: boolean;
  };
  security: {
    jwtSecret: string;
    jwtExpiresIn: string;
    encryptionKey: string;
    authEnabled: boolean;
    graphqlIntrospection: boolean;
    maxQueryDepth: number;
    corsOrigins: string[];
    dashboardAuthEnabled: boolean;
    dashboardUsername: string;
    dashboardPassword: string;
    maxPayloadSize: string;
  };
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
  }
  return parsed;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  return raw === "true" || raw === "1";
}

function getEnvArray(key: string, defaultValue: string[]): string[] {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  return {
    port: getEnvInt("PORT", 4000),
    nodeEnv: getEnvVar("NODE_ENV", "development"),
    redis: {
      host: getEnvVar("REDIS_HOST", "localhost"),
      port: getEnvInt("REDIS_PORT", 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      keyPrefix: "api-bridge:",
    },
    rateLimiter: {
      windowMs: getEnvInt("RATE_LIMIT_WINDOW_MS", 60_000),
      maxRequests: getEnvInt("RATE_LIMIT_MAX_REQUESTS", 100),
    },
    retry: {
      maxAttempts: getEnvInt("RETRY_MAX_ATTEMPTS", 5),
      baseDelayMs: getEnvInt("RETRY_BASE_DELAY_MS", 1_000),
      maxDelayMs: getEnvInt("RETRY_MAX_DELAY_MS", 60_000),
    },
    soap: {
      wsdlUrl: getEnvVar("SOAP_WSDL_URL", "https://legacy.example.com/service?wsdl"),
      username: getEnvVar("SOAP_USERNAME", "admin"),
      password: getEnvVar("SOAP_PASSWORD", "password"),
      timeoutMs: getEnvInt("SOAP_TIMEOUT_MS", 10_000),
    },
    sql: {
      connectionString: getEnvVar("SQL_CONNECTION_STRING", "postgresql://localhost:5432/legacy"),
      schema: getEnvVar("SQL_SCHEMA", "public"),
      timeoutMs: getEnvInt("SQL_TIMEOUT_MS", 5_000),
    },
    sync: {
      pollIntervalMs: getEnvInt("SYNC_POLL_INTERVAL_MS", 30_000),
      batchSize: getEnvInt("SYNC_BATCH_SIZE", 50),
    },
    log: {
      level: getEnvVar("LOG_LEVEL", "info"),
      prettyPrint: process.env.LOG_PRETTY === "true",
    },
    security: {
      jwtSecret: getEnvVar("JWT_SECRET", "dev-jwt-secret-change-in-production-min-32-chars!"),
      jwtExpiresIn: getEnvVar("JWT_EXPIRES_IN", "1h"),
      encryptionKey: getEnvVar("ENCRYPTION_KEY", "dev-encryption-key-change!"),
      authEnabled: getEnvBool("AUTH_ENABLED", true),
      graphqlIntrospection: getEnvBool("GRAPHQL_INTROSPECTION", false),
      maxQueryDepth: getEnvInt("MAX_QUERY_DEPTH", 7),
      corsOrigins: getEnvArray("CORS_ORIGINS", ["http://localhost:4001"]),
      dashboardAuthEnabled: getEnvBool("DASHBOARD_AUTH_ENABLED", true),
      dashboardUsername: getEnvVar("DASHBOARD_USERNAME", "admin"),
      dashboardPassword: getEnvVar("DASHBOARD_PASSWORD", ""),
      maxPayloadSize: getEnvVar("MAX_PAYLOAD_SIZE", "1mb"),
    },
  };
}

export const config = loadConfig();
