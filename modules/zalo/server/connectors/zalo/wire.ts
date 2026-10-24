/**
 * Quote and seen-marker targets built from the CANONICAL message (text + `rawEnvelope.wire` stored at ingest), never from
 * the legacy `zalo_messages` columns (which keep no ts/ttl). Pure; every function answers null unless EVERY field the
 * provider payload needs is present and well-formed, so a message without enough data is never quoted/marked "best
 * effort": the caller refuses (UNSUPPORTED_CAPABILITY => review). NOT verified against the native Zalo service: the field
 * mapping follows the zca-js types (`SendMessageQuote`, `SendSeenEventMessageParams`) and is exercised with fakes only.
 */
import type { ZaloQuoteTarget, ZaloSeenTarget, ZaloThreadKind } from './transport.js';

/** What the connector needs to know about one stored message (decrypted by the caller, which owns the store). */
export interface StoredZaloMessage {
  nativeMessageId: string;
  /** Canonical text. For a text message this IS the Zalo content string. */
  text: string;
  direction: 'in' | 'out';
  metadata: { rawEnvelope?: Record<string, unknown> | undefined; [k: string]: unknown };
}

const DIGITS = /^\d{1,40}$/;

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function envelopeOf(m: StoredZaloMessage): { env: Record<string, unknown>; wire: Record<string, unknown> } | null {
  const env = m.metadata?.rawEnvelope;
  if (!env || typeof env !== 'object') return null;
  const wire = (env as Record<string, unknown>).wire;
  if (!wire || typeof wire !== 'object') return null;
  return { env: env as Record<string, unknown>, wire: wire as Record<string, unknown> };
}

/** Quote target of a plain TEXT message (other content types need their structured content: not supported). */
export function quoteTargetOf(m: StoredZaloMessage | null | undefined): ZaloQuoteTarget | null {
  if (!m || !isStr(m.text)) return null;
  const e = envelopeOf(m);
  if (!e) return null;
  const { env, wire } = e;
  const msgId = env.zaloMsgId;
  const cliMsgId = env.cliMsgId;
  // the native id must be the real Zalo msgId (a `cli:` fallback id is not what the quote payload carries)
  if (!isStr(msgId) || !DIGITS.test(msgId) || m.nativeMessageId !== msgId) return null;
  if (!isStr(cliMsgId) || !DIGITS.test(cliMsgId)) return null;
  if (env.contentType !== 'text') return null;
  if (!isStr(wire.uidFrom) || !isStr(wire.ts) || !isNonNegInt(wire.ttl) || !isStr(wire.msgType)) return null;
  return {
    msgId,
    cliMsgId,
    uidFrom: wire.uidFrom,
    ts: wire.ts,
    ttl: wire.ttl,
    msgType: wire.msgType,
    content: m.text,
    ...(wire.propertyExt !== undefined ? { propertyExt: wire.propertyExt } : {}),
  };
}

/** Seen-marker target of a customer (inbound) message. */
export function seenTargetOf(m: StoredZaloMessage | null | undefined, threadKind: ZaloThreadKind): ZaloSeenTarget | null {
  if (!m || m.direction !== 'in') return null;
  const e = envelopeOf(m);
  if (!e) return null;
  const { env, wire } = e;
  const msgId = env.zaloMsgId;
  const cliMsgId = env.cliMsgId;
  if (!isStr(msgId) || !DIGITS.test(msgId) || m.nativeMessageId !== msgId) return null;
  if (!isStr(cliMsgId) || !DIGITS.test(cliMsgId)) return null;
  if (!isStr(wire.uidFrom) || !isStr(wire.idTo) || !isStr(wire.msgType) || !isStr(wire.ts)) return null;
  if (!isNonNegInt(wire.st) || !isNonNegInt(wire.at) || !isNonNegInt(wire.cmd)) return null;
  return { threadKind, msgId, cliMsgId, uidFrom: wire.uidFrom, idTo: wire.idTo, msgType: wire.msgType, st: wire.st, at: wire.at, cmd: wire.cmd, ts: wire.ts };
}
