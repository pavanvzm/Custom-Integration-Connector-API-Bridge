import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqlAdapter } from "../src/adapters/sql-adapter.js";

describe("SqlAdapter", () => {
  let adapter: SqlAdapter;

  beforeEach(() => {
    adapter = new SqlAdapter({
      connectionString: "postgresql://localhost:5432/test",
      schema: "public",
      timeoutMs: 5000,
    });
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe("connect / disconnect", () => {
    it("connects successfully", async () => {
      await expect(adapter.connect()).resolves.toBeUndefined();
    });

    it("disconnects successfully", async () => {
      await adapter.connect();
      await expect(adapter.disconnect()).resolves.toBeUndefined();
    });

    it("throws when querying before connecting", async () => {
      await expect(adapter.query("customers")).rejects.toThrow(
        /Upstream service/i,
      );
    });
  });

  describe("query", () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it("returns rows for customers table", async () => {
      const result = await adapter.query("customers");
      expect(result.rows.length).toBe(2);
      expect(result.rowCount).toBe(2);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it("returns rows for orders table", async () => {
      const result = await adapter.query("orders");
      expect(result.rows.length).toBe(2);
    });

    it("returns empty for unknown table", async () => {
      const result = await adapter.query("nonexistent");
      expect(result.rows.length).toBe(0);
      expect(result.rowCount).toBe(0);
    });

    it("filters rows by since parameter", async () => {
      // All mock data is from 2025, so filtering by 2026 should return nothing
      const result = await adapter.query("customers", "2026-01-01T00:00:00Z");
      expect(result.rows.length).toBe(0);
    });

    it("returns correct customer shape", async () => {
      const result = await adapter.query("customers");
      const customer = result.rows[0] as Record<string, unknown>;
      expect(customer).toHaveProperty("id");
      expect(customer).toHaveProperty("name");
      expect(customer).toHaveProperty("email");
      expect(customer).toHaveProperty("tier");
    });
  });

  describe("upsert", () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it("creates a new record", async () => {
      await adapter.upsert("customers", "SQL-CUST-NEW", {
        name: "New Customer",
        email: "new@test.com",
        tier: "basic",
      });

      const result = await adapter.query("customers");
      const found = result.rows.find(
        (r: any) => r.id === "SQL-CUST-NEW",
      );
      expect(found).toBeDefined();
      expect((found as any).name).toBe("New Customer");
    });

    it("updates an existing record", async () => {
      await adapter.upsert("customers", "SQL-CUST-001", {
        name: "Updated Corp",
        email: "updated@corp.com",
        tier: "enterprise",
      });

      const result = await adapter.query("customers");
      const found = result.rows.find(
        (r: any) => r.id === "SQL-CUST-001",
      );
      expect((found as any).name).toBe("Updated Corp");
      expect((found as any).tier).toBe("enterprise");
    });
  });

  describe("delete", () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it("deletes a record", async () => {
      // First check initial count
      const before = await adapter.query("customers");
      const initialCount = before.rows.length;

      await adapter.delete("customers", "SQL-CUST-001");

      const result = await adapter.query("customers");
      const found = result.rows.find(
        (r: any) => r.id === "SQL-CUST-001",
      );
      expect(found).toBeUndefined();
      expect(result.rows.length).toBe(initialCount - 1);
    });
  });

  describe("executeRaw", () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it("executes raw SQL without error", async () => {
      const result = await adapter.executeRaw("SELECT 1");
      expect(result.rows).toEqual([]);
      expect(result.durationMs).toBeGreaterThan(0);
    });
  });
});
