/**
 * Shared-metadata hygiene: what may be persisted on a message and shown on shared timelines.
 * Pure and browser safe.
 */

import type { CareMessageMetadata } from '../../../_lib/care-kit/types.js';

const MAX_DEPTH = 12;

/**
 * Header/field names that denote the private BCC envelope (`Bcc`, `BCC`, `X-Original-Bcc`,
 * `resent-bcc`, `bccAddresses`...). Deliberately broad: privacy over false positives.
 */
function isBccKey(key: string): boolean {
  return /bcc/i.test(key);
}

/** Deep copy with every BCC-named key removed, case-insensitively, at any depth. */
function stripBcc(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((v) => stripBcc(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isBccKey(k)) continue;
      out[k] = stripBcc(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Returns metadata safe for persistence/shared DTOs: BCC recipients never enter a message
 * envelope. BCC lives only on the outbound delivery command of the account that sent it.
 */
export function sanitizeSharedMetadata(metadata: CareMessageMetadata): CareMessageMetadata {
  return stripBcc(metadata, 0) as CareMessageMetadata;
}
