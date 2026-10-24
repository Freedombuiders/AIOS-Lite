/** Small shared helpers: opaque keyset cursors, text folding, bounded query-number parsing. */

import { invalid, invalidCursor } from './errors.js';

const MAX_ID_CHARS = 256;

/** Opaque keyset cursor `(timestamp, id)`: `base64url("<ms>:<id>")`. */
export function encodeCursor(ms: number, id: string): string {
  return Buffer.from(`${ms}:${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined | null): { ms: number; id: string } | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalidCursor();
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = text.indexOf(':');
  if (sep <= 0) throw invalidCursor();
  const msText = text.slice(0, sep);
  const id = text.slice(sep + 1);
  if (!/^\d{1,16}$/.test(msText) || id.length === 0 || id.length > MAX_ID_CHARS) throw invalidCursor();
  const ms = Number(msText);
  if (!Number.isSafeInteger(ms)) throw invalidCursor();
  return { ms, id };
}

/** Case- and diacritic-insensitive fold (Vietnamese `đ` included) for plaintext matching of decrypted candidates. */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase();
}

export function intParam(raw: string | undefined, name: string, opts: { min: number; max: number; fallback: number }): number {
  if (raw === undefined || raw === '') return opts.fallback;
  if (!/^-?\d{1,15}$/.test(raw)) throw invalid(`Query parameter '${name}' must be an integer.`);
  const n = Number(raw);
  if (n < opts.min || n > opts.max) throw invalid(`Query parameter '${name}' is out of range.`);
  return n;
}

export function optionalMsParam(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw === '') return null;
  if (!/^\d{1,15}$/.test(raw)) throw invalid(`Query parameter '${name}' must be a millisecond timestamp.`);
  return Number(raw);
}

export function boolParam(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw invalid('A boolean query parameter must be 1/0 or true/false.');
}

export function idParam(raw: string | undefined, name = 'id'): string {
  if (!raw || raw.length > MAX_ID_CHARS) throw invalid(`'${name}' is invalid.`);
  return raw;
}
