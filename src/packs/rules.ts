// Rules applied to every note of a pack before it reaches the brain. A pack is shared knowledge from someone
// else's shop: it can never arrive as verified, and every note says which pack it came from.
//
//   bai-hoc      trang_thai: gia-thuyet; dung_boi and bang_chung removed
//   cong-thuc    trang_thai: chua-thu; da_lam: 0; ket_qua and bang_chung removed
//   kenh-dream   imported as a note only (the dream module, if any, decides what to do with it)
//   mau-khach-hang  a template note only, never a customer row
//   all          nguon_goi: "<id>@<version>"; the result must pass the note schema for its `loai`
//
// Refused outright (verify.ts, before any of this): khach-hang, bai-dang, video-dream, tong-ket, and any
// `loai` not allowed for the pack's module.
import { parseFrontmatter, writeFrontmatter } from '../shared/frontmatter.js';
import { checkNote } from '../shared/note-schemas.js';
import { MAX_NOTE_BYTES } from './format.js';
import type { PackNote } from './verify.js';
import { PackError } from './zip.js';

/** Frontmatter keys set (or removed with `undefined`) per `loai`. */
const FORCED: Record<string, Record<string, unknown>> = {
  'bai-hoc': { trang_thai: 'gia-thuyet', dung_boi: undefined, bang_chung: undefined },
  // bang_chung on a formula counts the posts that proved it: a pack cannot bring that either
  'cong-thuc': { trang_thai: 'chua-thu', da_lam: 0, ket_qua: undefined, bang_chung: undefined },
};

export const packRef = (id: string, version: string): string => `${id}@${version}`;

/** The text written to the brain for one pack note. Throws PackError when the note cannot be imported. */
export function applyImportRules(note: PackNote, id: string, version: string): string {
  let data: Record<string, unknown>;
  try {
    data = parseFrontmatter(note.text).data;
  } catch {
    throw new PackError(note.zipPath, 'khối YAML đầu ghi chú lỗi');
  }
  // the quick reader (verify.ts) and the YAML parser must agree on what this note is
  if (data.loai !== note.loai) throw new PackError(note.zipPath, `loai trong ghi chú khác pack.json ("${note.loai}")`);
  let text: string;
  try {
    text = writeFrontmatter(note.text, { ...(FORCED[note.loai] ?? {}), nguon_goi: packRef(id, version) });
  } catch {
    throw new PackError(note.zipPath, 'khối YAML đầu ghi chú lỗi');
  }
  const after = parseFrontmatter(text).data;
  const issues = checkNote(after);
  if (issues.length) throw new PackError(note.zipPath, `thuộc tính không hợp lệ: ${issues.slice(0, 3).join('; ')}`);
  if (Buffer.byteLength(text) > MAX_NOTE_BYTES) throw new PackError(note.zipPath, 'ghi chú quá 1 MB');
  return text;
}
