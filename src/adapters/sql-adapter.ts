import { logger } from "../utils/logger.js";
import { UpstreamServiceError } from "../utils/errors.js";

// ─── Type Definitions ────────────────────────────────────────

export interface SqlRecord {
  id: string;
  tableName: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  durationMs: number;
}

export interface SqlAdapterConfig {
  connectionString: string;
  schema: string;
  timeoutMs: number;
}

// ─── Mock SQL Adapter ────────────────────────────────────────

const MOCK_TABLES: Record<string, Record<string, unknown>[]> = {
  customers: [
    { id: "SQL-CUST-001", name: "Database Co", email: "hello@dbco.com", tier: "premium", created_at: "2024-06-01T00:00:00Z", updated_at: "2025-11-10T08:00:00Z" },
    { id: "SQL-CUST-002", name: "Query Masters LLC", email: "support@querymasters.io", tier: "standard", created_at: "2024-09-15T00:00:00Z", updated_at: "2025-10-20T14:30:00Z" },
  ],
  orders: [
    { id: "ORD-001", customer_id: "SQL-CUST-001", total: 320.0, status: "shipped", order_date: "2025-10-01T10:00:00Z" },
    { id: "ORD-002", customer_id: "SQL-CUST-002", total: 150.0, status: "processing", order_date: "2025-11-05T16:45:00Z" },
  ],
};

export class SqlAdapter {
  private config: SqlAdapterConfig;
  private connected = false;

  constructor(config: SqlAdapterConfig) {
    this.config = config;
  }

  /**
   * Simulate connecting to a legacy SQL database.
   */
  async connect(): Promise<void> {
    logger.info({ schema: this.config.schema }, "SQL adapter connecting to legacy database");
    await new Promise((r) => setTimeout(r, 80));
    this.connected = true;
    logger.info("SQL adapter connected successfully");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info("SQL adapter disconnected");
  }

  /**
   * Query rows from a table, optionally filtered by updated_at.
   * In production, this would run actual SQL against a legacy database.
   */
  async query<T = Record<string, unknown>>(
    tableName: string,
    since?: string,
  ): Promise<SqlQueryResult<T>> {
    this.assertConnected();
    logger.debug({ tableName, since }, "SQL query");

    const start = Date.now();
    const table = MOCK_TABLES[tableName];
    if (!table) {
      return { rows: [], rowCount: 0, durationMs: Date.now() - start };
    }

    await new Promise((r) => setTimeout(r, 50 + Math.random() * 30));

    let rows = table;
    if (since) {
      rows = table.filter((row) => {
        const updatedAt = (row.updated_at as string) ?? (row.order_date as string);
        return updatedAt > since;
      });
    }

    return {
      rows: rows as T[],
      rowCount: rows.length,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Upsert a row into a table.
   */
  async upsert(tableName: string, id: string, data: Record<string, unknown>): Promise<void> {
    this.assertConnected();
    logger.info({ tableName, id }, "SQL upsert");
    await new Promise((r) => setTimeout(r, 80));
    if (!MOCK_TABLES[tableName]) {
      MOCK_TABLES[tableName] = [];
    }
    const idx = MOCK_TABLES[tableName].findIndex((r) => r.id === id);
    const record = { ...data, id, updated_at: new Date().toISOString() };
    if (idx >= 0) {
      MOCK_TABLES[tableName][idx] = record;
    } else {
      MOCK_TABLES[tableName].push(record);
    }
  }

  /**
   * Delete a row from a table.
   */
  async delete(tableName: string, id: string): Promise<void> {
    this.assertConnected();
    logger.info({ tableName, id }, "SQL delete");
    await new Promise((r) => setTimeout(r, 40));
    if (MOCK_TABLES[tableName]) {
      MOCK_TABLES[tableName] = MOCK_TABLES[tableName].filter((r) => r.id !== id);
    }
  }

  async executeRaw(sql: string): Promise<SqlQueryResult> {
    this.assertConnected();
    logger.debug({ sql: sql.substring(0, 80) }, "SQL executeRaw");
    // In production, this would execute arbitrary SQL
    await new Promise((r) => setTimeout(r, 30));
    return { rows: [], rowCount: 0, durationMs: 30 };
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new UpstreamServiceError("SQL", 0, "Adapter not connected. Call connect() first.");
    }
  }
}
