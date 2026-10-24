/**
 * Small argument helpers shared by the media integrations (Pexels, Freesound,
 * ElevenLabs, FPT.AI). Same behaviour as the private helpers in pancake/commands.ts.
 */
import { IntegrationUsageError, type ParsedArgs } from './types.js';

export function assertFlags(args: ParsedArgs, allowed: string[]): void {
  const bad = Object.keys(args.flags).filter((f) => !allowed.includes(f));
  if (bad.length === 0) return;
  const list = allowed.length ? allowed.map((f) => `--${f}`).join(', ') : 'none';
  throw new IntegrationUsageError(
    `Flag không hỗ trợ: ${bad.map((f) => `--${f}`).join(', ')}. Flag hợp lệ cho lệnh này: ${list}.`,
  );
}

export function strFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (v === true || !String(v).trim()) throw new IntegrationUsageError(`--${name} cần một giá trị: --${name} <value>.`);
  return String(v).trim();
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  const v = args.flags[name];
  if (v === undefined) return false;
  if (v === true) return true;
  return !['false', '0', 'no'].includes(String(v).toLowerCase());
}

export function numFlag(args: ParsedArgs, name: string, opts: { min?: number; max?: number; int?: boolean } = {}): number | undefined {
  const raw = strFlag(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || (opts.int && !Number.isInteger(n))) {
    throw new IntegrationUsageError(`--${name} phải là ${opts.int ? 'số nguyên' : 'số'}, nhận được "${raw}".`);
  }
  if (opts.min !== undefined && n < opts.min) throw new IntegrationUsageError(`--${name} phải >= ${opts.min}.`);
  if (opts.max !== undefined && n > opts.max) throw new IntegrationUsageError(`--${name} phải <= ${opts.max}.`);
  return n;
}

export function enumFlag<T extends string>(args: ParsedArgs, name: string, allowed: readonly T[]): T | undefined {
  const raw = strFlag(args, name);
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new IntegrationUsageError(`--${name} phải là một trong: ${allowed.join(', ')}.`);
  }
  return raw as T;
}

/** The positionals joined as one text ("tts xin chào các bạn"), or an error with an example. */
export function requireText(args: ParsedArgs, what: string, example: string): string {
  const text = args.positionals.join(' ').trim();
  if (!text) throw new IntegrationUsageError(`Thiếu ${what}. Ví dụ: ${example}`);
  return text;
}

export function requirePositional(args: ParsedArgs, index: number, what: string, example: string): string {
  const v = args.positionals[index];
  if (!v) throw new IntegrationUsageError(`Thiếu ${what}. Ví dụ: ${example}`);
  return v;
}
