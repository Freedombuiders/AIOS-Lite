// Notes service: the one place that writes brain notes. Frontmatter-aware, schema-checked by `loai`,
// write grants checked for agents, optimistic concurrency by mtime.
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/log.js';
import type { BrainService } from './contracts.js';
import { composeNote, parseFrontmatter, writeFrontmatter } from './frontmatter.js';
import { normalizeRel } from './glob.js';
import { checkNote } from './note-schemas.js';

export interface NoteRef {
  folderId: string;
  relPath: string;
}
export interface Note<T = Record<string, unknown>> extends NoteRef {
  data: T;
  body: string;
  mtimeMs: number;
}

export class NoteConflictError extends Error {
  readonly code = 'conflict';
  constructor(message = 'Ghi chú đã bị sửa ở nơi khác. Tải lại rồi sửa tiếp.') {
    super(message);
    this.name = 'NoteConflictError';
  }
}
export class NoteSchemaError extends Error {
  readonly code = 'bad_request';
  constructor(readonly issues: string[], loai?: string) {
    super(`Thuộc tính${loai ? ` của ghi chú loại "${loai}"` : ''} không hợp lệ: ${issues.slice(0, 3).join('; ')}`);
    this.name = 'NoteSchemaError';
  }
}
export class NoteAccessError extends Error {
  readonly code = 'forbidden';
  constructor(message: string) {
    super(message);
    this.name = 'NoteAccessError';
  }
}
/** Bad path, not markdown, too large, unknown folder: the request itself is wrong. */
export class NoteInputError extends Error {
  readonly code = 'bad_request';
  constructor(message: string) {
    super(message);
    this.name = 'NoteInputError';
  }
}
export class NoteNotFoundError extends Error {
  readonly code = 'not_found';
  constructor(ref: NoteRef) {
    super(`Không tìm thấy ghi chú ${ref.folderId}/${ref.relPath}.`);
    this.name = 'NoteNotFoundError';
  }
}

/** `owner` (the person, via the UI), `system` (core code), `module:<id>` (module code), or an agent id. */
export interface WriteOpts {
  actor: 'owner' | 'system' | string;
  message: string;
  expectMtimeMs?: number;
}

export interface NotesService {
  read<T = Record<string, unknown>>(ref: NoteRef): Note<T> | undefined;
  /** Set the keys in `patch` (undefined = remove). The body is kept byte for byte. */
  patch(ref: NoteRef, patch: Record<string, unknown>, opts: WriteOpts): Note;
  /** New note; throws NoteConflictError when the file already exists. */
  create(ref: NoteRef, data: Record<string, unknown>, body: string, opts: WriteOpts): Note;
  /** Whole-file write (the note editor). Creates the file when missing and `expectMtimeMs` is not given. */
  write(ref: NoteRef, content: string, opts: WriteOpts): Note;
  /** Notes under `dir` ('' = whole folder), recursive, sorted by path. */
  list<T = Record<string, unknown>>(folderId: string, dir: string, filter?: { loai?: string }): Note<T>[];
}

export interface NotesDeps {
  brain: Pick<BrainService, 'folders' | 'write'>;
  /** write grant of an agent (AccessPolicy.canWritePath) */
  canWrite(agentId: string, folderId: string, relPath: string): boolean;
  log: Logger;
}

const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);
const MAX_FILE_BYTES = 1024 * 1024;
const TRUSTED_ACTORS = new Set(['owner', 'system']);

export const isTrustedActor = (actor: string): boolean => TRUSTED_ACTORS.has(actor) || actor.startsWith('module:');

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** mtimes from different sources may be floored; a whole millisecond is the unit we compare on. */
const sameMtime = (a: number, b: number) => Math.floor(a) === Math.floor(b);

export function createNotesService(deps: NotesDeps): NotesService {
  const { brain, log } = deps;

  function folderRoot(folderId: string): string {
    const f = brain.folders().find((x) => x.id === folderId);
    if (!f) throw new NoteInputError(`Không có thư mục Second Brain "${folderId}".`);
    let real: string;
    try {
      real = fs.realpathSync(f.path);
    } catch {
      throw new NoteInputError(`Thư mục "${folderId}" chưa tồn tại trên máy.`);
    }
    return real;
  }

  /** Safe absolute path: no `..`, no absolute path, no symlink anywhere on the way, `.md` only. */
  function resolve(ref: NoteRef): { root: string; rel: string; abs: string } {
    const rel = normalizeRel(ref.relPath);
    if (rel === null || rel === '') throw new NoteInputError('Đường dẫn không hợp lệ: không được dùng "..", đường dẫn tuyệt đối hoặc để trống.');
    if (!rel.toLowerCase().endsWith('.md')) throw new NoteInputError('Chỉ được ghi file Markdown (.md).');
    const root = folderRoot(ref.folderId);
    let cur = root;
    for (const seg of rel.split('/')) {
      if (SKIP_DIRS.has(seg)) throw new NoteInputError(`Không được ghi vào thư mục ${seg}.`);
      cur = path.join(cur, seg);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(cur);
      } catch {
        break; // the rest does not exist yet
      }
      if (st.isSymbolicLink()) throw new NoteInputError('Đường dẫn đi qua liên kết tượng trưng (symlink), đã chặn.');
    }
    const abs = path.join(root, ...rel.split('/'));
    if (!within(root, abs)) throw new NoteInputError('Đường dẫn trỏ ra ngoài thư mục Second Brain, đã chặn.');
    return { root, rel, abs };
  }

  function guard(ref: NoteRef, rel: string, actor: string): void {
    if (isTrustedActor(actor)) return;
    if (!deps.canWrite(actor, ref.folderId, rel)) throw new NoteAccessError(`Agent "${actor}" không có quyền ghi ${ref.folderId}/${rel}.`);
  }

  function statOf(abs: string): fs.Stats | undefined {
    try {
      const st = fs.statSync(abs);
      return st.isFile() ? st : undefined;
    } catch {
      return undefined;
    }
  }

  function toNote<T>(folderId: string, rel: string, text: string, mtimeMs: number): Note<T> {
    const fm = parseFrontmatter(text);
    return { folderId, relPath: rel, data: fm.data as T, body: fm.body, mtimeMs };
  }

  function checkSchema(data: Record<string, unknown>): void {
    const issues = checkNote(data);
    if (issues.length) throw new NoteSchemaError(issues, String(data.loai));
  }

  function parseOrThrow(text: string): ReturnType<typeof parseFrontmatter> {
    try {
      return parseFrontmatter(text);
    } catch (e) {
      throw new NoteSchemaError([`YAML đầu file lỗi: ${(e as Error).message.split('\n')[0]}`]);
    }
  }

  function commitWrite(ref: NoteRef, rel: string, abs: string, text: string): Note {
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new NoteInputError('Nội dung quá lớn (trên 1 MB).');
    // brain.write re-checks the path, writes and indexes the file
    brain.write(ref.folderId, rel, text);
    const st = fs.statSync(abs);
    return toNote(ref.folderId, rel, text, st.mtimeMs);
  }

  function checkExpected(st: fs.Stats | undefined, expect: number | undefined): void {
    if (expect === undefined) return;
    if (!st || !sameMtime(st.mtimeMs, expect)) throw new NoteConflictError();
  }

  return {
    read<T>(ref: NoteRef) {
      const { rel, abs } = resolve(ref);
      const st = statOf(abs);
      if (!st || st.size > MAX_FILE_BYTES) return undefined;
      return toNote<T>(ref.folderId, rel, fs.readFileSync(abs, 'utf8'), st.mtimeMs);
    },

    patch(ref, patch, opts) {
      const { rel, abs } = resolve(ref);
      guard(ref, rel, opts.actor);
      const st = statOf(abs);
      if (!st) throw new NoteNotFoundError(ref);
      checkExpected(st, opts.expectMtimeMs);
      const text = fs.readFileSync(abs, 'utf8');
      const before = parseOrThrow(text);
      const merged: Record<string, unknown> = { ...before.data };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete merged[k];
        else merged[k] = v;
      }
      checkSchema(merged);
      const next = writeFrontmatter(text, patch);
      if (next === text) return toNote(ref.folderId, rel, text, st.mtimeMs);
      return commitWrite(ref, rel, abs, next);
    },

    create(ref, data, body, opts) {
      const { rel, abs } = resolve(ref);
      guard(ref, rel, opts.actor);
      if (fs.existsSync(abs)) throw new NoteConflictError(`Ghi chú ${ref.folderId}/${rel} đã có.`);
      checkSchema(data);
      return commitWrite(ref, rel, abs, composeNote(data, body));
    },

    write(ref, content, opts) {
      const { rel, abs } = resolve(ref);
      guard(ref, rel, opts.actor);
      checkExpected(statOf(abs), opts.expectMtimeMs);
      // the owner may save whatever they typed (Obsidian would let them too); machines must respect the schema
      if (opts.actor !== 'owner') checkSchema(parseOrThrow(content).data);
      return commitWrite(ref, rel, abs, content);
    },

    list<T>(folderId: string, dir: string, filter: { loai?: string } = {}) {
      const root = folderRoot(folderId);
      const base = normalizeRel(dir);
      if (base === null) throw new NoteInputError('Thư mục không hợp lệ.');
      const start = base ? path.join(root, ...base.split('/')) : root;
      const out: Note<T>[] = [];
      const visit = (absDir: string, prefix: string) => {
        let ents: fs.Dirent[];
        try {
          ents = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          if (e.isSymbolicLink()) continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          const abs = path.join(absDir, e.name);
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) visit(abs, rel);
            continue;
          }
          if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
          try {
            const st = fs.statSync(abs);
            if (st.size > MAX_FILE_BYTES) continue;
            const note = toNote<T>(folderId, rel, fs.readFileSync(abs, 'utf8'), st.mtimeMs);
            if (filter.loai !== undefined && (note.data as Record<string, unknown>).loai !== filter.loai) continue;
            out.push(note);
          } catch (err) {
            log.warn({ file: rel, err: (err as Error).message }, 'ghi chú có YAML đầu file lỗi, bỏ qua');
          }
        }
      };
      // the start dir must not itself be (or pass through) a symlink
      if (base) {
        let cur = root;
        for (const seg of base.split('/')) {
          cur = path.join(cur, seg);
          try {
            if (fs.lstatSync(cur).isSymbolicLink()) return [];
          } catch {
            return [];
          }
        }
      }
      visit(start, base);
      return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    },
  };
}
