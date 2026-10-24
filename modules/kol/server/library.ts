/**
 * Attribute library: outfits, expressions, hair, scenes, poses, looks, effects
 * and camera setups the composer slots into a prompt. Builtin items are seeded
 * once by stable id (library-seed.ts); the owner may edit them but not delete
 * them. Owner items can be global (personaId null) or belong to one persona.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';

import { z } from 'zod';

import { ensureKolDir, KolError, kolDb, kolPaths, mediaUrl, nowSec, parseJson, resolveKolFile, toKolRel } from './core.js';
import { storeImage } from './files.js';
import { BUILTIN_LIBRARY, RETIRED_BUILTINS, REVISED_BUILTINS } from './library-seed.js';
import { pronounsFor } from './prompt.js';
import type { LibraryGender, LibraryItemDto, LibraryKind } from './types.js';

export const LIBRARY_KINDS: LibraryKind[] = ['outfit', 'expression', 'hair', 'scene', 'pose', 'look', 'effect', 'camera'];

/** Kinds whose catalog photo shows a person, so items for everyone get a woman's and a man's version. */
export const PERSON_KINDS: LibraryKind[] = ['expression', 'pose', 'hair', 'look', 'effect'];

/** What a catalog photo shows: the woman model, the man model, or nobody (outfits on a mannequin, places). */
export type PreviewVariant = 'female' | 'male' | 'none';
export const PREVIEW_VARIANTS: PreviewVariant[] = ['female', 'male', 'none'];

export interface LibraryRow {
  id: string;
  persona_id: string | null;
  kind: LibraryKind;
  grp: string;
  name: string;
  prompt: string;
  file: string | null;
  /** Unused since catalog photos moved to kol_library_previews (kept for old databases). */
  preview_file: string | null;
  gender: LibraryGender;
  tags_json: string;
  builtin: number;
  sort: number;
  created_at: number;
  updated_at: number;
}

const seeded = new WeakSet<Database.Database>();

/**
 * Inserts builtin items that are missing (by id), moves untouched revised
 * builtins to their current text, removes retired ones, keeps builtins in
 * seed order and their gender as the code says. Idempotent; never overwrites
 * the owner's edits. Returns the number of rows inserted.
 */
export function seedBuiltinLibrary(): number {
  const db = kolDb();
  const now = nowSec();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO kol_library (id, persona_id, kind, grp, name, prompt, file, gender, tags_json, builtin, sort, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, ?)`,
  );
  const resort = db.prepare('UPDATE kol_library SET sort = ? WHERE id = ? AND builtin = 1 AND sort != ?');
  const regender = db.prepare('UPDATE kol_library SET gender = ? WHERE id = ? AND builtin = 1 AND gender != ?');
  const revise = db.prepare(
    `UPDATE kol_library SET grp = ?, name = ?, prompt = ?, tags_json = ?
     WHERE id = ? AND builtin = 1 AND grp = ? AND name = ? AND prompt = ?`,
  );
  const retire = db.prepare('DELETE FROM kol_library WHERE id = ? AND builtin = 1 AND file IS NULL AND grp = ? AND name = ? AND prompt = ?');
  const handOver = db.prepare('UPDATE kol_library SET builtin = 0, updated_at = ? WHERE id = ? AND builtin = 1');
  const byId = new Map(BUILTIN_LIBRARY.map((i) => [i.id, i]));
  let inserted = 0;
  const sortByKind = new Map<LibraryKind, number>();
  db.transaction(() => {
    for (const item of BUILTIN_LIBRARY) {
      const sort = sortByKind.get(item.kind) ?? 0;
      sortByKind.set(item.kind, sort + 1);
      const gender = item.gender ?? 'all';
      inserted += insert.run(item.id, item.kind, item.group, item.name, item.prompt, gender, JSON.stringify(item.tags), sort, now, now).changes;
      resort.run(sort, item.id, sort);
      regender.run(gender, item.id, gender);
    }
    for (const old of REVISED_BUILTINS) {
      const cur = byId.get(old.id);
      // A revised prompt makes the old catalog photos stale: drop them so the preview job redraws them.
      if (cur && revise.run(cur.group, cur.name, cur.prompt, JSON.stringify(cur.tags), old.id, old.group, old.name, old.prompt).changes && cur.prompt !== old.prompt) {
        clearPreviews(old.id);
      }
    }
    for (const old of RETIRED_BUILTINS) {
      if (retire.run(old.id, old.group, old.name, old.prompt).changes === 0) handOver.run(now, old.id);
      else clearPreviews(old.id);
    }
  })();
  seeded.add(db);
  return inserted;
}

function ensureSeeded(): void {
  if (!seeded.has(kolDb())) seedBuiltinLibrary();
}

// ── Catalog photos ───────────────────────────────────────────────────

/** 'female' / 'male' from a persona's written gender ("female", "Nữ", "nam"…), else null. */
export function genderOfText(gender: string | null | undefined): 'female' | 'male' | null {
  const p = pronounsFor(gender ?? '').subj;
  return p === 'she' ? 'female' : p === 'he' ? 'male' : null;
}

/** The gender of a persona, from its appearance. */
export function personaGender(personaId: string | null | undefined): 'female' | 'male' | null {
  if (!personaId) return null;
  const row = kolDb().prepare('SELECT appearance_json FROM kol_personas WHERE id = ?').get(personaId) as { appearance_json: string } | undefined;
  return row ? genderOfText(parseJson<{ gender?: string }>(row.appearance_json, {}).gender) : null;
}

/** Every catalog photo, by item then variant. */
export function libraryPreviewFiles(): Map<string, Map<PreviewVariant, string>> {
  const rows = kolDb().prepare('SELECT item_id, variant, file FROM kol_library_previews').all() as { item_id: string; variant: PreviewVariant; file: string }[];
  const out = new Map<string, Map<PreviewVariant, string>>();
  for (const r of rows) (out.get(r.item_id) ?? out.set(r.item_id, new Map()).get(r.item_id)!).set(r.variant, r.file);
  return out;
}

/** The photo to show a viewer: their own gender's version first, then the one with nobody, then the other. */
function pickPreview(files: Map<PreviewVariant, string> | undefined, viewer: 'female' | 'male' | null): { variant: PreviewVariant; file: string } | null {
  if (!files?.size) return null;
  const order: PreviewVariant[] = viewer === 'male' ? ['male', 'none', 'female'] : ['female', 'none', 'male'];
  for (const v of order) { const f = files.get(v); if (f) return { variant: v, file: f }; }
  return null;
}

/** Cache-buster of a stored preview: the random suffix of its file name. */
const previewVersion = (rel: string): string => rel.split('/').pop()?.replace(/\.[a-z]+$/i, '').split('-').pop() ?? '';

/** A KOL's own catalog photos (the item on the persona itself), by item. */
export function personaPreviewFiles(personaId: string): Map<string, { file: string; score: number | null }> {
  const rows = kolDb().prepare('SELECT item_id, file, score FROM kol_persona_previews WHERE persona_id = ?').all(personaId) as { item_id: string; file: string; score: number | null }[];
  return new Map(rows.map((r) => [r.item_id, { file: r.file, score: r.score }]));
}

/** The KOL's own photo of an item, when it has one, wins over the catalog model's. */
export interface PersonaPreview { personaId: string; file: string }

export function libraryToDto(
  row: LibraryRow, previews?: Map<PreviewVariant, string>, viewer: 'female' | 'male' | null = null, own: PersonaPreview | null = null,
): LibraryItemDto {
  const files = previews ?? (libraryPreviewFiles().get(row.id));
  const pick = pickPreview(files, viewer);
  const previewUrl = own
    ? `${mediaUrl('preview', row.id)}?persona=${encodeURIComponent(own.personaId)}&v=${encodeURIComponent(previewVersion(own.file))}`
    : pick ? `${mediaUrl('preview', row.id)}?variant=${pick.variant}&v=${encodeURIComponent(previewVersion(pick.file))}` : null;
  return {
    id: row.id,
    personaId: row.persona_id,
    kind: row.kind,
    group: row.grp,
    name: row.name,
    prompt: row.prompt,
    imageUrl: row.file ? mediaUrl('library', row.id) : null,
    previewUrl,
    previewIsPersona: !!own,
    gender: row.gender ?? 'all',
    tags: parseJson<string[]>(row.tags_json, []),
    builtin: row.builtin === 1,
    sort: row.sort,
  };
}

function getRow(id: string): LibraryRow | null {
  ensureSeeded();
  return (kolDb().prepare('SELECT * FROM kol_library WHERE id = ?').get(id) as LibraryRow | undefined) ?? null;
}

export function getLibraryItem(id: string, viewer: 'female' | 'male' | null = null): LibraryItemDto | null {
  const row = getRow(id);
  return row ? libraryToDto(row, undefined, viewer) : null;
}

/** A catalog photo of an item: a KOL's own one, the variant asked for, else the default one. */
export function getLibraryPreviewFile(id: string, variant?: string | null, personaId?: string | null): string | null {
  const files = libraryPreviewFiles().get(id);
  const rel = personaId ? personaPreviewFiles(personaId).get(id)?.file
    : variant && (PREVIEW_VARIANTS as string[]).includes(variant) ? files?.get(variant as PreviewVariant) : pickPreview(files, null)?.file;
  if (!rel) return null;
  try {
    const abs = resolveKolFile(rel);
    return fs.existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

/** Records a new catalog photo (already stored under library/previews) for one variant and removes the old file. */
export function setLibraryPreview(id: string, variant: PreviewVariant, abs: string): LibraryItemDto {
  const row = getRow(id);
  if (!row) throw new KolError(404, 'Không tìm thấy mục trong thư viện.');
  const rel = toKolRel(abs);
  const old = libraryPreviewFiles().get(id)?.get(variant);
  kolDb().prepare(
    `INSERT INTO kol_library_previews (item_id, variant, file, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(item_id, variant) DO UPDATE SET file = excluded.file, created_at = excluded.created_at`,
  ).run(id, variant, rel, nowSec());
  if (old && old !== rel) removeStored(old);
  return libraryToDto(getRow(id)!);
}

/** Records a KOL's own photo of an item (already stored under library/previews) and removes the old file. */
export function setPersonaPreview(personaId: string, id: string, abs: string, score: number | null): void {
  if (!getRow(id)) throw new KolError(404, 'Không tìm thấy mục trong thư viện.');
  const rel = toKolRel(abs);
  const old = personaPreviewFiles(personaId).get(id)?.file;
  kolDb().prepare(
    `INSERT INTO kol_persona_previews (persona_id, item_id, file, score, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(persona_id, item_id) DO UPDATE SET file = excluded.file, score = excluded.score, created_at = excluded.created_at`,
  ).run(personaId, id, rel, score, nowSec());
  if (old && old !== rel) removeStored(old);
}

/** Drops every KOL's own photo of an item (its wording or reference image changed). */
export function clearPersonaPreviews(id: string): void {
  const rows = kolDb().prepare('SELECT file FROM kol_persona_previews WHERE item_id = ?').all(id) as { file: string }[];
  kolDb().prepare('DELETE FROM kol_persona_previews WHERE item_id = ?').run(id);
  for (const r of rows) removeStored(r.file);
}

/** Drops every catalog photo of an item (stale wording, deleted item), the KOLs' own ones too. */
export function clearPreviews(id: string): void {
  const files = libraryPreviewFiles().get(id);
  kolDb().prepare('DELETE FROM kol_library_previews WHERE item_id = ?').run(id);
  for (const f of files?.values() ?? []) removeStored(f);
  clearPersonaPreviews(id);
}

function removeStored(rel: string): void {
  try { fs.rmSync(resolveKolFile(rel), { force: true }); } catch { /* ignore */ }
}

export function getLibraryFile(id: string): { abs: string; mime: string } | null {
  const row = getRow(id);
  if (!row?.file) return null;
  try {
    const abs = resolveKolFile(row.file);
    if (!fs.existsSync(abs)) return null;
    const ext = abs.split('.').pop()?.toLowerCase();
    return { abs, mime: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' };
  } catch {
    return null;
  }
}

/**
 * Global items plus, when given, that persona's own. Builtins first within a kind, then by group and sort.
 * Catalog photos are the version for `gender`, else for the persona's gender. Nothing is hidden here: the
 * pickers filter by `gender` so the owner can still reach the other gender's items on purpose.
 */
export function listLibrary(opts: { kind?: string; personaId?: string; gender?: string } = {}): LibraryItemDto[] {
  ensureSeeded();
  const where: string[] = [];
  const params: string[] = [];
  if (opts.kind) {
    if (!(LIBRARY_KINDS as string[]).includes(opts.kind)) throw new KolError(400, 'Loại thư viện không hợp lệ.');
    where.push('kind = ?'); params.push(opts.kind);
  }
  if (opts.personaId) { where.push('(persona_id IS NULL OR persona_id = ?)'); params.push(opts.personaId); }
  else where.push('persona_id IS NULL');
  const rows = kolDb().prepare(
    `SELECT * FROM kol_library WHERE ${where.join(' AND ')} ORDER BY kind, builtin DESC, sort, name`,
  ).all(...params) as LibraryRow[];
  const viewer = opts.gender === 'male' || opts.gender === 'female' ? opts.gender : personaGender(opts.personaId);
  const previews = libraryPreviewFiles();
  // The KOL's own photos (the item on the persona itself) win over the catalog model's.
  const own = opts.personaId ? personaPreviewFiles(opts.personaId) : new Map<string, { file: string }>();
  return rows.map((r) => {
    const mine = own.get(r.id);
    return libraryToDto(r, previews.get(r.id) ?? new Map(), viewer, mine ? { personaId: opts.personaId!, file: mine.file } : null);
  });
}

const kindSchema = z.enum(LIBRARY_KINDS as [LibraryKind, ...LibraryKind[]], { message: 'Loại thư viện phải là outfit, expression, hair, scene, pose, look, effect hoặc camera.' });
const itemSchema = z.object({
  kind: kindSchema,
  group: z.string({ message: 'Nhóm phải là chuỗi.' }).max(60, 'Tên nhóm tối đa 60 ký tự.'),
  name: z.string({ message: 'Cần nhập tên.' }).trim().min(1, 'Cần nhập tên.').max(80, 'Tên tối đa 80 ký tự.'),
  prompt: z.string({ message: 'Cần nhập mô tả (prompt).' }).trim().min(1, 'Cần nhập mô tả (prompt) tiếng Anh.').max(1200, 'Mô tả tối đa 1200 ký tự.'),
  personaId: z.string().max(80).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20, 'Tối đa 20 thẻ.').optional(),
  sort: z.number().int().min(0).max(100_000).optional(),
  gender: z.enum(['all', 'female', 'male'], { message: 'Giới tính phải là all, female hoặc male.' }).optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw new KolError(400, r.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ.');
  return r.data;
}

function assertPersona(personaId: string | null | undefined): void {
  if (!personaId) return;
  if (!kolDb().prepare('SELECT 1 FROM kol_personas WHERE id = ?').get(personaId)) throw new KolError(404, 'Không tìm thấy KOL.');
}

export function createLibraryItem(input: unknown): LibraryItemDto {
  ensureSeeded();
  const v = parse(itemSchema, input);
  assertPersona(v.personaId);
  const id = randomUUID();
  const now = nowSec();
  const sort = v.sort ?? ((kolDb().prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM kol_library WHERE kind = ?').get(v.kind) as { n: number }).n);
  kolDb().prepare(
    `INSERT INTO kol_library (id, persona_id, kind, grp, name, prompt, file, gender, tags_json, builtin, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?)`,
  ).run(id, v.personaId ?? null, v.kind, v.group.trim() || 'Của tôi', v.name, v.prompt, v.gender ?? 'all', JSON.stringify(v.tags ?? []), sort, now, now);
  return libraryToDto(getRow(id)!);
}

export function patchLibraryItem(id: string, input: unknown): LibraryItemDto {
  const row = getRow(id);
  if (!row) throw new KolError(404, 'Không tìm thấy mục trong thư viện.');
  const v = parse(itemSchema.partial(), input);
  if (row.builtin === 1 && v.kind !== undefined && v.kind !== row.kind) throw new KolError(400, 'Không đổi được loại của mục có sẵn.');
  if (row.builtin === 1 && v.personaId !== undefined && v.personaId !== null) throw new KolError(400, 'Mục có sẵn dùng chung cho mọi KOL.');
  if (row.builtin === 1 && v.gender !== undefined && v.gender !== row.gender) throw new KolError(400, 'Không đổi được giới tính của mục có sẵn (tạo bản sao để đổi).');
  if (v.personaId !== undefined) assertPersona(v.personaId);
  kolDb().prepare(
    'UPDATE kol_library SET kind = ?, grp = ?, name = ?, prompt = ?, persona_id = ?, gender = ?, tags_json = ?, sort = ?, updated_at = ? WHERE id = ?',
  ).run(
    v.kind ?? row.kind, v.group !== undefined ? v.group.trim() : row.grp, v.name ?? row.name, v.prompt ?? row.prompt,
    v.personaId !== undefined ? v.personaId : row.persona_id, v.gender ?? row.gender, v.tags !== undefined ? JSON.stringify(v.tags) : row.tags_json,
    v.sort ?? row.sort, nowSec(), id,
  );
  // The catalog photos show the old wording (or the wrong person): drop them so they can be redrawn.
  const changed = (v.prompt !== undefined && v.prompt !== row.prompt) || (v.kind !== undefined && v.kind !== row.kind)
    || (v.gender !== undefined && v.gender !== row.gender) || (v.personaId !== undefined && v.personaId !== row.persona_id);
  if (changed) clearPreviews(id);
  return libraryToDto(getRow(id)!);
}

export function deleteLibraryItem(id: string): void {
  const row = getRow(id);
  if (!row) throw new KolError(404, 'Không tìm thấy mục trong thư viện.');
  if (row.builtin === 1) throw new KolError(409, 'Mục có sẵn không xóa được (có thể sửa).', 'builtin');
  kolDb().prepare('DELETE FROM kol_library WHERE id = ?').run(id);
  if (row.file) removeStored(row.file);
  clearPreviews(id);
}

/** Sets (replaces) the reference image of an item from an uploaded temp file. */
export async function setLibraryImage(id: string, tempFile: string): Promise<LibraryItemDto> {
  const row = getRow(id);
  if (!row) throw new KolError(404, 'Không tìm thấy mục trong thư viện.');
  const dir = ensureKolDir(kolPaths.library());
  const stem = `${id}-${randomUUID().slice(0, 8)}`;
  const stored = await storeImage(tempFile, dir, stem);
  const rel = toKolRel(stored.abs);
  kolDb().prepare('UPDATE kol_library SET file = ?, updated_at = ? WHERE id = ?').run(rel, nowSec(), id);
  if (row.file && row.file !== rel) { try { fs.rmSync(resolveKolFile(row.file), { force: true }); } catch { /* ignore */ } }
  // The KOLs' own photos were drawn from the old image (an outfit, a hairstyle): redraw them.
  clearPersonaPreviews(id);
  return libraryToDto(getRow(id)!);
}

/** Items by id for the composer; unknown ids → 404, items of another persona → 400. */
export function resolveLibraryItems(ids: Partial<Record<LibraryKind, string | undefined>>, personaId: string): Partial<Record<LibraryKind, LibraryItemDto>> {
  const out: Partial<Record<LibraryKind, LibraryItemDto>> = {};
  for (const kind of LIBRARY_KINDS) {
    const id = ids[kind];
    if (!id) continue;
    const item = getLibraryItem(id);
    if (!item) throw new KolError(404, `Không tìm thấy mục thư viện (${kind}).`);
    if (item.kind !== kind) throw new KolError(400, `Mục "${item.name}" không phải loại ${kind}.`);
    if (item.personaId && item.personaId !== personaId) throw new KolError(400, `Mục "${item.name}" thuộc KOL khác.`);
    out[kind] = item;
  }
  return out;
}

/** Most camera items one request may combine (one per axis: lens, shot size, angle, movement, plus a spare). */
export const MAX_CAMERA_PICKS = 5;

/**
 * A camera setup of several items (lens, shot size, angle, movement) as one
 * slot for the composer: names joined with " · ", prompt fragments with "; ",
 * in the order given. Duplicates are ignored; the same checks as other slots.
 */
export function resolveCameraSetup(ids: (string | undefined)[], personaId: string): LibraryItemDto | null {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length > MAX_CAMERA_PICKS) throw new KolError(400, `Tối đa ${MAX_CAMERA_PICKS} thiết lập máy cho một lần tạo.`);
  const items = unique.map((id) => resolveLibraryItems({ camera: id }, personaId).camera!);
  if (items.length <= 1) return items[0] ?? null;
  const fragment = (p: string) => p.trim().replace(/[\s.;,]+$/, '');
  return {
    ...items[0],
    id: items.map((i) => i.id).join('+'),
    name: items.map((i) => i.name).join(' · '),
    prompt: items.map((i) => fragment(i.prompt)).filter(Boolean).join('; '),
    imageUrl: null,
    previewUrl: null,
    previewIsPersona: false,
    gender: 'all',
    tags: [...new Set(items.flatMap((i) => i.tags))],
  };
}
