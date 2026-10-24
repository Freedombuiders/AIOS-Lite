import { sanitizeOutbound } from '../outbound.js';

export interface SanitizeDiagnostic {
  kind: 'protected-value' | 'sanitized';
  seam?: string;
  count: number;
}

export interface SanitizeOptions {
  enabled?: boolean;
  protectedValues?: string[];
  seam?: string;
  onEvent?: (event: SanitizeDiagnostic) => void;
}

export interface OutboundPolicy {
  enabled: boolean;
  protectedValues: string[];
}

const SECRET_NAME = /(key|token|secret|password|passwd|credential)/i;

/** Sanitizing is on unless OUTBOUND_SANITIZE=0; protected values = secret-looking env values. */
export function resolveOutboundPolicy(env: Record<string, string | undefined> = process.env): OutboundPolicy {
  const enabled = !['0', 'false', 'off'].includes((env.OUTBOUND_SANITIZE ?? '').toLowerCase());
  const protectedValues = Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v as string);
  return { enabled, protectedValues };
}

export function outboundOptionsForSeam(seam: string, policy: OutboundPolicy = resolveOutboundPolicy()): SanitizeOptions {
  return { enabled: policy.enabled, protectedValues: policy.protectedValues, seam };
}

export function sanitizeOutboundText(text: string, options: SanitizeOptions = {}): string {
  if (options.enabled === false) return text;
  let out = text;
  let hits = 0;
  for (const v of options.protectedValues ?? []) {
    if (v && out.includes(v)) {
      hits += out.split(v).length - 1;
      out = out.split(v).join('[redacted]');
    }
  }
  if (hits) options.onEvent?.({ kind: 'protected-value', seam: options.seam, count: hits });
  const clean = sanitizeOutbound(out);
  if (clean !== out.trim()) options.onEvent?.({ kind: 'sanitized', seam: options.seam, count: 1 });
  return clean;
}
