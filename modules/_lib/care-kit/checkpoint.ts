/**
 * Adapter-owned causal ordering primitives: native versions, checkpoint positions and boxes.
 * Pure data + BigInt arithmetic only (browser safe, no Node/provider imports).
 *
 * Core never guesses the order of an opaque cursor. An adapter either supplies a causal
 * position (digits or dotted digits, compared as BigInt segments), supplies the cursor it
 * expects to replace (compare-and-set), or the update is rejected.
 */

import type { CareChannel } from './types.js';

const DOTTED_NUMERIC = /^\d+(\.\d+)*$/;
const MAX_ORDER_TOKEN_LENGTH = 64;

/** True when the token is a validated causal number (`"10"`, `"3.14.2"`). */
export function isCausalOrderToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ORDER_TOKEN_LENGTH &&
    DOTTED_NUMERIC.test(value)
  );
}

/**
 * Compares two validated causal order tokens segment by segment as BigInt (no Number
 * precision loss, no lexical ordering). Returns null when either side is not a validated
 * token, i.e. the pair is UNORDERED and the caller must not infer an order from arrival time.
 */
export function compareCausalOrder(a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null {
  if (!isCausalOrderToken(a) || !isCausalOrderToken(b)) return null;
  const pa = a.split('.').map((s) => BigInt(s));
  const pb = b.split('.').map((s) => BigInt(s));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0n;
    const y = pb[i] ?? 0n;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** Native message versions share the same causal ordering rules as checkpoint positions. */
export const compareNativeVersions = compareCausalOrder;

/**
 * A checkpoint is owned by the adapter and addressed by a channel-congruent box:
 *   zalo_chat | zalo_thread:<id>
 *   telegram_common_box | telegram_channel_box:<channelId>
 *   gmail_mailbox
 * The box is the *update state* box, distinct from the message-ID namespace of any message.
 */
export interface CareCheckpoint {
  namespace: string;
  /** Opaque adapter cursor. Core never parses it. */
  cursor: string;
  /** Adapter-supplied causal position (e.g. Telegram pts, Gmail historyId). */
  position?: string | null;
  /**
   * Compare-and-set guard: the cursor the adapter believes is currently stored for this box.
   * `null` means "the box must not have a checkpoint yet".
   */
  expectedCursor?: string | null;
  /** Compare-and-set on the stored checkpoint revision (0 = the box must not have a checkpoint yet). */
  expectedRevision?: number;
}

const CHECKPOINT_BOX_PATTERNS: Record<CareChannel, RegExp[]> = {
  zalo: [/^zalo_chat$/, /^zalo_thread:[A-Za-z0-9._@-]{1,128}$/],
  telegram: [/^telegram_common_box$/, /^telegram_channel_box:\d{1,20}$/],
  email: [/^gmail_mailbox$/],
};

const MESSAGE_NAMESPACE_PATTERNS: Record<CareChannel, RegExp[]> = {
  zalo: [/^zalo_chat$/],
  telegram: [/^telegram_common_box$/, /^telegram_channel_box:\d{1,20}$/],
  email: [/^gmail_mailbox$/],
};

export function isValidCheckpointBox(channel: CareChannel, namespace: unknown): namespace is string {
  return typeof namespace === 'string' && (CHECKPOINT_BOX_PATTERNS[channel] ?? []).some((re) => re.test(namespace));
}

export function isValidMessageNamespace(channel: CareChannel, namespace: unknown): namespace is string {
  return typeof namespace === 'string' && (MESSAGE_NAMESPACE_PATTERNS[channel] ?? []).some((re) => re.test(namespace));
}

// ── Native message order (adapter-owned coverage) ───────────────────────────────────────────
//
// Local canonical IDs are random UUIDs and carry NO chronology. Whenever core must decide
// "was message A before message B" (read coverage, which reply answers which question) it uses,
// in this order: the adapter's native order token (same namespace only), explicit reply
// linkage, and finally strictly-different timestamps. Equal timestamps without native order are
// UNORDERED and are resolved conservatively (never as "covered"/"answered").

const NATIVE_ORDER_PATTERN = /^\d{1,40}$/;
const NATIVE_ORDER_KEY_WIDTH = 40;

export function isNativeOrderToken(value: unknown): value is string {
  return typeof value === 'string' && NATIVE_ORDER_PATTERN.test(value);
}

/** Fixed-width key so plain string comparison equals numeric comparison (SQLite-sortable). */
export function nativeOrderKey(token: string): string {
  return token.padStart(NATIVE_ORDER_KEY_WIDTH, '0');
}

const MONOTONIC_ID_NAMESPACES = [/^telegram_common_box$/, /^telegram_channel_box:\d{1,20}$/];

/**
 * Native order key of a message. An explicit adapter token wins. Otherwise only namespaces whose
 * IDs the provider guarantees monotonic (Telegram message boxes) derive it from the native ID.
 * Zalo and Gmail IDs are opaque: they have NO derived order and need an explicit token.
 */
export function deriveNativeOrderKey(
  namespace: string,
  nativeMessageId: string,
  explicitToken?: string | null,
): string | null {
  if (explicitToken !== undefined && explicitToken !== null) {
    return isNativeOrderToken(explicitToken) ? nativeOrderKey(explicitToken) : null;
  }
  if (MONOTONIC_ID_NAMESPACES.some((re) => re.test(namespace)) && isNativeOrderToken(nativeMessageId)) {
    return nativeOrderKey(nativeMessageId);
  }
  return null;
}

/** True when the namespace's IDs are provider-monotonic (an unseen target can still be ordered). */
export function hasMonotonicNativeIds(namespace: string): boolean {
  return MONOTONIC_ID_NAMESPACES.some((re) => re.test(namespace));
}
