/**
 * Customer Care Field-Level Encryption & Credential Security
 * AES-256-GCM encryption with strict fail-closed validation for credentials, sessions, and care data.
 * Zero implicit fallbacks, exact 32-byte keys only.
 */

import crypto from 'node:crypto';
import { CareError } from '../../../_lib/care-kit/errors.js';

const HEX_REGEX = /^[0-9a-fA-F]*$/;

/**
 * Marker for "the runtime could not obtain a strict Care key". Stores bound to it stay
 * constructible (so unrelated source behaviour is unaffected) but every encrypt/decrypt
 * throws CREDENTIAL_DECODE_FAILED: Care fails closed, it never degrades to a weaker key.
 */
export interface CareKeyUnavailable {
  readonly unavailable: true;
  readonly reason: string;
}

export type CareKeyInput = Buffer | string | CareKeyUnavailable;

export function createUnavailableCareKey(reason: string): CareKeyUnavailable {
  return { unavailable: true, reason };
}

function isUnavailable(key: unknown): key is CareKeyUnavailable {
  return typeof key === 'object' && key !== null && !Buffer.isBuffer(key) && (key as CareKeyUnavailable).unavailable === true;
}

/**
 * Resolves a 32-byte encryption key.
 * An explicitly provided key (even an empty string/buffer) is validated on its own and NEVER
 * falls through to the environment. Only `undefined` consults process.env.DB_ENCRYPTION_KEY,
 * which must be 64 valid hex chars. No implicit test fallbacks, no hashing/derivation.
 */
export function resolveEncryptionKey(explicitKey?: CareKeyInput): Buffer {
  if (explicitKey !== undefined && explicitKey !== null) {
    if (isUnavailable(explicitKey)) {
      throw new CareError('CREDENTIAL_DECODE_FAILED', `Care encryption key unavailable: ${explicitKey.reason}`, 500);
    }
    if (Buffer.isBuffer(explicitKey)) {
      if (explicitKey.length !== 32) {
        throw new CareError('CREDENTIAL_DECODE_FAILED', `Explicit encryption key Buffer must be exactly 32 bytes (got ${explicitKey.length})`, 500);
      }
      return explicitKey;
    }
    if (typeof explicitKey === 'string') {
      const clean = explicitKey.trim();
      if (clean.length !== 64 || !HEX_REGEX.test(clean)) {
        throw new CareError('CREDENTIAL_DECODE_FAILED', 'Explicit encryption key hex string must be exactly 64 valid hex characters', 500);
      }
      return Buffer.from(clean, 'hex');
    }
    throw new CareError('CREDENTIAL_DECODE_FAILED', 'Explicit encryption key must be a Buffer or hex string', 500);
  }

  const envKey = process.env.DB_ENCRYPTION_KEY?.trim();
  if (!envKey) {
    throw new CareError(
      'CREDENTIAL_DECODE_FAILED',
      'DB_ENCRYPTION_KEY environment variable is missing. A 64-character hex key (32 bytes) is required.',
      500,
    );
  }

  if (envKey.length !== 64 || !HEX_REGEX.test(envKey)) {
    throw new CareError(
      'CREDENTIAL_DECODE_FAILED',
      'DB_ENCRYPTION_KEY must be exactly 64 valid hex characters (32 bytes). Implicit derivation/hashing is disallowed.',
      500,
    );
  }

  return Buffer.from(envKey, 'hex');
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Output format: iv:authTag:ciphertext (hex-encoded)
 * Supports empty plaintext (empty ciphertext hex segment).
 */
export function encryptCareField(plaintext: string, explicitKey?: CareKeyInput): string {
  if (typeof plaintext !== 'string') {
    throw new CareError('CREDENTIAL_DECODE_FAILED', 'Plaintext to encrypt must be a string', 500);
  }

  const key = resolveEncryptionKey(explicitKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Strict decryption for Care fields, sessions, credentials, and bodies.
 * FAILS CLOSED on any tampering, invalid auth tag, bad key, or malformed segments.
 * Empty ciphertext hex segment decodes to empty string ("").
 */
export function decryptCareFieldStrict(ciphertext: string, explicitKey?: CareKeyInput): string {
  if (typeof ciphertext !== 'string' || !ciphertext) {
    throw new CareError('CREDENTIAL_DECODE_FAILED', 'Ciphertext is missing or not a string', 500);
  }

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new CareError('CREDENTIAL_DECODE_FAILED', 'Malformed ciphertext: expected iv:authTag:ciphertext', 500);
  }

  const [ivHex, authTagHex, dataHex] = parts;

  // Strict length and hex character verification
  if (ivHex.length !== 24 || !HEX_REGEX.test(ivHex)) {
    throw new CareError('CREDENTIAL_DECODE_FAILED', 'Invalid IV: must be 24 hex characters (12 bytes)', 500);
  }
  if (authTagHex.length !== 32 || !HEX_REGEX.test(authTagHex)) {
    throw new CareError('CREDENTIAL_DECODE_FAILED', 'Invalid AuthTag: must be 32 hex characters (16 bytes)', 500);
  }
  // Buffer.from(hex) silently truncates a trailing nibble; reject odd lengths up front.
  if (dataHex.length % 2 !== 0 || !HEX_REGEX.test(dataHex)) {
    throw new CareError('CREDENTIAL_DECODE_FAILED', 'Invalid data segment: must be an even number of hex characters', 500);
  }

  try {
    const key = resolveEncryptionKey(explicitKey);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    if (err instanceof CareError) throw err;
    throw new CareError(
      'CREDENTIAL_DECODE_FAILED',
      `Strict decryption failed (tampered ciphertext or invalid key): ${(err as Error).message}`,
      500,
    );
  }
}

/**
 * Mask secrets for DTOs and logs so that no plaintext credentials leak.
 */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 3)}...${secret.slice(-3)}`;
}

/** Encrypt a JSON-serialisable value (stable `JSON.stringify`). */
export function encryptCareJson(value: unknown, explicitKey?: CareKeyInput): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new CareError('INVALID_COMMAND', 'Value is not JSON serialisable', 400);
  }
  return encryptCareField(json, explicitKey);
}

/** Strict decrypt + parse. Malformed JSON after a valid auth tag is corruption, not a fallback. */
export function decryptCareJson<T = unknown>(ciphertext: string, explicitKey?: CareKeyInput): T {
  const json = decryptCareFieldStrict(ciphertext, explicitKey);
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new CareError('CREDENTIAL_DECODE_FAILED', 'Decrypted payload is not valid JSON', 500);
  }
}

/** Encrypt nullable text (null stays NULL so absence is not a ciphertext). */
export function encryptNullable(plaintext: string | null | undefined, explicitKey?: CareKeyInput): string | null {
  return plaintext === null || plaintext === undefined ? null : encryptCareField(plaintext, explicitKey);
}

export function decryptNullable(ciphertext: string | null | undefined, explicitKey?: CareKeyInput): string | null {
  return ciphertext === null || ciphertext === undefined ? null : decryptCareFieldStrict(ciphertext, explicitKey);
}
