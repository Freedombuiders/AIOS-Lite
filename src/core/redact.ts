// Masks secrets in strings before they reach logs, audit rows or the UI.

const PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, // Anthropic / OpenAI style keys
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bak_[A-Za-z0-9_-]{16,}/g, // Composio
];

const SECRET_KEY = /(key|token|secret|password|passwd|authorization|cookie|credential)/i;

const protectedValues = new Set<string>();

/** Register exact values (e.g. tokens loaded from .env) that must never be printed. */
export function protectValue(value: string | undefined): void {
  if (value && value.length >= 8) protectedValues.add(value);
}

export function redactString(input: string): string {
  let out = input;
  for (const v of protectedValues) if (out.includes(v)) out = out.split(v).join('[redacted]');
  for (const re of PATTERNS) out = out.replace(re, (m) => (m.toLowerCase().startsWith('bearer') || m.toLowerCase().startsWith('basic') ? `${m.split(/\s+/)[0]} [redacted]` : '[redacted]'));
  return out;
}

/** Deep-redact an object: string leaves are scanned, values under secret-looking keys are masked. */
export function redactValue<T>(value: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key && SECRET_KEY.test(key) && v ? '[redacted]' : redactString(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x, k);
      return o;
    }
    return v;
  };
  return walk(value) as T;
}

/** Env map for logs: secret-looking keys masked. */
export function redactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) o[k] = SECRET_KEY.test(k) ? '[redacted]' : redactString(v);
  return o;
}
