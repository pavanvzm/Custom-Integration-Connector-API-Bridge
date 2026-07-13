import { ApolloServerPlugin } from "@apollo/server";
import { GraphQLError, DocumentNode, ValidationRule } from "graphql";
import depthLimitFn from "graphql-depth-limit";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { authManager, AuthenticatedUser } from "./auth.js";
import { auditLogger } from "./audit-logger.js";
import { sanitizeInput } from "./validators.js";
import { AuthenticationError, AuthorizationError } from "../utils/errors.js";

// ─── Context Type ────────────────────────────────────────

export interface SecurityContext {
  user: AuthenticatedUser | null;
  isAuthenticated: boolean;
  correlationId: string;
}

// ─── Query Cost Analysis ─────────────────────────────────

interface CostConfig {
  defaultCost: number;
  mutationCost: number;
  listCostMultiplier: number;
  maxCost: number;
}

const costConfig: CostConfig = {
  defaultCost: 1,
  mutationCost: 5,
  listCostMultiplier: 2,
  maxCost: 100,
};

interface OperationDef {
  kind: string;
  operation?: string;
  selectionSet?: {
    selections: Array<{
      kind: string;
      name?: { value: string };
      selectionSet?: { selections: any[] };
    }>;
  };
}

interface Doc {
  definitions: OperationDef[];
}

function calculateQueryCost(document: Doc): number {
  let totalCost = 0;

  for (const def of document.definitions) {
    if (def.kind === "OperationDefinition") {
      const isMutation = def.operation === "mutation";
      totalCost += isMutation ? costConfig.mutationCost : costConfig.defaultCost;

      if (def.selectionSet) {
        totalCost += countSelections(def.selectionSet, 1);
      }
    }
  }

  return totalCost;
}

function countSelections(selectionSet: { selections: any[] }, depth: number): number {
  if (!selectionSet?.selections || depth > 5) return 0;

  let count = 0;
  for (const sel of selectionSet.selections) {
    if (sel.kind === "Field") {
      const fieldName = sel.name?.value ?? "";
      const isList = fieldName === "events" ||
        fieldName.endsWith("s") ||
        fieldName === "rows" ||
        fieldName === "customers" ||
        fieldName === "invoices";

      count += isList ? costConfig.listCostMultiplier : 1;

      if (sel.selectionSet) {
        count += countSelections(sel.selectionSet, depth + 1);
      }
    }
  }
  return count;
}

// ─── Security Plugin ─────────────────────────────────────

export function createSecurityPlugin(): ApolloServerPlugin {
  return {
    async serverWillStart() {
      auditLogger.info("SYSTEM_STARTUP", {
        environment: config.nodeEnv,
        authEnabled: config.security.authEnabled,
        introspectionEnabled: config.security.graphqlIntrospection,
        maxQueryDepth: config.security.maxQueryDepth,
      });
    },

    async requestDidStart({ request, contextValue }): Promise<any> {
      const startTime = Date.now();
      const correlationId = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

      // ── Authentication ──────────────────────────────
      const ctx = contextValue as Record<string, unknown>;
      const http = request.http as any;
      const authHeader = http?.headers?.get?.("authorization") as string | undefined;
      const apiKey = http?.headers?.get?.("x-api-key") as string | undefined;

      let user: AuthenticatedUser | null = null;
      let isAuthenticated = false;

      if (config.security.authEnabled) {
        const authResult = await authManager.authenticate(authHeader, apiKey);
        if (authResult.authenticated) {
          user = authResult.user;
          isAuthenticated = true;
        }
      } else {
        user = {
          id: "anonymous-dev",
          role: "admin",
          permissions: ["*"],
          apiKeyPrefix: "dev",
        };
        isAuthenticated = true;
      }

      ctx.user = user;
      ctx.isAuthenticated = isAuthenticated;
      ctx.correlationId = correlationId;

      return {
        async didResolveOperation({ document }: { document: DocumentNode }) {
          const maxDepth = config.security.maxQueryDepth;
          const depthLimitRule = depthLimitFn(maxDepth) as unknown as ValidationRule;

          // Simple depth checking via recursion
          function checkDepth(selections: any[], currentDepth: number): number {
            let maxFound = currentDepth;
            for (const sel of selections || []) {
              if (sel.kind === "Field" && sel.selectionSet?.selections) {
                const childDepth = checkDepth(sel.selectionSet.selections, currentDepth + 1);
                maxFound = Math.max(maxFound, childDepth);
              }
            }
            return maxFound;
          }

          let actualDepth = 0;
          for (const def of (document as any).definitions || []) {
            if (def.selectionSet?.selections) {
              const d = checkDepth(def.selectionSet.selections, 1);
              actualDepth = Math.max(actualDepth, d);
            }
          }

          if (actualDepth > maxDepth) {
            auditLogger.warn("SUSPICIOUS_ACTIVITY", {
              correlationId,
              reason: "Query exceeded maximum depth",
              depth: actualDepth,
              maxDepth,
              userId: user?.id,
            });

            throw new GraphQLError(
              `Query exceeds maximum depth of ${maxDepth}. Simplify your query.`,
              { extensions: { code: "QUERY_TOO_DEEP", maxDepth } },
            );
          }

          // ── Query Cost Analysis ──────────────────────
          const cost = calculateQueryCost(document as any);
          if (cost > costConfig.maxCost) {
            auditLogger.warn("SUSPICIOUS_ACTIVITY", {
              correlationId,
              reason: "Query exceeded maximum cost",
              cost,
              maxCost: costConfig.maxCost,
              userId: user?.id,
            });

            throw new GraphQLError(
              `Query too expensive (cost: ${cost}, max: ${costConfig.maxCost}).` +
              " Reduce the number of requested fields.",
              { extensions: { code: "QUERY_TOO_EXPENSIVE", cost, maxCost: costConfig.maxCost } },
            );
          }

          // ── Introspection Control ─────────────────────
          const isIntrospection = request.operationName === "IntrospectionQuery" ||
            (request.query?.includes("__schema") ?? false) ||
            (request.query?.includes("__type") ?? false);

          if (isIntrospection && !config.security.graphqlIntrospection) {
            throw new GraphQLError("Introspection is disabled in this environment.", {
              extensions: { code: "INTROSPECTION_DISABLED" },
            });
          }

          logger.debug({
            correlationId,
            operationName: request.operationName,
            duration: Date.now() - startTime,
            authenticated: isAuthenticated,
            userId: user?.id,
          }, "GraphQL request processed");
        },

        async didEncounterErrors({ errors }: { errors: readonly GraphQLError[] }) {
          for (const err of errors) {
            if (err instanceof AuthenticationError || err instanceof AuthorizationError) {
              auditLogger.warn("UNAUTHORIZED_ACCESS", {
                correlationId,
                error: err.message,
                userId: user?.id,
                code: (err as any).code,
              });
            }
          }
        },
      };
    },
  };
}
