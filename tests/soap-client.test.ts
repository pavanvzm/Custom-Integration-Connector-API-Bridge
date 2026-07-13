import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SoapClient } from "../src/adapters/soap-client.js";

describe("SoapClient", () => {
  let client: SoapClient;

  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // Avoid random failures
    client = new SoapClient({
      wsdlUrl: "https://test.example.com/service?wsdl",
      username: "test",
      password: "test",
      timeoutMs: 5000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("connect / disconnect", () => {
    it("connects successfully", async () => {
      await client.connect();
      await expect(client.connect()).resolves.toBeUndefined();
    });

    it("disconnects successfully", async () => {
      await client.connect();
      await expect(client.disconnect()).resolves.toBeUndefined();
    });

    it("throws when calling getCustomers before connecting", async () => {
      await expect(client.getCustomers()).rejects.toThrow(
        /Upstream service/i,
      );
    });
  });

  describe("getCustomers", () => {
    beforeEach(async () => {
      await client.connect();
    });

    it("returns all customers when no since filter", async () => {
      const customers = await client.getCustomers();
      expect(Array.isArray(customers)).toBe(true);
      expect(customers.length).toBeGreaterThanOrEqual(2);
      expect(customers[0]).toHaveProperty("id");
      expect(customers[0]).toHaveProperty("name");
      expect(customers[0]).toHaveProperty("email");
      expect(customers[0]).toHaveProperty("accountNumber");
    });

    it("filters customers by updatedAt when since is provided", async () => {
      const customers = await client.getCustomers("2025-12-01T00:00:00Z");
      expect(customers.length).toBe(0);
    });

    it("returns customer with correct shape", async () => {
      const customers = await client.getCustomers();
      const customer = customers[0];
      expect(customer).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        email: expect.any(String),
        accountNumber: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });
  });

  describe("getInvoices", () => {
    beforeEach(async () => {
      await client.connect();
    });

    it("returns all invoices", async () => {
      const invoices = await client.getInvoices();
      expect(invoices.length).toBeGreaterThanOrEqual(3);
    });

    it("returns invoices with correct shape", async () => {
      const invoices = await client.getInvoices();
      const invoice = invoices[0];
      expect(invoice).toMatchObject({
        id: expect.any(String),
        customerId: expect.any(String),
        amount: expect.any(Number),
        currency: expect.any(String),
        status: expect.stringMatching(/^(pending|paid|overdue)$/),
        issuedAt: expect.any(String),
      });
    });
  });

  describe("upsertCustomer", () => {
    beforeEach(async () => {
      await client.connect();
    });

    it("creates or updates a customer", async () => {
      const result = await client.upsertCustomer({
        id: "SOAP-NEW",
        name: "New Co",
        email: "new@co.com",
        accountNumber: "ACC-NEW",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      });

      expect(result.id).toBe("SOAP-NEW");
      expect(result.name).toBe("New Co");
      expect(result.updatedAt).not.toBe("2025-01-01T00:00:00Z"); // updated
    });
  });

  describe("updateInvoiceStatus", () => {
    beforeEach(async () => {
      await client.connect();
    });

    it("updates invoice status without error", async () => {
      await expect(
        client.updateInvoiceStatus("INV-001", "paid"),
      ).resolves.toBeUndefined();
    });
  });
});
