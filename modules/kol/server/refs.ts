/**
 * Identity pack: the reference images of a persona (anchors, 360° sheet,
 * angles, body, expressions). Files live in KOL_DIR/personas/<id>/refs/.
 * Exactly one anchor can be primary; the first anchor becomes primary
 * automatically.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { ensureKolDir, KolError, kolDb, kolPaths, mediaUrl, nowSec, resolveKolFile, toKolRel } from './core.js';
import { storeImage } from './files.js';
import type { RefDto, RefKind } from './types.js';

export const REF_KINDS: RefKind[] = ['anchor', 'sheet', 'angle', 'body', 'expression', 'other'];
/** Most reference images one persona may hold. */
export const MAX_REFS_PER_PERSONA = 40;

export interface RefRow {
  id: string;
  persona_id: string;
  kind: RefKind;
  label: string;
  file: string;
  mime: string;
  width: number | null;
  height: number | null;
  sort: number;
  is_primary: number;
  source: 'upload' | 'generated' | 'asset';
  asset_id: string | null;
  created_at: number;
}

export function refToDto(row: RefRow): RefDto {
  return {
    id: row.id,
    personaId: row.persona_id,
    kind: row.kind,
    label: row.label,
    url: mediaUrl('ref', row.id),
    width: row.width,
    height: row.height,
    sort: row.sort,
    isPrimary: row.is_primary === 1,
    source: row.source,
    assetId: row.asset_id,
    createdAt: row.created_at,
  };
}

export function listRefRows(personaId: string): RefRow[] {
  return kolDb().prepare('SELECT * FROM kol_refs WHERE persona_id = ? ORDER BY sort, created_at').all(personaId) as RefRow[];
}

export function listRefs(personaId: string): RefDto[] {
  return listRefRows(personaId).map(refToDto);
}

export function getRefRow(id: string): RefRow | null {
  return (kolDb().prepare('SELECT * FROM kol_refs WHERE id = ?').get(id) as RefRow | undefined) ?? null;
}

export function getRefFile(id: string): { abs: string; mime: string } | null {
  const row = getRefRow(id);
  if (!row) return null;
  try {
    const abs = resolveKolFile(row.file);
    return fs.existsSync(abs) ? { abs, mime: row.mime } : null;
  } catch {
    return null;
  }
}

function assertPersona(personaId: string): void {
  const row = kolDb().prepare('SELECT status FROM kol_personas WHERE id = ?').get(personaId) as { status: string } | undefined;
  if (!row) throw new KolError(404, 'Không tìm thấy KOL.');
}

export function parseRefKind(v: unknown, fallback: RefKind = 'anchor'): RefKind {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'string' && (REF_KINDS as string[]).includes(v)) return v as RefKind;
  throw new KolError(400, 'Loại ảnh tham chiếu phải là anchor, sheet, angle, body, expression hoặc other.');
}

function nextSort(personaId: string): number {
  const r = kolDb().prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM kol_refs WHERE persona_id = ?').get(personaId) as { n: number };
  return r.n;
}

function hasPrimary(personaId: string): boolean {
  return Boolean(kolDb().prepare('SELECT 1 FROM kol_refs WHERE persona_id = ? AND is_primary = 1').get(personaId));
}

function touchPersona(personaId: string): void {
  kolDb().prepare('UPDATE kol_personas SET updated_at = ? WHERE id = ?').run(nowSec(), personaId);
}

interface NewRef {
  personaId: string;
  kind: RefKind;
  label: string;
  source: RefRow['source'];
  assetId: string | null;
}

async function insertFromFile(src: string, ref: NewRef, keepSource: boolean): Promise<RefDto> {
  assertPersona(ref.personaId);
  const count = (kolDb().prepare('SELECT COUNT(*) AS n FROM kol_refs WHERE persona_id = ?').get(ref.personaId) as { n: number }).n;
  if (count >= MAX_REFS_PER_PERSONA) throw new KolError(409, `Mỗi KOL giữ tối đa ${MAX_REFS_PER_PERSONA} ảnh tham chiếu. Xóa bớt ảnh cũ trước.`);
  const id = randomUUID();
  const dir = ensureKolDir(kolPaths.refs(ref.personaId));
  const stored = await storeImage(src, dir, id, { keepSource });
  const primary = ref.kind === 'anchor' && !hasPrimary(ref.personaId) ? 1 : 0;
  kolDb().prepare(
    `INSERT INTO kol_refs (id, persona_id, kind, label, file, mime, width, height, sort, is_primary, source, asset_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ref.personaId, ref.kind, ref.label.slice(0, 120), toKolRel(stored.abs), stored.mime, stored.width, stored.height,
    nextSort(ref.personaId), primary, ref.source, ref.assetId, nowSec());
  touchPersona(ref.personaId);
  return refToDto(getRefRow(id)!);
}

/** Stores an uploaded temp file (moved) as a reference image. Rejects non-images (415). */
export async function addRefFromUpload(personaId: string, tempFile: string, opts: { kind?: unknown; label?: string }): Promise<RefDto> {
  const kind = parseRefKind(opts.kind);
  return insertFromFile(tempFile, { personaId, kind, label: opts.label ?? '', source: 'upload', assetId: null }, false);
}

/** Copies an image asset of the same persona into its identity pack. */
export async function addRefFromAsset(personaId: string, assetId: string, kind: unknown, opts: { source?: 'asset' | 'generated'; label?: string } = {}): Promise<RefDto> {
  const k = parseRefKind(kind);
  const asset = kolDb().prepare('SELECT persona_id, kind, file FROM kol_assets WHERE id = ?').get(assetId) as { persona_id: string; kind: string; file: string } | undefined;
  if (!asset) throw new KolError(404, 'Không tìm thấy ảnh trong thư viện.');
  if (asset.persona_id !== personaId) throw new KolError(400, 'Ảnh này thuộc KOL khác.');
  if (asset.kind !== 'image') throw new KolError(400, 'Chỉ ảnh mới dùng làm ảnh tham chiếu được.');
  const abs = resolveKolFile(asset.file);
  if (!fs.existsSync(abs)) throw new KolError(404, 'Tệp ảnh không còn trên máy.');
  return insertFromFile(abs, { personaId, kind: k, label: opts.label ?? '', source: opts.source ?? 'asset', assetId }, true);
}

export interface RefPatch { kind?: unknown; label?: unknown; sort?: unknown; isPrimary?: unknown }

export function patchRef(refId: string, patch: RefPatch): RefDto {
  const row = getRefRow(refId);
  if (!row) throw new KolError(404, 'Không tìm thấy ảnh tham chiếu.');
  const db = kolDb();
  const kind = patch.kind !== undefined ? parseRefKind(patch.kind) : row.kind;
  let label = row.label;
  if (patch.label !== undefined) {
    if (typeof patch.label !== 'string' || patch.label.length > 120) throw new KolError(400, 'Nhãn ảnh tối đa 120 ký tự.');
    label = patch.label.trim();
  }
  let sort = row.sort;
  if (patch.sort !== undefined) {
    if (typeof patch.sort !== 'number' || !Number.isInteger(patch.sort) || patch.sort < 0 || patch.sort > 10_000) throw new KolError(400, 'Thứ tự ảnh phải là số nguyên không âm.');
    sort = patch.sort;
  }
  let primary = row.is_primary === 1;
  if (patch.isPrimary !== undefined) {
    if (typeof patch.isPrimary !== 'boolean') throw new KolError(400, 'isPrimary phải là true/false.');
    primary = patch.isPrimary;
  }
  if (primary && kind !== 'anchor') throw new KolError(400, 'Chỉ ảnh gốc (anchor) mới đặt làm ảnh chính được.');
  db.transaction(() => {
    if (primary && row.is_primary !== 1) db.prepare('UPDATE kol_refs SET is_primary = 0 WHERE persona_id = ?').run(row.persona_id);
    db.prepare('UPDATE kol_refs SET kind = ?, label = ?, sort = ?, is_primary = ? WHERE id = ?').run(kind, label, sort, primary ? 1 : 0, refId);
  })();
  touchPersona(row.persona_id);
  return refToDto(getRefRow(refId)!);
}

/** Deletes a reference and its file. When it was the primary, the next anchor becomes primary. */
export function deleteRef(refId: string): void {
  const row = getRefRow(refId);
  if (!row) throw new KolError(404, 'Không tìm thấy ảnh tham chiếu.');
  const db = kolDb();
  db.transaction(() => {
    db.prepare('DELETE FROM kol_refs WHERE id = ?').run(refId);
    if (row.is_primary === 1) {
      const next = db.prepare("SELECT id FROM kol_refs WHERE persona_id = ? AND kind = 'anchor' ORDER BY sort, created_at LIMIT 1").get(row.persona_id) as { id: string } | undefined;
      if (next) db.prepare('UPDATE kol_refs SET is_primary = 1 WHERE id = ?').run(next.id);
    }
  })();
  try { fs.rmSync(resolveKolFile(row.file), { force: true }); } catch { /* file already gone */ }
  touchPersona(row.persona_id);
}

export function anchorCount(personaId: string): number {
  return (kolDb().prepare("SELECT COUNT(*) AS n FROM kol_refs WHERE persona_id = ? AND kind = 'anchor'").get(personaId) as { n: number }).n;
}

/** Absolute paths of the persona's anchors for the consistency judge: primary first, at most `limit`. */
export function judgeAnchors(personaId: string, limit = 3, excludeAssetId?: string): { path: string; mime: string }[] {
  const rows = (kolDb().prepare(
    "SELECT * FROM kol_refs WHERE persona_id = ? AND kind IN ('anchor', 'angle') ORDER BY is_primary DESC, CASE kind WHEN 'anchor' THEN 0 ELSE 1 END, sort, created_at",
  ).all(personaId) as RefRow[]).filter((r) => !excludeAssetId || r.asset_id !== excludeAssetId);
  const out: { path: string; mime: string }[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    try {
      const abs = resolveKolFile(r.file);
      if (fs.existsSync(abs)) out.push({ path: abs, mime: r.mime });
    } catch { /* skip */ }
  }
  return out;
}
