// JSON-lines helpers and secret-safe command descriptions for logs.
import { redactString } from '../core/redact.js';

export type JsonObject = Record<string, unknown>;

/** Parse one line as a JSON object; anything else (noise, arrays, bad JSON) returns null. */
export function parseJsonLine(line: string): JsonObject | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const SECRET_KV = /(key|token|secret|password|passwd|authorization|cookie|credential)/i;

/**
 * Printable command line for logs: prompt arguments become `<prompt N chars>`,
 * `-c key=value` overrides with secret-looking keys are masked, and the rest goes through redactString.
 */
export function describeCommand(command: string, args: string[], opts: { promptArgs?: string[] } = {}): string {
  const prompts = new Set(opts.promptArgs ?? []);
  const out: string[] = [command];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (prompts.has(a)) {
      out.push(`<prompt ${a.length} chars>`);
      continue;
    }
    const prev = args[i - 1];
    if ((prev === '-c' || prev === '--config') && a.includes('=')) {
      const eq = a.indexOf('=');
      const k = a.slice(0, eq);
      out.push(SECRET_KV.test(k) ? `${k}=[redacted]` : `${k}=${redactString(a.slice(eq + 1))}`);
      continue;
    }
    out.push(redactString(a));
  }
  return out.join(' ');
}

/** Cap long tool inputs/outputs shown in run events. */
export function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
