/**
 * Shared plumbing for KOL Studio: the database handle, file locations, settings,
 * small JSON helpers and the error type the routes turn into `{ error }`.
 * Both workstreams (studio and publish) import from here; neither edits it
 * without telling the other.
 */

import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { STORE_DIR, mediaRoot } from './config.js';
import { getApplicationDb } from './compat.js';
import { ensureKolSchema } from './schema.js';
import type { KolSettingsDto } from './types.js';

// ── Database ─────────────────────────────────────────────────────────

const ready = new WeakSet<Database.Database>();

/** The application database with the KOL tables guaranteed to exist. */
export function kolDb(): Database.Database {
  const db = getApplicationDb();
  if (!ready.has(db)) {
    ensureKolSchema(db);
    ready.add(db);
  }
  return db;
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

// ── Errors ───────────────────────────────────────────────────────────

/** An error with an HTTP status and a Vietnamese message that is safe to show the owner. */
export class KolError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = 'KolError';
  }
}

// ── Files ────────────────────────────────────────────────────────────
// Every path stored in the database is RELATIVE to KOL_DIR. resolveKolFile()
// turns it back into an absolute path and refuses anything that escapes.

/** Root of generated media: <module data>/media (tests point STORE_DIR at a temp folder instead). */
export const kolDir = (): string => (STORE_DIR ? path.join(STORE_DIR, 'kol') : mediaRoot());

export const kolPaths = {
  refs: (personaId: string) => path.join('personas', personaId, 'refs'),
  assets: (personaId: string, month: string) => path.join('assets', personaId, month),
  library: () => 'library',
  libraryPreviews: () => 'library/previews',
  templates: () => 'templates',
  tmp: () => 'tmp',
};

export function ensureKolDir(rel: string): string {
  const abs = path.join(kolDir(), rel);
  fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
  return abs;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Absolute path of a stored relative path; throws when it would leave KOL_DIR. */
export function resolveKolFile(rel: string): string {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) throw new KolError(400, 'Đường dẫn tệp không hợp lệ.');
  const abs = path.resolve(kolDir(), rel);
  if (!isInside(path.resolve(kolDir()), abs)) throw new KolError(400, 'Đường dẫn tệp không hợp lệ.');
  return abs;
}

/** Relative (stored) form of an absolute path inside KOL_DIR. */
export function toKolRel(abs: string): string {
  const rel = path.relative(path.resolve(kolDir()), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new KolError(500, 'Tệp nằm ngoài thư mục KOL Studio.');
  return rel.split(path.sep).join('/');
}

/** Current month folder name, e.g. "2026-10". */
export function monthKey(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** URL the dashboard uses for a stored file (authenticated route; the web adds the token). */
export function mediaUrl(area: 'ref' | 'asset' | 'thumb' | 'library' | 'preview' | 'template', id: string): string {
  return `/api/kol/media/${area}/${encodeURIComponent(id)}`;
}

// ── Settings ─────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: KolSettingsDto = {
  enabled: true,
  dailyCapUsd: 10,
  monthlyCapUsd: 150,
  defaultImageModel: '',
  defaultVideoModel: '',
  judgeModel: 'auto',
  priceOverrides: {},
  publishEnabled: false,
  autopilotEnabled: false,
  concurrency: 2,
  chatgptDailyLimit: 40,
  chatgptParallel: 1,
  codexModel: 'gpt-6-luna',
};

export function loadSettings(): KolSettingsDto {
  const rows = kolDb().prepare('SELECT key, value FROM kol_settings').all() as { key: string; value: string }[];
  const stored: Record<string, unknown> = {};
  for (const r of rows) stored[r.key] = parseJson<unknown>(r.value, null);
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const v = stored[key];
    if (v !== null && v !== undefined && typeof v === typeof (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]) out[key] = v;
  }
  return out as unknown as KolSettingsDto;
}

/** Validates and stores a partial update. Throws KolError(400) with a Vietnamese reason. */
export function saveSettings(patch: Partial<KolSettingsDto>): KolSettingsDto {
  const next = { ...loadSettings(), ...patch };
  const num = (v: unknown, min: number, max: number, label: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new KolError(400, `${label} phải trong khoảng ${min}–${max}.`);
    return v;
  };
  next.dailyCapUsd = num(next.dailyCapUsd, 0, 10_000, 'Hạn mức ngày (USD)');
  next.monthlyCapUsd = num(next.monthlyCapUsd, 0, 100_000, 'Hạn mức tháng (USD)');
  next.concurrency = Math.round(num(next.concurrency, 1, 4, 'Số việc chạy cùng lúc'));
  next.chatgptDailyLimit = Math.round(num(next.chatgptDailyLimit, 0, 1000, 'Số ảnh ChatGPT mỗi ngày'));
  next.chatgptParallel = Math.round(num(next.chatgptParallel, 1, 6, 'Số ảnh ChatGPT chạy song song'));
  if (typeof next.codexModel !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(next.codexModel.trim())) {
    throw new KolError(400, 'Model Codex không hợp lệ (ví dụ: gpt-5.6-luna).');
  }
  next.codexModel = next.codexModel.trim();
  if (typeof next.judgeModel !== 'string' || !/^(auto|chatgpt|gemini-[a-z0-9.-]+)$/i.test(next.judgeModel.trim())) {
    throw new KolError(400, 'Model chấm khuôn mặt phải là auto, chatgpt hoặc một model Gemini.');
  }
  next.judgeModel = next.judgeModel.trim();
  if (!next.priceOverrides || typeof next.priceOverrides !== 'object' || Array.isArray(next.priceOverrides)) next.priceOverrides = {};
  for (const [k, v] of Object.entries(next.priceOverrides)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new KolError(400, `Giá ghi đè của "${k}" không hợp lệ.`);
  }
  const stmt = kolDb().prepare('INSERT INTO kol_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = kolDb().transaction(() => {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof KolSettingsDto)[]) stmt.run(key, JSON.stringify(next[key]));
  });
  tx();
  return loadSettings();
}
