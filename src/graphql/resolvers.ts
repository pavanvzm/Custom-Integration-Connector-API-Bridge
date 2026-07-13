import { GraphQLError } from "graphql";
import { SoapClient } from "../adapters/soap-client.js";
import { SqlAdapter } from "../adapters/sql-adapter.js";
import { RateLimiter } from "../middleware/rate-limiter.js";
import { RetryHandler } from "../middleware/retry.js";
import { SyncEngine, SyncEventStore } from "../bridge/sync-engine.js";
import { logger } from "../utils/logger.js";

interface ResolverContext {
  soapClient: SoapClient;
  sqlAdapter: SqlAdapter;
  rateLimiter: RateLimiter;
  retryHandler: RetryHandler;
  syncEngine: SyncEngine;
  syncEventStore: SyncEventStore;
}

interface PaginationArgs {
  limit?: number;
}

export function createResolvers(context: ResolverContext) {
  const { soapClient, sqlAdapter, rateLimiter, retryHandler, syncEngine, syncEventStore } = context;

  return {
    Query: {
      legacySoapCustomers: async (
        _: unknown,
        args: { since?: string },
      ) => {
        await rateLimiter.assertAllowed("query:soap:customers");
        return retryHandler.execute(
          () => soapClient.getCustomers(args.since ?? undefined),
          { operationName: "getSoapCustomers" },
        );
      },

      legacySoapInvoices: async (
        _: unknown,
        args: { since?: string },
      ) => {
        await rateLimiter.assertAllowed("query:soap:invoices");
        return retryHandler.execute(
          () => soapClient.getInvoices(args.since ?? undefined),
          { operationName: "getSoapInvoices" },
        );
      },

      legacySqlCustomers: async (
        _: unknown,
        args: { since?: string },
      ) => {
        await rateLimiter.assertAllowed("query:sql:customers");
        const result = await retryHandler.execute(
          () => sqlAdapter.query("customers", args.since ?? undefined),
          { operationName: "getSqlCustomers" },
        );
        return result.rows;
      },

      legacySqlOrders: async (
        _: unknown,
        args: { since?: string },
      ) => {
        await rateLimiter.assertAllowed("query:sql:orders");
        const result = await retryHandler.execute(
          () => sqlAdapter.query("orders", args.since ?? undefined),
          { operationName: "getSqlOrders" },
        );
        return result.rows;
      },

      rateLimitStatus: async (
        _: unknown,
        args: { key: string },
      ) => {
        const status = await rateLimiter.check(args.key);
        return {
          key: args.key,
          allowed: status.allowed,
          remaining: status.remaining,
          resetAt: new Date(status.resetAt).toISOString(),
        };
      },

      syncEvents: async (
        _: unknown,
        args: PaginationArgs,
      ) => {
        return syncEventStore.getRecent(args.limit ?? 50);
      },
    },

    Mutation: {
      syncFromSoap: async (
        _: unknown,
        args: { entityType: string; since?: string },
      ) => {
        try {
          await rateLimiter.assertAllowed("mutation:sync:soap");
          const result = await syncEngine.syncFromSoap(
            args.entityType,
            args.since ?? undefined,
          );
          return {
            success: result.success,
            event: result.event
              ? {
                  ...result.event,
                  timestamp: result.event.timestamp.toISOString(),
                }
              : null,
            message: result.message,
          };
        } catch (err) {
          logger.error({ err, entityType: args.entityType }, "syncFromSoap failed");
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
      ) => {
        try {
          await rateLimiter.assertAllowed("mutation:sync:sql");
          const result = await syncEngine.syncFromSql(
            args.tableName,
            args.since ?? undefined,
          );
          return {
            success: result.success,
            event: result.event
              ? {
                  ...result.event,
                  timestamp: result.event.timestamp.toISOString(),
                }
              : null,
            message: result.message,
          };
        } catch (err) {
          logger.error({ err, tableName: args.tableName }, "syncFromSql failed");
          return {
            success: false,
            event: null,
            message: err instanceof Error ? err.message : "Unknown error",
          };
        }
      },

      pushToSoap: async (
        _: unknown,
        args: { customerId: string; data: Record<string, unknown> },
      ) => {
        try {
          await rateLimiter.assertAllowed("mutation:push:soap");
          const result = await syncEngine.pushToSoap(args.customerId, args.data);
          return {
            success: result.success,
            event: result.event
              ? {
                  ...result.event,
                  timestamp: result.event.timestamp.toISOString(),
                }
              : null,
            message: result.message,
          };
        } catch (err) {
          logger.error({ err, customerId: args.customerId }, "pushToSoap failed");
          return {
            success: false,
            event: null,
            message: err instanceof Error ? err.message : "Unknown error",
          };
        }
      },

      pushToSql: async (
        _: unknown,
        args: { tableName: string; id: string; data: Record<string, unknown> },
      ) => {
        try {
          await rateLimiter.assertAllowed("mutation:push:sql");
          const result = await syncEngine.pushToSql(args.tableName, args.id, args.data);
          return {
            success: result.success,
            event: result.event
              ? {
                  ...result.event,
                  timestamp: result.event.timestamp.toISOString(),
                }
              : null,
            message: result.message,
          };
        } catch (err) {
          logger.error({ err, tableName: args.tableName, id: args.id }, "pushToSql failed");
          return {
            success: false,
            event: null,
            message: err instanceof Error ? err.message : "Unknown error",
          };
        }
      },

      bidirectionalSync: async (
        _: unknown,
        args: { entityType: string; entityId: string },
      ) => {
        try {
          await rateLimiter.assertAllowed("mutation:sync:bidirectional");
          const result = await syncEngine.bidirectionalSync(args.entityType, args.entityId);
          return {
            success: result.success,
            event: result.event
              ? {
                  ...result.event,
                  timestamp: result.event.timestamp.toISOString(),
                }
              : null,
            message: result.message,
          };
        } catch (err) {
          logger.error(
            { err, entityType: args.entityType, entityId: args.entityId },
            "bidirectionalSync failed",
          );
          return {
            success: false,
            event: null,
            message: err instanceof Error ? err.message : "Unknown error",
          };
        }
      },

      clearRateLimit: async (
        _: unknown,
        args: { key: string },
      ) => {
        try {
          await rateLimiter.check(args.key);
          return true;
        } catch {
          return false;
        }
      },
    },
  };
}
