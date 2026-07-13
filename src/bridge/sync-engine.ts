import { EventEmitter } from "node:events";
import { v4 as uuidv4 } from "uuid";
import { SoapClient } from "../adapters/soap-client.js";
import { SqlAdapter } from "../adapters/sql-adapter.js";
import { RetryHandler } from "../middleware/retry.js";
import { logger } from "../utils/logger.js";
import { SyncConflictError } from "../utils/errors.js";

// ─── Types ────────────────────────────────────────────────────

export interface SyncEvent {
  id: string;
  entityType: string;
  entityId: string;
  direction: "LEGACY_TO_SAAS" | "SAAS_TO_LEGACY" | "BIDIRECTIONAL";
  status: "SUCCESS" | "CONFLICT" | "FAILED" | "PENDING";
  source: string;
  target: string;
  payload: Record<string, unknown> | null;
  error: string | null;
  timestamp: Date;
  retryAttempt: number | null;
}

export type SyncResult =
  | { success: true; event: SyncEvent; message: string }
  | { success: false; event: SyncEvent | null; message: string };

// ─── In-memory event store (swap with DB in production) ──────

export class SyncEventStore {
  private events: SyncEvent[] = [];

  add(event: SyncEvent): void {
    this.events.push(event);
    // Keep last 1000 events in memory
    if (this.events.length > 1000) {
      this.events = this.events.slice(-500);
    }
  }

  getRecent(limit: number): SyncEvent[] {
    return this.events.slice(-limit).reverse();
  }
}

// ─── Sync Engine ──────────────────────────────────────────────

export class SyncEngine extends EventEmitter {
  private soapClient: SoapClient;
  private sqlAdapter: SqlAdapter;
  private retryHandler: RetryHandler;
  private eventStore: SyncEventStore;

  constructor(
    soapClient: SoapClient,
    sqlAdapter: SqlAdapter,
    retryHandler: RetryHandler,
    eventStore: SyncEventStore,
  ) {
    super();
    this.soapClient = soapClient;
    this.sqlAdapter = sqlAdapter;
    this.retryHandler = retryHandler;
    this.eventStore = eventStore;
  }

  // ─── SOAP → SaaS (modern system) ───────────────────────────

  async syncFromSoap(entityType: string, since?: string): Promise<SyncResult> {
    const startTime = Date.now();
    logger.info({ entityType, since }, "Syncing from SOAP to SaaS");

    try {
      let payload: Record<string, unknown> | null = null;

      if (entityType === "customers") {
        const customers = await this.retryHandler.execute(
          () => this.soapClient.getCustomers(since),
          { operationName: "syncFromSoap", entityId: entityType },
        );

        // Simulate pushing to a modern SaaS API
        for (const customer of customers) {
          logger.info({ customerId: customer.id }, "Pushed SOAP customer to SaaS");
        }

        payload = { syncedCount: customers.length, customers };
      } else if (entityType === "invoices") {
        const invoices = await this.retryHandler.execute(
          () => this.soapClient.getInvoices(since),
          { operationName: "syncFromSoap", entityId: entityType },
        );

        for (const invoice of invoices) {
          logger.info({ invoiceId: invoice.id }, "Pushed SOAP invoice to SaaS");
        }

        payload = { syncedCount: invoices.length, invoices };
      } else {
        return {
          success: false,
          event: null,
          message: `Unknown entity type: ${entityType}. Supported: customers, invoices`,
        };
      }

      const event: SyncEvent = {
        id: uuidv4(),
        entityType,
        entityId: entityType,
        direction: "LEGACY_TO_SAAS",
        status: "SUCCESS",
        source: "SOAP",
        target: "SaaS",
        payload,
        error: null,
        timestamp: new Date(),
        retryAttempt: null,
      };

      this.eventStore.add(event);
      this.emit("syncEvent", event);

      return {
        success: true,
        event,
        message: `Synced ${payload.syncedCount} ${entityType} from SOAP to SaaS in ${Date.now() - startTime}ms`,
      };
    } catch (err) {
      const event: SyncEvent = {
        id: uuidv4(),
        entityType,
        entityId: entityType,
        direction: "LEGACY_TO_SAAS",
        status: "FAILED",
        source: "SOAP",
        target: "SaaS",
        payload: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        timestamp: new Date(),
        retryAttempt: null,
      };

      this.eventStore.add(event);
      this.emit("syncEvent", event);

      return { success: false, event, message: event.error! };
    }
  }

  // ─── SQL → SaaS (modern system) ────────────────────────────

  async syncFromSql(tableName: string, since?: string): Promise<SyncResult> {
    const startTime = Date.now();
    logger.info({ tableName, since }, "Syncing from SQL to SaaS");

    try {
      const result = await this.retryHandler.execute(
        () => this.sqlAdapter.query(tableName, since),
        { operationName: "syncFromSql", entityId: tableName },
      );

      // Simulate pushing to a modern SaaS API
      for (const row of result.rows) {
        logger.info({ rowId: (row as Record<string, unknown>).id }, "Pushed SQL record to SaaS");
      }

      const event: SyncEvent = {
        id: uuidv4(),
        entityType: tableName,
        entityId: tableName,
        direction: "LEGACY_TO_SAAS",
        status: "SUCCESS",
        source: "SQL",
        target: "SaaS",
        payload: { syncedCount: result.rowCount, rows: result.rows },
        error: null,
        timestamp: new Date(),
        retryAttempt: null,
      };

      this.eventStore.add(event);
      this.emit("syncEvent", event);

      return {
        success: true,
        event,
        message: `Synced ${result.rowCount} records from SQL table "${tableName}" to SaaS in ${Date.now() - startTime}ms`,
      };
    } catch (err) {
      const event: SyncEvent = {
        id: uuidv4(),
        entityType: tableName,
        entityId: tableName,
        direction: "LEGACY_TO_SAAS",
        status: "FAILED",
        source: "SQL",
        target: "SaaS",
        payload: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        timestamp: new Date(),
        retryAttempt: null,
      };

      this.eventStore.add(event);
      this.emit("syncEvent", event);

      return { success: false, event, message: event.error! };
    }
  }

  // ─── SaaS → SOAP (push back) ───────────────────────────────

  async pushToSoap(customerId: string, data: Record<string, unknown>): Promise<SyncResult> {
    logger.info({ customerId, data }, "Pushing data to SOAP");

    try {
      await this.retryHandler.execute(
        () =>
          this.soapClient.upsertCustomer(data as any),
        { operationName: "pushToSoap", entityId: customerId },
      );

      const event: SyncEvent = {
        id: uuidv4(),
        entityType: "customers",
        entityId: customerId,
        direction: "SAAS_TO_LEGACY",
        status: "SUCCESS",
        source: "SaaS",
        target: "SOAP",
        payload: { data },
        error: null,
        timestamp: new Date(),
        retryAttempt: null,
      };

      this.eventStore.add(event);
      this.emit("syncEvent", event);

      return { success: true, event, message: `Pushed customer ${customerId} to SOAP` };
    } catch (err) {
      const event: SyncEvent = {
        id: uuidv4(),
        entityType: "customers",
        entityId: customerId,
        direction: "SAAS_TO_LEGACY",
        status: "FAILED",
        source: "SaaS",
        target: "SOAP",
        payload: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        timestamp: new Date(),
        retryAttempt: null,
      };

      this.eventStore.add(event);
      this.emit("syncEvent", event);

      return { success: false, event, message: event.error! };
    }
  }

  // ─── SaaS → SQL (push back) ────────────────────────────────

  async pushToSql(tableName: string, id: string, data: Record<string, unknown>): Promise<SyncResult> {
    logger.info({ tableName, id }, "Pushing data to SQL");

    try {
      await this.retryHandler.execute(
        () => this.sqlAdapter.upsert(tableName, id, data),
        { operationName: "pushToSql", entityId: id },
      );

      const event: SyncEvent = {
        id: uuidv4(),
        entityType: tableName,
        entityId: id,
        direction: "SAAS_TO_LEGACY",
        status: "SUCCESS",
        source: "SaaS",
        target: "SQL",
        payload: { data },
        error: null,
        timestamp: new Date(),
        retryAttempt: null,
      };

      this.eventStore.add(event);
      this.emit("syncEvent", event);

      return { success: true, event, message: `Pushed record ${id} to SQL table ${tableName}` };
    } catch (err) {
      const event: SyncEvent = {
        id: uuidv4(),
        entityType: tableName,
        entityId: id,
        direction: "SAAS_TO_LEGACY",
        status: "FAILED",
        source: "SaaS",
        target: "SQL",
        payload: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        timestamp: new Date(),
        retryAttempt: null,
      };

      this.eventStore.add(event);
      this.emit("syncEvent", event);

      return { success: false, event, message: event.error! };
    }
  }

  // ─── Bidirectional Sync ─────────────────────────────────────

  async bidirectionalSync(entityType: string, entityId: string): Promise<SyncResult> {
    logger.info({ entityType, entityId }, "Running bidirectional sync");

    try {
      // Phase 1: Read from legacy sources
      let legacyData: Record<string, unknown> | null = null;

      if (entityType === "customers") {
        const soapCustomers = await this.retryHandler.execute(
          () => this.soapClient.getCustomers(),
          { operationName: "bidirectionalSync", entityId },
        );
        const soapCustomer = soapCustomers.find((c) => c.id === entityId);

        const sqlResult = await this.retryHandler.execute(
          () => this.sqlAdapter.query("customers"),
          { operationName: "bidirectionalSync", entityId },
        );
        const sqlCustomer = sqlResult.rows.find(
          (r: any) => r.id === entityId,
        );

        // Phase 2: Detect conflicts
        if (soapCustomer && sqlCustomer) {
          const soapUpdated = new Date(soapCustomer.updatedAt).getTime();
          const sqlUpdated = new Date((sqlCustomer as any).updated_at as string).getTime();
          const diffMs = Math.abs(soapUpdated - sqlUpdated);

          if (diffMs < 1000) {
            // No meaningful conflict — data is in sync
            legacyData = { source: "SOAP+SQL", ...soapCustomer, ...sqlCustomer };
          } else {
            const newerSource = soapUpdated > sqlUpdated ? "SOAP" : "SQL";
            legacyData = { source: newerSource, ...(soapUpdated > sqlUpdated ? soapCustomer : sqlCustomer) };
            logger.warn({ entityId, newerSource }, "Bidirectional sync resolved conflict — using newer source");
          }
        } else {
          legacyData = soapCustomer ?? (sqlCustomer as any) ?? null;
        }
      } else {
        return { success: false, event: null, message: `Bidirectional sync not implemented for ${entityType}` };
      }

      // Phase 3: Push merged data to SaaS (simulated)
      if (legacyData) {
        logger.info({ entityId, entityType, legacyData }, "Pushed merged data to SaaS");
      }

      const event: SyncEvent = {
        id: uuidv4(),
        entityType,
        entityId,
        direction: "BIDIRECTIONAL",
        status: "SUCCESS",
        source: "SOAP+SQL",
        target: "SaaS",
        payload: { mergedData: legacyData },
        error: null,
        timestamp: new Date(),
        retryAttempt: null,
      };

      this.eventStore.add(event);
      this.emit("syncEvent", event);

      return { success: true, event, message: `Bidirectional sync completed for ${entityType} ${entityId}` };
    } catch (err) {
      const event: SyncEvent = {
        id: uuidv4(),
        entityType,
        entityId,
        direction: "BIDIRECTIONAL",
        status: "FAILED",
        source: "SOAP+SQL",
        target: "SaaS",
        payload: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        timestamp: new Date(),
        retryAttempt: null,
      };

      this.eventStore.add(event);
      this.emit("syncEvent", event);

      return { success: false, event, message: event.error! };
    }
  }
}
