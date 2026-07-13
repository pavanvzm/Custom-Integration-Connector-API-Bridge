import { z } from "zod";
import crypto from "node:crypto";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { EncryptionError } from "../utils/errors.js";

// ─── Encryption Configuration ────────────────────────────

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// Derive a 256-bit key from the configured encryption key
function deriveKey(): Buffer {
  const key = config.security.encryptionKey;
  if (!key || key.length < 16) {
    throw new EncryptionError(
      "Encryption key not configured or too short (minimum 16 characters)",
    );
  }
  // Use PBKDF2 to derive a strong 256-bit key
  return crypto.pbkdf2Sync(key, "api-bridge-salt", 100_000, 32, "sha256");
}

// ─── Encryption Engine ───────────────────────────────────

/**
 * AES-256-GCM encrypt a string. Returns base64-encoded ciphertext
 * with the IV and auth tag prepended.
 */
export function encrypt(plaintext: string): string {
  try {
    const key = deriveKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");

    // Format: iv:authTag:ciphertext (all hex-encoded)
    return `${iv.toString("hex")}:${authTag}:${encrypted}`;
  } catch (err) {
    logger.error({ err }, "Encryption failed");
    throw new EncryptionError("Failed to encrypt data");
  }
}

/**
 * Decrypt a string that was encrypted with encrypt().
 */
export function decrypt(ciphertext: string): string {
  try {
    const key = deriveKey();
    const parts = ciphertext.split(":");

    if (parts.length !== 3) {
      throw new EncryptionError("Invalid encrypted payload format");
    }

    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    logger.error({ err }, "Decryption failed");
    throw new EncryptionError("Failed to decrypt data");
  }
}

// ─── Sensitive Data Helpers ──────────────────────────────

/**
 * Encrypt sensitive configuration values (passwords, tokens).
 */
export function encryptSecret(value: string): string {
  return `enc:${encrypt(value)}`;
}

/**
 * Decrypt a value that was encrypted with encryptSecret().
 */
export function decryptSecret(encryptedValue: string): string {
  if (!encryptedValue.startsWith("enc:")) {
    return encryptedValue; // Not encrypted
  }
  return decrypt(encryptedValue.substring(4));
}

/**
 * Check if a string looks like an encrypted value.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith("enc:");
}

// ─── Payload Signing ─────────────────────────────────────

/**
 * Create an HMAC-SHA256 signature for a payload to verify
 * data integrity between bridge components.
 */
export function signPayload(payload: Record<string, unknown>): string {
  const key = config.security.jwtSecret;
  const data = JSON.stringify(payload);
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

/**
 * Verify an HMAC-SHA256 signature against a payload.
 */
export function verifyPayload(
  payload: Record<string, unknown>,
  signature: string,
): boolean {
  const expected = signPayload(payload);
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) return false;

  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}
