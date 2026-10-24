/**
 * Generated media (the gallery): images, videos and speech of every persona,
 * with the identity-consistency verdict. Files live in
 * KOL_DIR/assets/<persona>/<YYYY-MM>/<assetId>.<ext> (+ <assetId>.thumb.jpg).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureKolDir, KolError, kolDb, kolPaths, mediaUrl, monthKey, nowSec, parseJson, resolveKolFile, toKolRel } from './core.js';
import { imageDims, makeThumbnail, probeMedia, readHead, sniffMedia } from './files.js';
import type { AssetDto, AssetKind, AssetStatus, ConsistencyVerdict } from './types.js';

export interface AssetRow {
  id: string;
  persona_id: string;
  generation_id: string | null;
  kind: AssetKind;
  file: string;
  thumb: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  bytes: number;
  status: AssetStatus;
  favorite: number;
  consistency_score: number | null;
  consistency_verdict: ConsistencyVerdict | null;
  consistency_notes: string;
  model: string;
  provider: string;
  cost_usd: number;
  prompt: string;
  tags_json: string;
  created_at: number;
  updated_at: number;
}

export function assetToDto(row: AssetRow): AssetDto {
  return {
    id: row.id,
    personaId: row.persona_id,
    generationId: row.generation_id,
    kind: row.kind,
    url: mediaUrl('asset', row.id),
    thumbUrl: row.thumb ? mediaUrl('thumb', row.id) : null,
    mime: row.mime,
    width: row.width,
    height: row.height,
    durationSec: row.duration_sec,
    bytes: row.bytes,
    status: row.status,
    favorite: row.favorite === 1,
    consistency: { score: row.consistency_score, verdict: row.consistency_verdict, notes: row.consistency_notes },
    model: row.model,
    provider: row.provider,
    costUsd: row.cost_usd,
    prompt: row.prompt,
    tags: parseJson<string[]>(row.tags_json, []),
    createdAt: row.created_at,
  };
}

export function getAssetRow(id: string): AssetRow | null {
  return (kolDb().prepare('SELECT * FROM kol_assets WHERE id = ?').get(id) as AssetRow | undefined) ?? null;
}

export function getAsset(id: string): AssetDto | null {
  const row = getAssetRow(id);
  return row ? assetToDto(row) : null;
}

/** Assets in the given order; missing ids are skipped. */
export function listAssetsByIds(ids: string[]): AssetDto[] {
  const unique = [...new Set(ids.filter((x) => typeof x === 'string' && x))];
  if (unique.length === 0) return [];
  const rows = kolDb().prepare(`SELECT * FROM kol_assets WHERE id IN (${unique.map(() => '?').join(',')})`).all(...unique) as AssetRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is AssetRow => Boolean(r)).map(assetToDto);
}

function absIfExists(rel: string | null): string | null {
  if (!rel) return null;
  try {
    const abs = resolveKolFile(rel);
    return fs.existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

export function getAssetFile(id: string): { abs: string; mime: string; kind: AssetKind; width: number | null; height: number | null; durationSec: number | null } | null {
  const row = getAssetRow(id);
  if (!row) return null;
  const abs = absIfExists(row.file);
  return abs ? { abs, mime: row.mime, kind: row.kind, width: row.width, height: row.height, durationSec: row.duration_sec } : null;
}

export function getAssetThumbFile(id: string): string | null {
  const row = getAssetRow(id);
  return row ? absIfExists(row.thumb) : null;
}

export function assetsForGeneration(generationId: string): AssetDto[] {
  const rows = kolDb().prepare('SELECT * FROM kol_assets WHERE generation_id = ? ORDER BY created_at, rowid').all(generationId) as AssetRow[];
  return rows.map(assetToDto);
}

export interface AssetFilter {
  personaId?: string;
  status?: string;
  kind?: string;
  favorite?: boolean;
  before?: number;
  limit?: number;
}

const STATUSES: AssetStatus[] = ['new', 'approved', 'rejected'];
const KINDS: AssetKind[] = ['image', 'video', 'audio'];

/** Newest first. `before` is a created_at cursor; a page never splits assets that share one timestamp. */
export function listAssets(f: AssetFilter): { assets: AssetDto[]; nextBefore: number | null } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.personaId) { where.push('persona_id = ?'); params.push(f.personaId); }
  if (f.status) {
    if (!(STATUSES as string[]).includes(f.status)) throw new KolError(400, 'Trạng thái phải là new, approved hoặc rejected.');
    where.push('status = ?'); params.push(f.status);
  }
  if (f.kind) {
    if (!(KINDS as string[]).includes(f.kind)) throw new KolError(400, 'Loại phải là image, video hoặc audio.');
    where.push('kind = ?'); params.push(f.kind);
  }
  if (f.favorite) where.push('favorite = 1');
  const base = where.length ? where.join(' AND ') : '1 = 1';
  const limit = Math.min(Math.max(Math.floor(f.limit ?? 60) || 60, 1), 200);
  const cursor = f.before !== undefined && Number.isFinite(f.before) ? ' AND created_at < ?' : '';
  const rows = kolDb().prepare(`SELECT * FROM kol_assets WHERE ${base}${cursor} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...params, ...(cursor ? [f.before as number] : []), limit) as AssetRow[];
  if (rows.length === limit) {
    const last = rows[rows.length - 1];
    const seen = new Set(rows.map((r) => r.id));
    const ties = kolDb().prepare(`SELECT * FROM kol_assets WHERE ${base} AND created_at = ? ORDER BY rowid DESC`).all(...params, last.created_at) as AssetRow[];
    for (const t of ties) if (!seen.has(t.id)) rows.push(t);
  }
  return { assets: rows.map(assetToDto), nextBefore: rows.length >= limit ? rows[rows.length - 1].created_at : null };
}

export interface NewAsset {
  id: string;
  personaId: string;
  generationId: string | null;
  kind: AssetKind;
  file: string;
  thumb: string | null;
  mime: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  bytes: number;
  model: string;
  provider: string;
  costUsd: number;
  prompt: string;
  tags?: string[];
  verdict?: ConsistencyVerdict | null;
  notes?: string;
}

export function insertAsset(a: NewAsset): AssetDto {
  const now = nowSec();
  kolDb().prepare(
    `INSERT INTO kol_assets (id, persona_id, generation_id, kind, file, thumb, mime, width, height, duration_sec, bytes, status, favorite,
       consistency_score, consistency_verdict, consistency_notes, model, provider, cost_usd, prompt, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(a.id, a.personaId, a.generationId, a.kind, a.file, a.thumb, a.mime, a.width, a.height, a.durationSec, a.bytes,
    a.verdict ?? null, a.notes ?? '', a.model, a.provider, a.costUsd, a.prompt, JSON.stringify(a.tags ?? []), now, now);
  return assetToDto(getAssetRow(a.id)!);
}

export function setAssetCost(id: string, costUsd: number): void {
  kolDb().prepare('UPDATE kol_assets SET cost_usd = ?, updated_at = ? WHERE id = ?').run(costUsd, nowSec(), id);
}

export function setAssetConsistency(id: string, c: { score: number | null; verdict: ConsistencyVerdict; notes: string; reject?: boolean }): void {
  kolDb().prepare(
    `UPDATE kol_assets SET consistency_score = ?, consistency_verdict = ?, consistency_notes = ?,
       status = CASE WHEN ? = 1 AND status = 'new' THEN 'rejected' ELSE status END, updated_at = ? WHERE id = ?`,
  ).run(c.score, c.verdict, c.notes.slice(0, 1000), c.reject ? 1 : 0, nowSec(), id);
}

export interface AssetPatch { status?: unknown; favorite?: unknown; tags?: unknown }

export function patchAsset(id: string, patch: AssetPatch): AssetDto {
  const row = getAssetRow(id);
  if (!row) throw new KolError(404, 'Không tìm thấy tệp trong thư viện.');
  let status = row.status;
  if (patch.status !== undefined) {
    if (typeof patch.status !== 'string' || !(STATUSES as string[]).includes(patch.status)) throw new KolError(400, 'Trạng thái phải là new, approved hoặc rejected.');
    status = patch.status as AssetStatus;
  }
  let favorite = row.favorite;
  if (patch.favorite !== undefined) {
    if (typeof patch.favorite !== 'boolean') throw new KolError(400, 'favorite phải là true/false.');
    favorite = patch.favorite ? 1 : 0;
  }
  let tags = row.tags_json;
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.length > 30 || patch.tags.some((t) => typeof t !== 'string' || t.length > 40)) {
      throw new KolError(400, 'Thẻ phải là danh sách tối đa 30 chuỗi, mỗi chuỗi tối đa 40 ký tự.');
    }
    tags = JSON.stringify([...new Set((patch.tags as string[]).map((t) => t.trim()).filter(Boolean))]);
  }
  kolDb().prepare('UPDATE kol_assets SET status = ?, favorite = ?, tags_json = ?, updated_at = ? WHERE id = ?').run(status, favorite, tags, nowSec(), id);
  return assetToDto(getAssetRow(id)!);
}

/** Posts (not cancelled) whose media list contains this asset. */
export function postsUsingAsset(id: string): number {
  try {
    const r = kolDb().prepare("SELECT COUNT(*) AS n FROM kol_posts WHERE status != 'cancelled' AND asset_ids_json LIKE ?").get(`%"${id.replace(/[%_"]/g, '')}"%`) as { n: number };
    return r.n;
  } catch {
    return 0;
  }
}

/** Deletes the asset and its files. Refused (409) while a post uses it. */
export function deleteAsset(id: string): void {
  const row = getAssetRow(id);
  if (!row) throw new KolError(404, 'Không tìm thấy tệp trong thư viện.');
  if (postsUsingAsset(id) > 0) throw new KolError(409, 'Tệp này đang được dùng trong một bài đăng. Gỡ khỏi bài đăng trước khi xóa.', 'in_use');
  const db = kolDb();
  db.transaction(() => {
    db.prepare('DELETE FROM kol_assets WHERE id = ?').run(id);
    db.prepare('UPDATE kol_personas SET cover_asset_id = NULL WHERE cover_asset_id = ?').run(id);
  })();
  for (const rel of [row.file, row.thumb]) {
    if (!rel) continue;
    try { fs.rmSync(resolveKolFile(rel), { force: true }); } catch { /* ignore */ }
  }
}

// ── Import the owner's existing media ────────────────────────────────

export interface ImportOptions {
  /** 'approved' when the owner already vouches for the image (their own finished content). */
  status?: AssetStatus;
  tags?: string[];
  /** Original file name, kept as a note in `prompt` so the owner can find it again. */
  fileName?: string;
}

/**
 * Brings an existing image or video of the persona into the gallery (no generation, no spend), so it
 * can be posted, used as a reference and checked for identity drift. `temp` is consumed.
 */
export async function importAssetFromUpload(personaId: string, temp: string, opts: ImportOptions = {}): Promise<AssetDto> {
  const exists = kolDb().prepare('SELECT 1 FROM kol_personas WHERE id = ?').get(personaId);
  if (!exists) throw new KolError(404, 'Không tìm thấy KOL.');
  const sniffed = sniffMedia(readHead(temp));
  if (!sniffed || sniffed.kind === 'audio') throw new KolError(415, 'Chỉ nhận ảnh JPG, PNG, WebP hoặc video MP4, WebM.', 'bad_type');
  const id = randomUUID();
  const dir = ensureKolDir(kolPaths.assets(personaId, monthKey()));
  const abs = path.join(dir, `${id}.${sniffed.ext}`);
  fs.copyFileSync(temp, abs);
  fs.chmodSync(abs, 0o600);
  let width: number | null = null;
  let height: number | null = null;
  let durationSec: number | null = null;
  if (sniffed.kind === 'image') ({ width, height } = imageDims(abs));
  else {
    const probe = await probeMedia(abs);
    if (probe) ({ width, height, durationSec } = probe);
  }
  const thumbAbs = path.join(dir, `${id}.thumb.jpg`);
  const thumb = (await makeThumbnail(abs, thumbAbs, sniffed.kind)) ? toKolRel(thumbAbs) : null;
  const note = opts.fileName ? `Ảnh có sẵn: ${opts.fileName.slice(0, 160)}` : 'Ảnh có sẵn';
  insertAsset({
    id, personaId, generationId: null, kind: sniffed.kind, file: toKolRel(abs), thumb, mime: sniffed.mime, width, height, durationSec,
    bytes: fs.statSync(abs).size, model: 'upload', provider: 'owner', costUsd: 0, prompt: note,
    tags: (opts.tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 12),
    verdict: sniffed.kind === 'image' ? null : 'skipped', notes: sniffed.kind === 'image' ? '' : 'Video: không chấm khuôn mặt.',
  });
  if (opts.status && opts.status !== 'new') patchAsset(id, { status: opts.status });
  return getAsset(id)!;
}
