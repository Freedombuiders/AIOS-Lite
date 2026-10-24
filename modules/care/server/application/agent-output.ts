/**
 * Strict parse + schema validation + sanitization of the model's output.
 *
 * The model's text is untrusted. The ONLY accepted shape is a single JSON object (optionally in
 * one code fence) with a closed set of keys:
 *
 *   {"action":"reply","replies":[{"ref":"m3","text":"..."}],"needsReview":false,"reason":"..."}
 *   {"action":"reply","text":"..."}
 *   {"action":"skip","reason":"..."}  |  {"action":"handoff","reason":"..."}
 *
 * Any other key (a recipient, account, channel, tools...) rejects the whole output: the target of
 * a draft is decided by the core from the originating conversation, never by the model. Raw
 * output is never forwarded; only the sanitized fields survive.
 */

import { neutralizeUntrustedMarkup } from '../policy/text-heuristics.js';

export type AgentDecision =
  | { action: 'skip'; reason: string }
  | { action: 'handoff'; reason: string }
  | {
      action: 'reply';
      replies: Array<{ ref: string | null; text: string }>;
      /** All reply texts joined, for logs and one-to-one chats. */
      text: string;
      reason: string;
      needsReview: boolean;
    };

export type AgentOutputErrorCode =
  | 'empty_output'
  | 'not_json'
  | 'not_an_object'
  | 'unknown_field'
  | 'invalid_action'
  | 'invalid_field'
  | 'empty_reply'
  | 'too_many_replies';

export type ParsedAgentOutput =
  | { ok: true; decision: AgentDecision }
  | { ok: false; code: AgentOutputErrorCode; detail?: string };

export interface ParseOptions {
  /** Valid message refs of the context ("m1"...). Unknown refs fall back to null, never to a real id. */
  validRefs: ReadonlySet<string>;
  maxReplyChars?: number;
  maxReplies?: number;
  maxReasonChars?: number;
}

const ALLOWED_KEYS = new Set(['action', 'reason', 'text', 'replies', 'needsReview']);
const ALLOWED_REPLY_KEYS = new Set(['ref', 'text']);
const SAFE_KEY = /^[A-Za-z0-9_]{1,40}$/;

// Control characters (except \n and \t), zero-width characters and bidi overrides.
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​‌⁠﻿‪-‮⁦-⁩]/g;

/** Plain-text hardening for anything the model wrote and the customer may eventually read. */
export function sanitizeReplyText(text: string, maxChars: number): string {
  const cleaned = neutralizeUntrustedMarkup(text.normalize('NFC').replace(/\r\n?/g, '\n').replace(INVISIBLE_RE, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).trimEnd() : cleaned;
}

const SIGNATURE_DELIMITER = '--';

/**
 * Appends `signature` exactly once. It is already there when the text ends with it, or when it appears
 * right after the `--` delimiter line this helper writes, even if the operator then typed more text
 * BELOW the signature (a reply that was edited after the signature was added must not gain a second one).
 */
export function withSignatureOnce(text: string, signature: string | null | undefined): string {
  const sig = signature?.trim();
  if (!sig) return text;
  const body = text.trimEnd();
  const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (normalized(body).endsWith(normalized(sig))) return body;
  const sigPattern = sig.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const delimited = new RegExp(`(?:^|\\n)${SIGNATURE_DELIMITER}[ \\t]*\\n\\s*${sigPattern}(?=\\s|$)`);
  if (delimited.test(body)) return body;
  return `${body}\n\n${SIGNATURE_DELIMITER}\n${sig}`;
}

function unwrapFence(raw: string): string {
  const t = raw.trim();
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(t);
  return m ? m[1].trim() : t;
}

export function parseAgentOutput(raw: string, opts: ParseOptions): ParsedAgentOutput {
  const maxReply = opts.maxReplyChars ?? 1500;
  const maxReplies = opts.maxReplies ?? 5;
  const maxReason = opts.maxReasonChars ?? 300;
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, code: 'empty_output' };

  let value: unknown;
  try {
    value = JSON.parse(unwrapFence(raw));
  } catch {
    return { ok: false, code: 'not_json' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'not_an_object' };
  const obj = value as Record<string, unknown>;

  for (const k of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(k)) return { ok: false, code: 'unknown_field', detail: SAFE_KEY.test(k) ? k : 'invalid_key' };
  }
  const action = obj.action;
  if (action !== 'reply' && action !== 'skip' && action !== 'handoff') return { ok: false, code: 'invalid_action' };

  let reason = '';
  if (obj.reason !== undefined) {
    if (typeof obj.reason !== 'string') return { ok: false, code: 'invalid_field', detail: 'reason' };
    reason = sanitizeReplyText(obj.reason, maxReason);
  }

  if (action !== 'reply') {
    if (obj.text !== undefined || obj.replies !== undefined || obj.needsReview !== undefined) {
      return { ok: false, code: 'invalid_field', detail: 'reply_fields_on_non_reply' };
    }
    return { ok: true, decision: { action, reason } };
  }

  let needsReview = false;
  if (obj.needsReview !== undefined) {
    if (typeof obj.needsReview !== 'boolean') return { ok: false, code: 'invalid_field', detail: 'needsReview' };
    needsReview = obj.needsReview;
  }
  if (obj.text !== undefined && obj.replies !== undefined) return { ok: false, code: 'invalid_field', detail: 'text_and_replies' };

  const rawReplies: unknown[] = Array.isArray(obj.replies)
    ? obj.replies
    : obj.replies === undefined
      ? [{ text: obj.text }]
      : [null];
  if (rawReplies.length > maxReplies) return { ok: false, code: 'too_many_replies' };

  const replies: Array<{ ref: string | null; text: string }> = [];
  for (const item of rawReplies) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { ok: false, code: 'invalid_field', detail: 'replies' };
    const r = item as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      if (!ALLOWED_REPLY_KEYS.has(k)) return { ok: false, code: 'unknown_field', detail: `replies.${SAFE_KEY.test(k) ? k : 'invalid_key'}` };
    }
    if (typeof r.text !== 'string') return { ok: false, code: 'invalid_field', detail: 'replies.text' };
    if (r.ref !== undefined && r.ref !== null && typeof r.ref !== 'string') return { ok: false, code: 'invalid_field', detail: 'replies.ref' };
    const text = sanitizeReplyText(r.text, maxReply);
    if (!text) continue;
    const ref = typeof r.ref === 'string' && opts.validRefs.has(r.ref) ? r.ref : null;
    replies.push({ ref, text });
  }
  if (replies.length === 0) return { ok: false, code: 'empty_reply' };
  return { ok: true, decision: { action, replies, text: replies.map((r) => r.text).join('\n'), reason, needsReview } };
}
