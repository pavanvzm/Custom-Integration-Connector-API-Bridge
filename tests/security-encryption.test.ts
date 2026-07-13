import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  encrypt,
  decrypt,
  encryptSecret,
  decryptSecret,
  isEncrypted,
  signPayload,
  verifyPayload,
} from "../src/security/encryption.js";

describe("Encryption", () => {
  describe("encrypt / decrypt", () => {
    it("encrypts and decrypts a string", () => {
      const original = "sensitive-data-123";
      const encrypted = encrypt(original);
      expect(encrypted).not.toBe(original);
      expect(encrypted.split(":").length).toBe(3); // iv:authTag:ciphertext

      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it("produces different ciphertexts for the same input (IV randomization)", () => {
      const input = "same data";
      const encrypted1 = encrypt(input);
      const encrypted2 = encrypt(input);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it("handles empty strings", () => {
      const encrypted = encrypt("");
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe("");
    });

    it("fails on tampered ciphertext", () => {
      const encrypted = encrypt("hello");
      const tampered = encrypted.replace(/^[^:]+/, "00'.repeat(8)");
      expect(() => decrypt(tampered)).toThrow();
    });
  });

  describe("encryptSecret / decryptSecret", () => {
    it("encrypts and decrypts with prefix", () => {
      const secret = "my-api-key-123";
      const encrypted = encryptSecret(secret);
      expect(encrypted.startsWith("enc:")).toBe(true);

      const decrypted = decryptSecret(encrypted);
      expect(decrypted).toBe(secret);
    });

    it("returns plaintext if not encrypted", () => {
      expect(decryptSecret("plain-text")).toBe("plain-text");
    });
  });

  describe("isEncrypted", () => {
    it("detects encrypted values", () => {
      expect(isEncrypted("enc:something")).toBe(true);
      expect(isEncrypted("plain")).toBe(false);
      expect(isEncrypted("")).toBe(false);
    });
  });

  describe("signPayload / verifyPayload", () => {
    it("signs and verifies a payload", () => {
      const payload = { id: "123", name: "Test" };
      const signature = signPayload(payload);
      expect(typeof signature).toBe("string");
      expect(signature.length).toBe(64); // SHA-256 hex

      expect(verifyPayload(payload, signature)).toBe(true);
    });

    it("fails verification on tampered payload", () => {
      const payload = { id: "123", name: "Test" };
      const signature = signPayload(payload);

      expect(verifyPayload({ id: "999", name: "Hacker" }, signature)).toBe(false);
    });

    it("fails verification if signature length differs (timing attack safe)", () => {
      expect(verifyPayload({ a: 1 }, "short")).toBe(false);
    });
  });
});
