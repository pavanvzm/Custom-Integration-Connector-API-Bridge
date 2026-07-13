import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock auditLogger before any imports that use it
vi.mock("../src/security/audit-logger.js", () => ({
  auditLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  },
}));

import { AuthManager, AuthenticatedUser } from "../src/security/auth.js";
import { AuthenticationError, AuthorizationError } from "../src/utils/errors.js";

describe("AuthManager", () => {
  let auth: AuthManager;
  let adminUser: AuthenticatedUser;

  beforeEach(() => {
    auth = new AuthManager();
    adminUser = {
      id: "user-1",
      role: "admin",
      permissions: ["*"],
      apiKeyPrefix: "test",
    };
  });

  describe("generateToken / verifyToken", () => {
    it("generates a valid JWT", () => {
      const token = auth.generateToken(adminUser);
      expect(typeof token).toBe("string");
      expect(token.split(".").length).toBe(3); // JWT has 3 parts
    });

    it("verifies a valid token", () => {
      const token = auth.generateToken(adminUser);
      const payload = auth.verifyToken(token);
      expect(payload.sub).toBe("user-1");
      expect(payload.role).toBe("admin");
    });

    it("throws on invalid token", () => {
      expect(() => auth.verifyToken("invalid.token.here")).toThrow(AuthenticationError);
    });
  });

  describe("authenticate with JWT", () => {
    it("returns authenticated user for valid Bearer token", async () => {
      const token = auth.generateToken(adminUser);
      const result = await auth.authenticate(`Bearer ${token}`);

      expect(result.authenticated).toBe(true);
      if (result.authenticated) {
        expect(result.user.id).toBe("user-1");
        expect(result.user.role).toBe("admin");
      }
    });

    it("returns failure for invalid Bearer token", async () => {
      const result = await auth.authenticate("Bearer invalid-token");
      expect(result.authenticated).toBe(false);
    });

    it("returns failure when no credentials provided", async () => {
      const result = await auth.authenticate();
      expect(result.authenticated).toBe(false);
      if (!result.authenticated) {
        expect(result.reason).toContain("No authentication");
      }
    });
  });

  describe("hasPermission / assertPermission", () => {
    it("admin has all permissions (wildcard)", () => {
      expect(auth.hasPermission(adminUser, "sync:read")).toBe(true);
      expect(auth.hasPermission(adminUser, "sync:write")).toBe(true);
      expect(auth.hasPermission(adminUser, "config:write")).toBe(true);
    });

    it("assertPermission does not throw for valid permission", () => {
      expect(() => auth.assertPermission(adminUser, "sync:read")).not.toThrow();
    });

    it("readonly user lacks write permissions", () => {
      const readOnlyUser: AuthenticatedUser = {
        id: "user-2",
        role: "readonly",
        permissions: ["sync:read", "rate-limit:read", "events:read"],
        apiKeyPrefix: "test",
      };

      expect(auth.hasPermission(readOnlyUser, "sync:read")).toBe(true);
      expect(auth.hasPermission(readOnlyUser, "sync:write")).toBe(false);
      expect(auth.hasPermission(readOnlyUser, "sync:bidirectional")).toBe(false);
    });

    it("assertPermission throws AuthorizationError for missing permission", () => {
      const readOnlyUser: AuthenticatedUser = {
        id: "user-2",
        role: "readonly",
        permissions: ["sync:read", "events:read"],
        apiKeyPrefix: "test",
      };

      expect(() => auth.assertPermission(readOnlyUser, "sync:write")).toThrow(AuthorizationError);
    });
  });
});
