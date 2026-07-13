import { GraphQLError } from "graphql";
import { SoapClient } from "../adapters/soap-client.js";
import { SqlAdapter } from "../adapters/sql-adapter.js";
import { RateLimiter } from "../middleware/rate-limiter.js";
import { RetryHandler } from "../middleware/retry.js";
import { SyncEngine, SyncEventStore } from "../bridge/sync-engine.js";
import { AuthManager, AuthenticatedUser, authManager } from "../security/auth.js";
import { auditLogger } from "../security/audit-logger.js";
import {
  syncFromSoapSchema,
  syncFromSqlSchema,
  pushToSoapSchema,
  pushToSqlSchema,
  bidirectionalSyncSchema,
  paginationSchema,
  sanitizeInput,
} from "../security/validators.js";
import { ValidationError, AuthenticationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

export interface ResolverContext {
  soapClient: SoapClient;
  sqlAdapter: SqlAdapter;
  rateLimiter: RateLimiter;
  retryHandler: RetryHandler;
  syncEngine: SyncEngine;
  syncEventStore: SyncEventStore;
  authManager?: AuthManager;
  auditLogger?: typeof auditLogger;
  user?: AuthenticatedUser | null;
  isAuthenticated?: boolean;
}

interface PaginationArgs {
  limit?: number;
}

export function createResolvers(context: ResolverContext) {
  const { soapClient, sqlAdapter, rateLimiter, retryHandler, syncEngine, syncEventStore } = context;
  const am = context.authManager ?? authManager;
  const al = context.auditLogger ?? auditLogger;

  // ─── Auth helper ──────────────────────────────────────
  function assertAuth(ctx: ResolverContext): AuthenticatedUser {
    if (!ctx.isAuthenticated || !ctx.user) {
      auditLogger.warn("AUTH_FAILURE", { reason: "Unauthenticated resolver access" });
      throw new AuthenticationError("Authentication is required for this operation");
    }
    return ctx.user;
  }

  return {
    Query: {
      legacySoapCustomers: async (
        _: unknown,
        args: { since?: string },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "sync:read");
        await rateLimiter.assertAllowed(`query:soap:customers:${user.id}`);
        return retryHandler.execute(
          () => soapClient.getCustomers(args.since ?? undefined),
          { operationName: "getSoapCustomers" },
        );
      },

      legacySoapInvoices: async (
        _: unknown,
        args: { since?: string },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "sync:read");
        await rateLimiter.assertAllowed(`query:soap:invoices:${user.id}`);
        return retryHandler.execute(
          () => soapClient.getInvoices(args.since ?? undefined),
          { operationName: "getSoapInvoices" },
        );
      },

      legacySqlCustomers: async (
        _: unknown,
        args: { since?: string },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "sync:read");
        await rateLimiter.assertAllowed(`query:sql:customers:${user.id}`);
        const result = await retryHandler.execute(
          () => sqlAdapter.query("customers", args.since ?? undefined),
          { operationName: "getSqlCustomers" },
        );
        return result.rows;
      },

      legacySqlOrders: async (
        _: unknown,
        args: { since?: string },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "sync:read");
        await rateLimiter.assertAllowed(`query:sql:orders:${user.id}`);
        const result = await retryHandler.execute(
          () => sqlAdapter.query("orders", args.since ?? undefined),
          { operationName: "getSqlOrders" },
        );
        return result.rows;
      },

      rateLimitStatus: async (
        _: unknown,
        args: { key: string },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "rate-limit:read");
        // Sanitize the key
        const safeKey = sanitizeInput(args.key);
        const status = await rateLimiter.check(safeKey);
        return {
          key: safeKey,
          allowed: status.allowed,
          remaining: status.remaining,
          resetAt: new Date(status.resetAt).toISOString(),
        };
      },

      syncEvents: async (
        _: unknown,
        args: PaginationArgs,
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "events:read");
        const { limit } = paginationSchema.parse(args);
        return syncEventStore.getRecent(limit);
      },
    },

    Mutation: {
      syncFromSoap: async (
        _: unknown,
        args: { entityType: string; since?: string },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "sync:write");

        try {
          // Validate and sanitize input
          const validated = syncFromSoapSchema.parse({
            entityType: sanitizeInput(args.entityType),
            since: args.since,
          });

          await rateLimiter.assertAllowed(`mutation:sync:soap:${user.id}`);

          al.info("SYNC_STARTED", {
            entityType: validated.entityType,
            userId: user.id,
          });

          const result = await syncEngine.syncFromSoap(
            validated.entityType,
            validated.since ?? undefined,
          );

          al.info("SYNC_COMPLETED", {
            entityType: validated.entityType,
            success: result.success,
            userId: user.id,
          });

          return {
            success: result.success,
            event: result.event
              ? { ...result.event, timestamp: result.event.timestamp.toISOString() }
              : null,
            message: result.message,
          };
        } catch (err) {
          if (err instanceof ValidationError) throw err;
          logger.error({ err, entityType: args.entityType }, "syncFromSoap failed");
          al.error("SYNC_FAILED", { entityType: args.entityType, error: err instanceof Error ? err.message : "Unknown" });
          return {
            success: false,
            event: null,
            message: err instanceof Error ? err.message : "Unknown error",
          };
        }
      },

      syncFromSql: async (
        _: unknown,
        args: { tableName: string; since?: string },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "sync:write");

        try {
          const validated = syncFromSqlSchema.parse({
            tableName: sanitizeInput(args.tableName),
            since: args.since,
          });

          await rateLimiter.assertAllowed(`mutation:sync:sql:${user.id}`);

          al.info("SYNC_STARTED", { tableName: validated.tableName, userId: user.id });

          const result = await syncEngine.syncFromSql(
            validated.tableName,
            validated.since ?? undefined,
          );

          al.info("SYNC_COMPLETED", { tableName: validated.tableName, success: result.success, userId: user.id });

          return {
            success: result.success,
            event: result.event
              ? { ...result.event, timestamp: result.event.timestamp.toISOString() }
              : null,
            message: result.message,
          };
        } catch (err) {
          if (err instanceof ValidationError) throw err;
          logger.error({ err, tableName: args.tableName }, "syncFromSql failed");
          al.error("SYNC_FAILED", { tableName: args.tableName, error: err instanceof Error ? err.message : "Unknown" });
          return { success: false, event: null, message: err instanceof Error ? err.message : "Unknown error" };
        }
      },

      pushToSoap: async (
        _: unknown,
        args: { customerId: string; data: Record<string, unknown> },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "sync:write");

        try {
          const validated = pushToSoapSchema.parse({
            customerId: sanitizeInput(args.customerId),
            data: sanitizeInput(args.data),
          });

          await rateLimiter.assertAllowed(`mutation:push:soap:${user.id}`);

          const result = await syncEngine.pushToSoap(validated.customerId, validated.data);
          return {
            success: result.success,
            event: result.event
              ? { ...result.event, timestamp: result.event.timestamp.toISOString() }
              : null,
            message: result.message,
          };
        } catch (err) {
          if (err instanceof ValidationError) throw err;
          logger.error({ err, customerId: args.customerId }, "pushToSoap failed");
          return { success: false, event: null, message: err instanceof Error ? err.message : "Unknown error" };
        }
      },

      pushToSql: async (
        _: unknown,
        args: { tableName: string; id: string; data: Record<string, unknown> },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "sync:write");

        try {
          const validated = pushToSqlSchema.parse({
            tableName: sanitizeInput(args.tableName),
            id: sanitizeInput(args.id),
            data: sanitizeInput(args.data),
          });

          await rateLimiter.assertAllowed(`mutation:push:sql:${user.id}`);

          const result = await syncEngine.pushToSql(validated.tableName, validated.id, validated.data);
          return {
            success: result.success,
            event: result.event
              ? { ...result.event, timestamp: result.event.timestamp.toISOString() }
              : null,
            message: result.message,
          };
        } catch (err) {
          if (err instanceof ValidationError) throw err;
          logger.error({ err, tableName: args.tableName, id: args.id }, "pushToSql failed");
          return { success: false, event: null, message: err instanceof Error ? err.message : "Unknown error" };
        }
      },

      bidirectionalSync: async (
        _: unknown,
        args: { entityType: string; entityId: string },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "sync:bidirectional");

        try {
          const validated = bidirectionalSyncSchema.parse({
            entityType: sanitizeInput(args.entityType),
            entityId: sanitizeInput(args.entityId),
          });

          await rateLimiter.assertAllowed(`mutation:sync:bidirectional:${user.id}`);

          al.info("SYNC_STARTED", { entityType: validated.entityType, entityId: validated.entityId, mode: "bidirectional", userId: user.id });

          const result = await syncEngine.bidirectionalSync(validated.entityType, validated.entityId);
          return {
            success: result.success,
            event: result.event
              ? { ...result.event, timestamp: result.event.timestamp.toISOString() }
              : null,
            message: result.message,
          };
        } catch (err) {
          if (err instanceof ValidationError) throw err;
          logger.error({ err, entityType: args.entityType, entityId: args.entityId }, "bidirectionalSync failed");
          return { success: false, event: null, message: err instanceof Error ? err.message : "Unknown error" };
        }
      },

      clearRateLimit: async (
        _: unknown,
        args: { key: string },
        ctx: ResolverContext,
      ) => {
        const user = assertAuth(ctx);
        am.assertPermission(user, "rate-limit:clear");
        try {
          await rateLimiter.check(sanitizeInput(args.key));
          return true;
        } catch {
          return false;
        }
      },
    },
  };
}
