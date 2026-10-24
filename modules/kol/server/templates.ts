/**
 * Composition templates: images whose framing, pose and light are recreated
 * with a persona (never their person). Single images or carousel sets that
 * share a setId and are ordered by position. Files in KOL_DIR/templates/.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { ensureKolDir, KolError, kolDb, kolPaths, mediaUrl, nowSec, parseJson, resolveKolFile, toKolRel } from './core.js';
import { storeImage } from './files.js';
import type { TemplateDto, TemplateKind } from './types.js';

export interface TemplateRow {
  id: string;
  name: string;
  kind: TemplateKind;
  set_id: string | null;
  position: number;
  file: string;
  mime: string;
  width: number | null;
  height: number | null;
  notes: string;
  source: 'upload' | 'url' | 'radar';
  source_url: string;
  tags_json: string;
  created_at: number;
}

export function templateToDto(row: TemplateRow): TemplateDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    setId: row.set_id,
    position: row.position,
    url: mediaUrl('template', row.id),
    width: row.width,
    height: row.height,
    notes: row.notes,
    source: row.source,
    sourceUrl: row.source_url,
    tags: parseJson<string[]>(row.tags_json, []),
    createdAt: row.created_at,
  };
}

function getRow(id: string): TemplateRow | null {
  return (kolDb().prepare('SELECT * FROM kol_templates WHERE id = ?').get(id) as TemplateRow | undefined) ?? null;
}

export function getTemplate(id: string): TemplateDto | null {
  const row = getRow(id);
  return row ? templateToDto(row) : null;
}

export function getTemplateFile(id: string): { abs: string; mime: string } | null {
  const row = getRow(id);
  if (!row) return null;
  try {
    const abs = resolveKolFile(row.file);
    return fs.existsSync(abs) ? { abs, mime: row.mime } : null;
  } catch {
    return null;
  }
}

/** Newest sets first; images of a carousel set stay together, ordered by position. */
export function listTemplates(): TemplateDto[] {
  const rows = kolDb().prepare(
    `SELECT t.*, COALESCE((SELECT MAX(created_at) FROM kol_templates s WHERE s.set_id = t.set_id), t.created_at) AS grp_at
     FROM kol_templates t ORDER BY grp_at DESC, COALESCE(t.set_id, t.id), t.position, t.created_at`,
  ).all() as TemplateRow[];
  return rows.map(templateToDto);
}

export interface NewTemplateMeta { name?: string; kind?: string; setId?: string; position?: string | number; notes?: string }

export async function createTemplate(tempFile: string, meta: NewTemplateMeta, fileName = ''): Promise<TemplateDto> {
  let kind: TemplateKind;
  if (!meta.kind || meta.kind === 'single') kind = 'single';
  else if (meta.kind === 'carousel') kind = 'carousel';
  else throw new KolError(400, 'Loại mẫu phải là single hoặc carousel.');
  const name = (meta.name ?? '').trim().slice(0, 120) || fileName.replace(/\.[a-z0-9]+$/i, '').slice(0, 120);
  const notes = (meta.notes ?? '').trim().slice(0, 1000);
  let setId: string | null = null;
  let position = 0;
  if (kind === 'carousel') {
    setId = meta.setId?.trim() || randomUUID();
    if (!/^[A-Za-z0-9-]{1,80}$/.test(setId)) throw new KolError(400, 'Mã bộ carousel không hợp lệ.');
    const count = (kolDb().prepare('SELECT COUNT(*) AS n FROM kol_templates WHERE set_id = ?').get(setId) as { n: number }).n;
    if (count >= 10) throw new KolError(409, 'Một bộ carousel có tối đa 10 ảnh.');
    const pos = meta.position === undefined || meta.position === '' ? count : Number(meta.position);
    if (!Number.isInteger(pos) || pos < 0 || pos > 99) throw new KolError(400, 'Vị trí ảnh trong bộ phải là số nguyên 0–99.');
    position = pos;
  }
  const id = randomUUID();
  const stored = await storeImage(tempFile, ensureKolDir(kolPaths.templates()), id);
  kolDb().prepare(
    `INSERT INTO kol_templates (id, name, kind, set_id, position, file, mime, width, height, notes, source, source_url, tags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upload', '', '[]', ?)`,
  ).run(id, name, kind, setId, position, toKolRel(stored.abs), stored.mime, stored.width, stored.height, notes, nowSec());
  return templateToDto(getRow(id)!);
}

export function patchTemplate(id: string, patch: { name?: unknown; notes?: unknown; tags?: unknown }): TemplateDto {
  const row = getRow(id);
  if (!row) throw new KolError(404, 'Không tìm thấy ảnh mẫu.');
  let { name, notes, tags_json: tags } = row;
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || patch.name.length > 120) throw new KolError(400, 'Tên mẫu tối đa 120 ký tự.');
    name = patch.name.trim();
  }
  if (patch.notes !== undefined) {
    if (typeof patch.notes !== 'string' || patch.notes.length > 1000) throw new KolError(400, 'Ghi chú tối đa 1000 ký tự.');
    notes = patch.notes.trim();
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.length > 20 || patch.tags.some((t) => typeof t !== 'string' || t.length > 40)) {
      throw new KolError(400, 'Thẻ phải là danh sách tối đa 20 chuỗi, mỗi chuỗi tối đa 40 ký tự.');
    }
    tags = JSON.stringify(patch.tags.map((t: string) => t.trim()).filter(Boolean));
  }
  kolDb().prepare('UPDATE kol_templates SET name = ?, notes = ?, tags_json = ? WHERE id = ?').run(name, notes, tags, id);
  return templateToDto(getRow(id)!);
}

export function deleteTemplate(id: string): void {
  const row = getRow(id);
  if (!row) throw new KolError(404, 'Không tìm thấy ảnh mẫu.');
  kolDb().prepare('DELETE FROM kol_templates WHERE id = ?').run(id);
  try { fs.rmSync(resolveKolFile(row.file), { force: true }); } catch { /* ignore */ }
}
