/**
 * Log scrubbing for Care (CC-21). Anything about to be written to a log line, error report or
 * diagnostic goes through `scrubCareLog` first: message text, subjects, phone numbers, e-mail
 * addresses and credentials never reach a log. Pure, deterministic, no I/O.
 *
 * Two layers:
 *  - KEY rules: a field whose NAME says it carries content/credentials/contact data is replaced
 *    wholesale (`[redacted]`), whatever the value looks like.
 *  - VALUE rules: every remaining string is pattern-scrubbed (e-mail, phone, bearer/JWT/opaque
 *    tokens, secrets in URL queries) and truncated, because free text also hides in generic
 *    fields such as `message` or `error`.
 * IDs (UUIDs, enum codes, numbers, booleans) pass through: they are what makes a log useful.
 */

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ITEMS = 50;
const MAX_STRING = 500;

// Normalised key = lower-case with `_`/`-` removed.
const CONTENT_KEY = /(text|body|content|subject|snippet|caption|html|payload|replay|plaintext|prompt|completion|transcript|attachment)s?$/;
const SECRET_KEY = /(token|secret|password|passwd|passphrase|authorization|cookie|apikey|credential|signature|privatekey|session|bearer|otp)s?$/;
const CONTACT_KEY = /^(phone|mobile|msisdn|email|emailaddress|recipient|recipients|to|cc|bcc|from|displayname|username|fullname|label|address)$|(phone|email)(number|address)?$/;

function sensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_\-\s]/g, '');
  return CONTENT_KEY.test(k) || SECRET_KEY.test(k) || CONTACT_KEY.test(k);
}

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** UUIDs (and ids built from them, e.g. `outbox:<uuid>:3`) are identifiers, not secrets. */
const opaque = (m: string): boolean => m.replace(/\u0001\d+\u0002/g, '').length >= 32;

/** Scrubs one string. Safe for any input. */
export function scrubCareLogString(input: string, maxLength = MAX_STRING): string {
  // UUIDs are parked behind placeholders so the digit-run rules below cannot mistake them for phones.
  const ids: string[] = [];
  let s = input.replace(UUID_G, (m) => `\u0001${ids.push(m) - 1}\u0002`);
  s = s.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [token]');
  s = s.replace(/([?&;]\s*(?:access_?token|refresh_?token|token|api_?key|key|secret|password|sig|signature|code|auth|session)=)[^&\s#]*/gi, '$1[redacted]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[token]');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]');
  s = s.replace(/[A-Za-z0-9_+/=:\u0001\u0002-]{32,}/g, (m) => (opaque(m) ? '[token]' : m));
  s = s.replace(/\+?\d[\d\s().-]{7,}\d/g, '[phone]');
  s = s.replace(/\u0001(\d+)\u0002/g, (_m, i: string) => ids[Number(i)] ?? '');
  return s.length > maxLength ? `${s.slice(0, maxLength)}...[truncated]` : s;
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return scrubCareLogString(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return undefined;
  }
  const obj = value as object;
  if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) return '[binary]';
  if (depth >= MAX_DEPTH) return '[depth]';
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);
  if (obj instanceof Error) {
    const code = (obj as { code?: unknown }).code;
    return {
      name: obj.name,
      ...(typeof code === 'string' || typeof code === 'number' ? { code: scrubValue(code, depth + 1, seen) } : {}),
      message: scrubCareLogString(obj.message),
    };
  }
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  if (Array.isArray(obj)) {
    const items = obj.slice(0, MAX_ITEMS).map((v) => scrubValue(v, depth + 1, seen));
    return obj.length > MAX_ITEMS ? [...items, `[+${obj.length - MAX_ITEMS} more]`] : items;
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [key, v] of Object.entries(obj)) {
    if (n++ >= MAX_KEYS) {
      out['[truncated]'] = true;
      break;
    }
    out[key] = sensitiveKey(key) && v !== null && v !== undefined ? REDACTED : scrubValue(v, depth + 1, seen);
  }
  return out;
}

/** Deep-scrubs any value into a JSON-safe structure. Never throws. */
export function scrubCareLog<T = unknown>(value: unknown): T {
  try {
    return scrubValue(value, 0, new WeakSet()) as T;
  } catch {
    return REDACTED as T;
  }
}

/** Scrubs a log field map (the usual `{event, accountId, ...}` shape). */
export function scrubCareLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out = scrubCareLog<unknown>(fields);
  return out !== null && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : { value: out };
}

/** Wraps a log sink so nothing unscrubbed can be written through it. */
export function createScrubbedLogSink(sink: (line: string) => void): (event: string, fields?: Record<string, unknown>) => void {
  return (event, fields = {}) => {
    sink(JSON.stringify({ event: scrubCareLogString(event, 120), ...scrubCareLogFields(fields) }));
  };
}
