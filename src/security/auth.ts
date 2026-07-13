import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { AuthenticationError, AuthorizationError } from "../utils/errors.js";
import { auditLogger } from "./audit-logger.js";

// ─── Types ────────────────────────────────────────────────

export interface AuthenticatedUser {
  id: string;
  role: "admin" | "operator" | "readonly";
  permissions: string[];
  apiKeyPrefix: string;
}

export interface AuthTokenPayload {
  sub: string;
  role: AuthenticatedUser["role"];
  perms: string[];
  iat: number;
  exp: number;
}

export type AuthResult =
  | { authenticated: true; user: AuthenticatedUser }
  | { authenticated: false; reason: string };

// ─── Role-Based Permissions ───────────────────────────────

const ROLE_PERMISSIONS: Record<AuthenticatedUser["role"], string[]> = {
  admin: [
    "sync:read", "sync:write", "sync:bidirectional",
    "rate-limit:read", "rate-limit:clear",
    "events:read", "config:read", "config:write",
  ],
  operator: [
    "sync:read", "sync:write", "sync:bidirectional",
    "rate-limit:read",
    "events:read",
  ],
  readonly: [
    "sync:read",
    "rate-limit:read",
    "events:read",
  ],
};

// ─── API Key Management ───────────────────────────────────

interface ApiKeyRecord {
  id: string;
  keyHash: string;
  label: string;
  role: AuthenticatedUser["role"];
  prefix: string;
  createdAt: string;
  enabled: boolean;
}

// In-memory API key store — replace with DB in production
const apiKeyStore: Map<string, ApiKeyRecord> = new Map();

// Add default admin key on startup (for dev)
function initDefaultKeys(): void {
  if (config.nodeEnv === "development" || config.nodeEnv === "test") {
    const devKeyHash = bcrypt.hashSync("api-bridge-dev-key", 10);
    apiKeyStore.set("key-admin-1", {
      id: "key-admin-1",
      keyHash: devKeyHash,
      label: "Development Admin Key",
      role: "admin",
      prefix: "ak_dev".slice(0, 7),
      createdAt: new Date().toISOString(),
      enabled: true,
    });
  }
}

initDefaultKeys();

// ─── Auth Manager ─────────────────────────────────────────

export class AuthManager {
  private jwtSecret: string;
  private jwtExpiresIn: string;

  constructor() {
    this.jwtSecret = config.security.jwtSecret;
    this.jwtExpiresIn = config.security.jwtExpiresIn;
  }

  /**
   * Generate a JWT for a user.
   */
  generateToken(user: AuthenticatedUser): string {
    const payload: AuthTokenPayload = {
      sub: user.id,
      role: user.role,
      perms: user.permissions,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + this.parseExpiry(this.jwtExpiresIn),
    };

    return jwt.sign(payload, this.jwtSecret, { algorithm: "HS256" });
  }

  /**
   * Verify and decode a JWT.
   */
  verifyToken(token: string): AuthTokenPayload {
    try {
      return jwt.verify(token, this.jwtSecret, {
        algorithms: ["HS256"],
      }) as AuthTokenPayload;
    } catch (err) {
      throw new AuthenticationError("Invalid or expired token");
    }
  }

  /**
   * Authenticate a request using either JWT Bearer token or API key.
   */
  async authenticate(authHeader?: string, apiKey?: string): Promise<AuthResult> {
    // Try JWT first
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7);
        const payload = this.verifyToken(token);
        const user: AuthenticatedUser = {
          id: payload.sub,
          role: payload.role,
          permissions: payload.perms,
          apiKeyPrefix: "jwt",
        };

        auditLogger.info("AUTH_SUCCESS", {
          userId: user.id,
          role: user.role,
          method: "jwt",
        });

        return { authenticated: true, user };
      } catch (err) {
        auditLogger.warn("AUTH_FAILURE", {
          method: "jwt",
          error: err instanceof Error ? err.message : "Unknown error",
        });
        return { authenticated: false, reason: "Invalid JWT token" };
      }
    }

    // Try API key
    if (apiKey) {
      const prefix = apiKey.substring(0, 7);
      for (const [, record] of apiKeyStore) {
        if (record.prefix === prefix && record.enabled) {
          const valid = bcrypt.compareSync(apiKey, record.keyHash);
          if (valid) {
            const user: AuthenticatedUser = {
              id: record.id,
              role: record.role,
              permissions: ROLE_PERMISSIONS[record.role],
              apiKeyPrefix: prefix,
            };

            auditLogger.info("AUTH_SUCCESS", {
              userId: record.id,
              role: record.role,
              method: "api_key",
            });

            return { authenticated: true, user };
          }
        }
      }

      auditLogger.warn("AUTH_FAILURE", {
        method: "api_key",
        error: "Invalid or disabled API key",
      });
      return { authenticated: false, reason: "Invalid API key" };
    }

    // No credentials provided
    return { authenticated: false, reason: "No authentication credentials provided" };
  }

  /**
   * Create a new API key (admin only).
   */
  async createApiKey(
    label: string,
    role: AuthenticatedUser["role"],
    createdBy: string,
  ): Promise<{ key: string; id: string }> {
    const id = `key-${crypto.randomUUID().substring(0, 8)}`;
    const rawKey = `ak_${crypto.randomBytes(24).toString("hex")}`;
    const keyHash = await bcrypt.hash(rawKey, 12);
    const prefix = rawKey.substring(0, 7);

    apiKeyStore.set(id, {
      id,
      keyHash,
      label,
      role,
      prefix,
      createdAt: new Date().toISOString(),
      enabled: true,
    });

    auditLogger.info("API_KEY_CREATED", {
      keyId: id,
      role,
      createdBy,
    });

    return { key: rawKey, id };
  }

  /**
   * Revoke (disable) an API key.
   */
  async revokeApiKey(keyId: string, revokedBy: string): Promise<boolean> {
    const record = apiKeyStore.get(keyId);
    if (!record) return false;

    record.enabled = false;
    apiKeyStore.set(keyId, record);

    auditLogger.warn("API_KEY_REVOKED", {
      keyId,
      revokedBy,
    });

    return true;
  }

  /**
   * Check if a user has a specific permission.
   */
  hasPermission(user: AuthenticatedUser, permission: string): boolean {
    // Wildcard '*' grants all permissions
    if (user.permissions.includes("*")) return true;
    return user.permissions.includes(permission);
  }

  /**
   * Assert a user has a specific permission, throwing if not.
   */
  assertPermission(user: AuthenticatedUser, permission: string): void {
    if (!this.hasPermission(user, permission)) {
      auditLogger.warn("PERMISSION_DENIED", {
        userId: user.id,
        role: user.role,
        requiredPermission: permission,
      });
      throw new AuthorizationError(
        `Insufficient permissions. Required: ${permission}`,
        user.role,
        permission,
      );
    }
  }

  private parseExpiry(expiry: string): number {
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) return 3600; // default 1 hour
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3600,
      d: 86400,
    };
    return value * (multipliers[unit] ?? 3600);
  }
}

// Singleton
export const authManager = new AuthManager();
