import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { SoapClient } from "./adapters/soap-client.js";
import { SqlAdapter } from "./adapters/sql-adapter.js";
import { RateLimiter } from "./middleware/rate-limiter.js";
import { RetryHandler } from "./middleware/retry.js";
import { SyncEngine, SyncEventStore } from "./bridge/sync-engine.js";
import { typeDefs } from "./graphql/schema.js";
import { createResolvers } from "./graphql/resolvers.js";
import { createSecurityPlugin, SecurityContext } from "./security/security-plugin.js";
import { authManager } from "./security/auth.js";
import { auditLogger } from "./security/audit-logger.js";

// ─── Module-level references for graceful shutdown ────────
let soapClient: SoapClient | null = null;
let sqlAdapter: SqlAdapter | null = null;
let rateLimiter: RateLimiter | null = null;
let retryHandler: RetryHandler | null = null;
let syncEngine: SyncEngine | null = null;
let syncEventStore: SyncEventStore | null = null;

async function main(): Promise<void> {
  logger.info("Starting API Bridge — Legacy SOAP/SQL ↔ Modern SaaS");

  // ─── Initialize adapters ─────────────────────────────────
  soapClient = new SoapClient({
    wsdlUrl: config.soap?.wsdlUrl ?? "https://legacy.example.com/service?wsdl",
    username: config.soap?.username ?? "admin",
    password: config.soap?.password ?? "password",
    timeoutMs: config.soap?.timeoutMs ?? 10_000,
  });

  const sqlAdapter = new SqlAdapter({
    connectionString: config.sql?.connectionString ?? "postgresql://localhost:5432/legacy",
    schema: config.sql?.schema ?? "public",
    timeoutMs: config.sql?.timeoutMs ?? 5_000,
  });

  // ─── Initialize middleware ───────────────────────────────
  const rateLimiter = new RateLimiter();
  const retryHandler = new RetryHandler();

  // ─── Initialize sync engine ──────────────────────────────
  syncEventStore = new SyncEventStore();
  syncEngine = new SyncEngine(soapClient, sqlAdapter, retryHandler, syncEventStore);

  // ─── Connect to legacy systems ───────────────────────────
  try {
    await soapClient!.connect();
    await sqlAdapter!.connect();
    await rateLimiter!.connect();
    await retryHandler!.connect();
    logger.info("All adapters and middleware connected");
  } catch (err) {
    logger.fatal({ err }, "Failed to connect adapters. Exiting.");
    process.exit(1);
  }

  // ─── Build Apollo Server ─────────────────────────────────
  const resolvers = createResolvers({
    soapClient,
    sqlAdapter,
    rateLimiter,
    retryHandler,
    syncEngine,
    syncEventStore,
  });

  // ─── Security Plugin ────────────────────────────────────
  const securityPlugin = createSecurityPlugin();

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    includeStacktraceInErrorResponses: config.nodeEnv === "development" && config.security.authEnabled === false,
    plugins: [securityPlugin],
    formatError: (formattedError) => {
      // Sanitize errors in production — never leak internals
      if (config.nodeEnv === "production") {
        auditLogger.warn("SYNC_FAILED", {
          error: formattedError.message,
          code: formattedError.extensions?.code,
        });
        return {
          message: formattedError.message,
          extensions: {
            code: formattedError.extensions?.code ?? "INTERNAL_ERROR",
          },
        };
      }
      logger.error({ error: formattedError }, "GraphQL error");
      return formattedError;
    },
  });

  // ─── Start HTTP server ───────────────────────────────────
  const { url } = await startStandaloneServer(server, {
    listen: { port: config.port },
    context: async () => ({
      soapClient: soapClient!,
      sqlAdapter: sqlAdapter!,
      rateLimiter: rateLimiter!,
      retryHandler: retryHandler!,
      syncEngine: syncEngine!,
      syncEventStore: syncEventStore!,
      authManager,
      auditLogger,
    }),
  });

  logger.info({ url }, `API Bridge ready at ${url}`);
}

// ─── Graceful Shutdown ──────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down gracefully");
  try {
    await soapClient?.disconnect();
    await sqlAdapter?.disconnect();
    await rateLimiter?.disconnect();
    await retryHandler?.disconnect();
    logger.info("All connections closed");
  } catch (err) {
    logger.error({ err }, "Error during shutdown");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  logger.fatal({ err }, "Unhandled error in main()");
  process.exit(1);
});
