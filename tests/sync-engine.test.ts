import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncEngine, SyncEventStore } from "../src/bridge/sync-engine.js";
import { SoapClient } from "../src/adapters/soap-client.js";
import { SqlAdapter } from "../src/adapters/sql-adapter.js";
import { RetryHandler } from "../src/middleware/retry.js";

describe("SyncEngine", () => {
  let syncEngine: SyncEngine;
  let eventStore: SyncEventStore;
  let soapClient: SoapClient;
  let sqlAdapter: SqlAdapter;

  beforeEach(async () => {
    soapClient = new SoapClient({
      wsdlUrl: "https://test.example.com/service?wsdl",
      username: "test",
      password: "test",
      timeoutMs: 5000,
    });
    await soapClient.connect();

    sqlAdapter = new SqlAdapter({
      connectionString: "postgresql://localhost:5432/test",
      schema: "public",
      timeoutMs: 5000,
    });
    await sqlAdapter.connect();

    // Mock retry to just pass through immediately
    const mockRetry = {
      execute: vi.fn(<T>(fn: () => Promise<T>) => fn()),
    } as unknown as RetryHandler;

    eventStore = new SyncEventStore();
    syncEngine = new SyncEngine(soapClient, sqlAdapter, mockRetry, eventStore);
  });

  describe("syncFromSoap", () => {
    it("syncs customers from SOAP to SaaS", async () => {
      const result = await syncEngine.syncFromSoap("customers");
      expect(result.success).toBe(true);
      expect(result.event).not.toBeNull();
      expect(result.event!.direction).toBe("LEGACY_TO_SAAS");
      expect(result.event!.source).toBe("SOAP");
      expect(result.event!.status).toBe("SUCCESS");
    });

    it("syncs invoices from SOAP to SaaS", async () => {
      const result = await syncEngine.syncFromSoap("invoices");
      expect(result.success).toBe(true);
      expect(result.event!.entityType).toBe("invoices");
    });

    it("returns error for unknown entity type", async () => {
      const result = await syncEngine.syncFromSoap("unknown");
      expect(result.success).toBe(false);
    });

    it("records event in the event store", async () => {
      await syncEngine.syncFromSoap("customers");
      const events = eventStore.getRecent(10);
      expect(events.length).toBe(1);
      expect(events[0].entityType).toBe("customers");
    });
  });

  describe("syncFromSql", () => {
    it("syncs records from SQL to SaaS", async () => {
      const result = await syncEngine.syncFromSql("customers");
      expect(result.success).toBe(true);
      expect(result.event!.direction).toBe("LEGACY_TO_SAAS");
      expect(result.event!.source).toBe("SQL");
    });

    it("syncs orders from SQL to SaaS", async () => {
      const result = await syncEngine.syncFromSql("orders");
      expect(result.success).toBe(true);
    });

    it("returns empty sync for unknown table", async () => {
      const result = await syncEngine.syncFromSql("nonexistent");
      expect(result.success).toBe(true);
      expect(result.event?.payload).toBeDefined();
    });
  });

  describe("pushToSoap", () => {
    it("pushes data to SOAP successfully", async () => {
      const result = await syncEngine.pushToSoap("SOAP-001", {
        name: "Updated Corp",
      });
      expect(result.success).toBe(true);
      expect(result.event!.direction).toBe("SAAS_TO_LEGACY");
      expect(result.event!.target).toBe("SOAP");
    });
  });

  describe("pushToSql", () => {
    it("pushes data to SQL successfully", async () => {
      const result = await syncEngine.pushToSql(
        "customers",
        "SQL-CUST-001",
        { tier: "enterprise" },
      );
      expect(result.success).toBe(true);
      expect(result.event!.direction).toBe("SAAS_TO_LEGACY");
      expect(result.event!.target).toBe("SQL");
    });
  });

  describe("bidirectionalSync", () => {
    it("successfully syncs a customer bidirectionally", async () => {
      const result = await syncEngine.bidirectionalSync(
        "customers",
        "SOAP-001",
      );
      expect(result.success).toBe(true);
      expect(result.event!.direction).toBe("BIDIRECTIONAL");
      expect(result.event!.source).toBe("SOAP+SQL");
    });

    it("returns error for unsupported entity type", async () => {
      const result = await syncEngine.bidirectionalSync(
        "orders",
        "ORD-001",
      );
      expect(result.success).toBe(false);
    });
  });

  describe("SyncEventStore", () => {
    it("stores and retrieves events", () => {
      const store = new SyncEventStore();
      const event = {
        id: "test-1",
        entityType: "customers",
        entityId: "1",
        direction: "LEGACY_TO_SAAS" as const,
        status: "SUCCESS" as const,
        source: "SOAP",
        target: "SaaS",
        payload: null,
        error: null,
        timestamp: new Date(),
        retryAttempt: null,
      };

      store.add(event);
      const events = store.getRecent(10);
      expect(events.length).toBe(1);
      expect(events[0].id).toBe("test-1");
    });

    it("returns events in reverse chronological order", () => {
      const store = new SyncEventStore();
      store.add({
        id: "1",
        entityType: "a",
        entityId: "1",
        direction: "LEGACY_TO_SAAS",
        status: "SUCCESS",
        source: "SOAP",
        target: "SaaS",
        payload: null,
        error: null,
        timestamp: new Date("2025-01-01"),
        retryAttempt: null,
      });
      store.add({
        id: "2",
        entityType: "b",
        entityId: "2",
        direction: "LEGACY_TO_SAAS",
        status: "SUCCESS",
        source: "SOAP",
        target: "SaaS",
        payload: null,
        error: null,
        timestamp: new Date("2025-01-02"),
        retryAttempt: null,
      });

      const events = store.getRecent(10);
      expect(events[0].id).toBe("2"); // Most recent first
      expect(events[1].id).toBe("1");
    });
  });
});
