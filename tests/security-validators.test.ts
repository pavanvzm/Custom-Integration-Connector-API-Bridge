import { describe, it, expect } from "vitest";
import {
  syncFromSoapSchema,
  syncFromSqlSchema,
  pushToSoapSchema,
  pushToSqlSchema,
  sanitizeInput,
  maskSensitiveData,
} from "../src/security/validators.js";
import { ZodError } from "zod";

describe("Validators", () => {
  describe("syncFromSoapSchema", () => {
    it("accepts valid input", () => {
      const result = syncFromSoapSchema.parse({
        entityType: "customers",
        since: "2025-01-01T00:00:00Z",
      });
      expect(result.entityType).toBe("customers");
    });

    it("rejects invalid entity type", () => {
      expect(() =>
        syncFromSoapSchema.parse({ entityType: "invalid" }),
      ).toThrow(ZodError);
    });

    it("accepts optional since field", () => {
      const result = syncFromSoapSchema.parse({ entityType: "invoices" });
      expect(result.since).toBeUndefined();
    });
  });

  describe("syncFromSqlSchema", () => {
    it("accepts valid table name", () => {
      const result = syncFromSqlSchema.parse({ tableName: "customers" });
      expect(result.tableName).toBe("customers");
    });

    it("rejects table name with SQL injection patterns", () => {
      expect(() =>
        syncFromSqlSchema.parse({ tableName: "customers; DROP TABLE users;" }),
      ).toThrow(ZodError);
    });

    it("rejects empty table name", () => {
      expect(() =>
        syncFromSqlSchema.parse({ tableName: "" }),
      ).toThrow(ZodError);
    });
  });

  describe("pushToSoapSchema", () => {
    it("accepts valid payload", () => {
      const result = pushToSoapSchema.parse({
        customerId: "SOAP-001",
        data: { name: "Test Corp" },
      });
      expect(result.customerId).toBe("SOAP-001");
    });

    it("accepts empty data payload (validated at resolver level)", () => {
      const result = pushToSoapSchema.parse({
        customerId: "SOAP-001",
        data: {},
      });
      expect(result.customerId).toBe("SOAP-001");
      expect(result.data).toEqual({});
    });
  });

  describe("pushToSqlSchema", () => {
    it("accepts valid input with table name", () => {
      const result = pushToSqlSchema.parse({
        tableName: "customers",
        id: "CUST-001",
        data: { name: "Test" },
      });
      expect(result.tableName).toBe("customers");
    });

    it("rejects table name with special characters", () => {
      expect(() =>
        pushToSqlSchema.parse({
          tableName: "customers; DELETE",
          id: "1",
          data: { name: "test" },
        }),
      ).toThrow(ZodError);
    });
  });
});

describe("sanitizeInput", () => {
  it("strips HTML tags from strings", () => {
    expect(sanitizeInput("<script>alert('xss')</script>hello")).toBe("alert('xss')hello");
  });

  it("strips event handlers", () => {
    expect(sanitizeInput("click onmouseover=alert(1)")).toContain("has_event");
  });

  it("trims whitespace", () => {
    expect(sanitizeInput("  hello world  ")).toBe("hello world");
  });

  it("recursively sanitizes objects", () => {
    const input = {
      name: "<b>Corp</b>",
      email: "  test@test.com  ",
      nested: { field: "<script>bad</script>" },
    };
    const result = sanitizeInput(input);
    expect(result.name).toBe("Corp");
    expect(result.email).toBe("test@test.com");
    expect(result.nested.field).toBe("bad");
  });

  it("handles arrays", () => {
    const result = sanitizeInput(["<a>one</a>", "<b>two</b>"]);
    expect(result).toEqual(["one", "two"]);
  });
});

describe("maskSensitiveData", () => {
  it("masks sensitive fields", () => {
    const data = {
      name: "Test",
      password: "secret123",
      apiKey: "sk-123456",
      email: "test@test.com",
    };
    const masked = maskSensitiveData(data);
    expect(masked.name).toBe("Test");
    expect(masked.password).toBe("***REDACTED***");
    expect(masked.apiKey).toBe("***REDACTED***");
    expect(masked.email).toBe("***REDACTED***");
  });

  it("recursively masks nested sensitive fields", () => {
    const data = {
      user: { name: "Test", password: "secret" },
      config: { apiKey: "sk-test" },
    };
    const masked = maskSensitiveData(data);
    expect((masked as any).user.name).toBe("Test");
    expect((masked as any).user.password).toBe("***REDACTED***");
    expect((masked as any).config.apiKey).toBe("***REDACTED***");
  });
});
