// Notes service: the one place that writes brain notes. Frontmatter-aware, schema-checked by `loai`,
// atomic (temp file + rename), optimistic concurrency by mtime and content hash, write grants checked for agents.
//
// Who writes is never a string the caller picks. Core hands out services already bound to a principal:
//   notes.owner()          the person, through the HTTP API
//   notes.forModule(id)    module code (ctx.brain.notes); the module cannot change it
//   notes.forSystem(id)    a core subsystem acting on an explicit owner request (pack install: 'packs')
//   ….asAgent(agentId)     on behalf of an agent: every read and write is checked against access.brain globs
//
// After a write: the file alone is re-indexed (brain.indexPaths), `brain:changed` is emitted, the write is
// remembered for a few seconds so the file watcher skips it, and the path is queued for a git commit that
// coalesces every write of the next ~2 s in that folder (batch() makes one commit for a whole job).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/log.js';
import type { BrainCommit, BrainGit, CommitQueue } from './brain-git.js';
import type { BrainService } from './contracts.js';
import { composeNote, parseFrontmatter, writeFrontmatter } from './frontmatter.js';
import { normalizeRel } from './glob.js';
import { setBlock as setBlockText } from './note-blocks.js';
import { checkNote } from './note-schemas.js';

export interface NoteRef {
  folderId: string;
  relPath: string;
}
export interface Note<T = Record<string, unknown>> extends NoteRef {
  data: T;
  body: string;
  mtimeMs: number;
  /** sha256 of the file content (hex); pass back as expectHash */
  hash: string;
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
  constructor(
    readonly issues: string[],
    loai?: string,
  ) {
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
/** Bad path, not markdown, too large, unknown folder, missing expectation: the request itself is wrong. */
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

export type Principal = { kind: 'owner' } | { kind: 'module'; id: string } | { kind: 'agent'; id: string } | { kind: 'system'; id: string };

export const principalName = (p: Principal): string => (p.kind === 'owner' ? 'owner' : `${p.kind}:${p.id}`);

/**
 * Changing a note that exists needs proof the caller saw the current version: `expectMtimeMs` and/or
 * `expectHash` from the Note it read. `overwrite: true` is the explicit "I do not care what is there".
 */
export interface UpdateOpts {
  message: string;
  expectMtimeMs?: number;
  expectHash?: string;
  overwrite?: boolean;
}
export interface CreateOpts {
  message: string;
}

export interface NotesService {
  /** 'owner' | 'module:<id>' | 'agent:<id>' | 'system:<id>' */
  readonly principal: string;
  read<T = Record<string, unknown>>(ref: NoteRef): Note<T> | undefined;
  /** Notes under `dir` ('' = whole folder), recursive, sorted by path. Agents only see what they may read. */
  list<T = Record<string, unknown>>(folderId: string, dir: string, filter?: { loai?: string }): Note<T>[];
  /** Set frontmatter keys (undefined = remove). The body is kept byte for byte. */
  patch(ref: NoteRef, patch: Record<string, unknown>, opts: UpdateOpts): Note;
  /** Replace the text of managed block `name` (see note-blocks.ts), appending the block when absent. */
  setBlock(ref: NoteRef, name: string, markdown: string, opts: UpdateOpts): Note;
  /** New note; NoteConflictError when the file already exists. */
  create(ref: NoteRef, data: Record<string, unknown>, body: string, opts: CreateOpts): Note;
  /** Whole-file write (the note editor). Creates a missing file; an existing one needs an expectation or overwrite. */
  write(ref: NoteRef, content: string, opts: UpdateOpts): Note;
  /**
   * Delete a note. Like write, it needs the version the caller saw (expectHash / expectMtimeMs) or overwrite: true.
   * false when the file is already gone (and no expectation was given).
   */
  remove(ref: NoteRef, opts: UpdateOpts): boolean;
  /** Notes in the same folder that link here with [[slug]] (from brain_links). */
  backlinks(ref: NoteRef): NoteRef[];
  /** Git history of the note, newest first; [] when the folder is not a git repo. */
  history(ref: NoteRef, limit?: number): BrainCommit[];
  /**
   * Put the note back as it was just before commit `hash`, as a normal write (indexed, event, new commit).
   * Without an expectation it overwrites whatever is there now: a revert is a deliberate act.
   *
   * Careful with notes that mirror database rows (a customer note mirrors care_customers): reverting the
   * file re-imports the old values into the database through the sync that watches it. Callers that mirror
   * rows must decide what a revert means for them before offering it.
   */
  revert(ref: NoteRef, hash: string, opts?: Partial<UpdateOpts>): Note;
  /**
   * Run `fn` with a service whose writes are collected and committed as ONE commit with `message` when fn
   * ends (also when it throws: the files are written). One `brain:changed` per folder at the end.
   */
  batch<T>(message: string, fn: (notes: NotesService) => T | Promise<T>): Promise<T>;
}

export interface ModuleNotes extends NotesService {
  /** The same service acting for an agent: its access.brain read/write globs are checked on every call. */
  asAgent(agentId: string): NotesService;
}

export interface Notes {
  owner(): NotesService;
  forModule(moduleId: string): ModuleNotes;
  forAgent(agentId: string): NotesService;
  /** A core subsystem (not a module, not an agent) that writes on an explicit owner request, e.g. 'packs'. */
  forSystem(id: string): NotesService;
  /** true when the file now holds exactly what this service wrote a moment ago (the watcher skips it) */
  isOwnWrite(folderId: string, relPath: string, hash: string): boolean;
  /** commit everything queued, now */
  flush(): Promise<void>;
}

export interface NotesDeps {
  brain: Pick<BrainService, 'folders' | 'indexPaths' | 'backlinks'>;
  /** AccessPolicy.canReadPath / canWritePath */
  canRead(agentId: string, folderId: string, relPath: string): boolean;
  canWrite(agentId: string, folderId: string, relPath: string): boolean;
  log: Logger;
  bus?: Pick<EventBus, 'emit'>;
  /** history/contentBefore for history() and revert() */
  git?: Pick<BrainGit, 'history' | 'contentBefore'>;
  commits?: CommitQueue;
}

/** payload of the `brain:changed` custom event */
export interface BrainChanged {
  folderId: string;
  paths: string[];
  /** principal for writes made through this service; absent for edits seen by the file watcher */
  by?: string;
}

const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);
const MAX_FILE_BYTES = 1024 * 1024;
/** how long a write of ours is recognised by the watcher */
const OWN_WRITE_TTL_MS = 10_000;

export const hashOf = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Deepest existing ancestor of `target`, resolved through symlinks. */
function realAncestor(target: string): string {
  let cur = target;
  for (;;) {
    try {
      return fs.realpathSync(cur);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return cur;
      cur = up;
    }
  }
}

interface Resolved {
  root: string;
  rel: string;
  abs: string;
}

interface Current {
  text: string;
  st: fs.Stats;
  hash: string;
}

/** writes collected by batch(): folder → root + paths */
type BatchSink = Map<string, { root: string; paths: Set<string> }>;

export function createNotes(deps: NotesDeps): Notes {
  const { brain, log } = deps;
  const ownWrites = new Map<string, { hash: string; at: number }>();
  const ownKey = (folderId: string, rel: string) => `${folderId}\0${rel}`;

  function rememberOwn(folderId: string, rel: string, hash: string): void {
    const now = Date.now();
    for (const [k, v] of ownWrites) if (now - v.at > OWN_WRITE_TTL_MS) ownWrites.delete(k);
    ownWrites.set(ownKey(folderId, rel), { hash, at: now });
  }

  function emitChanged(e: BrainChanged): void {
    deps.bus?.emit({ type: 'custom', name: 'brain:changed', payload: e });
  }

  function folderRoot(folderId: string): string {
    const f = brain.folders().find((x) => x.id === folderId);
    if (!f) throw new NoteInputError(`Không có thư mục Second Brain "${folderId}".`);
    try {
      return fs.realpathSync(f.path);
    } catch {
      throw new NoteInputError(`Thư mục "${folderId}" chưa tồn tại trên máy.`);
    }
  }

  /** Throws when any existing segment under root is a symlink, or the real path leaves root. */
  function checkSegments(root: string, rel: string): void {
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
    if (!within(root, realAncestor(path.join(root, ...rel.split('/'))))) throw new NoteInputError('Đường dẫn trỏ ra ngoài thư mục Second Brain, đã chặn.');
  }

  /** Canonical path inside the folder: no `..`, no absolute path, no symlink at any segment, `.md` only. */
  function resolve(ref: NoteRef): Resolved {
    const rel = normalizeRel(ref.relPath);
    if (rel === null || rel === '') throw new NoteInputError('Đường dẫn không hợp lệ: không được dùng "..", đường dẫn tuyệt đối hoặc để trống.');
    if (!rel.toLowerCase().endsWith('.md')) throw new NoteInputError('Chỉ được ghi file Markdown (.md).');
    const root = folderRoot(ref.folderId);
    checkSegments(root, rel);
    return { root, rel, abs: path.join(root, ...rel.split('/')) };
  }

  function current(abs: string): Current | undefined {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return undefined;
    }
    if (!st.isFile()) return undefined;
    if (st.size > MAX_FILE_BYTES) throw new NoteInputError('Ghi chú quá lớn (trên 1 MB).');
    const text = fs.readFileSync(abs, 'utf8');
    return { text, st, hash: hashOf(text) };
  }

  function toNote<T>(folderId: string, rel: string, text: string, mtimeMs: number, hash = hashOf(text)): Note<T> {
    const fm = parseFrontmatter(text);
    return { folderId, relPath: rel, data: fm.data as T, body: fm.body, mtimeMs, hash };
  }

  function parseOrThrow(text: string): ReturnType<typeof parseFrontmatter> {
    try {
      return parseFrontmatter(text);
    } catch (e) {
      throw new NoteSchemaError([`YAML đầu file lỗi: ${(e as Error).message.split('\n')[0]}`]);
    }
  }

  function checkSchema(data: Record<string, unknown>): void {
    const issues = checkNote(data);
    if (issues.length) throw new NoteSchemaError(issues, String(data.loai));
  }

  /** The caller must show which version it changes, unless it explicitly overwrites. */
  function checkExpected(cur: Current | undefined, opts: UpdateOpts, ref: NoteRef): void {
    const hasExpect = opts.expectMtimeMs !== undefined || opts.expectHash !== undefined;
    if (!cur) {
      if (hasExpect) throw new NoteConflictError('Ghi chú đã bị xoá hoặc đổi tên ở nơi khác.');
      return;
    }
    if (!hasExpect) {
      if (opts.overwrite) return;
      throw new NoteInputError(`Ghi chú ${ref.folderId}/${ref.relPath} đã có: cần expectMtimeMs/expectHash của bản đã đọc, hoặc overwrite: true.`);
    }
    // the hash decides when given (mtime alone misses two writes in the same millisecond); else whole milliseconds
    if (opts.expectHash !== undefined) {
      if (opts.expectHash !== cur.hash) throw new NoteConflictError();
    } else if (Math.floor(cur.st.mtimeMs) !== Math.floor(opts.expectMtimeMs!)) throw new NoteConflictError();
  }

  /** Temp file in the same directory, then rename (or hard link for create-if-absent): never a half-written note. */
  function atomicWrite(r: Resolved, text: string, prev: Current | undefined, exclusive: boolean): fs.Stats {
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new NoteInputError('Nội dung quá lớn (trên 1 MB).');
    const dir = path.dirname(r.abs);
    fs.mkdirSync(dir, { recursive: true });
    checkSegments(r.root, r.rel); // a symlinked parent could only appear now
    // re-read right before writing: anything that changed since we read it is a conflict
    const now = current(r.abs);
    if (exclusive ? now !== undefined : (now?.hash !== prev?.hash || (now && prev && now.st.mtimeMs !== prev.st.mtimeMs))) {
      throw new NoteConflictError(exclusive ? `Ghi chú ${r.rel} đã có.` : undefined);
    }
    const tmp = path.join(dir, `.${path.basename(r.abs)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.aios-tmp`);
    try {
      fs.writeFileSync(tmp, text, { flag: 'wx', ...(prev ? { mode: prev.st.mode & 0o777 } : {}) });
      if (exclusive) {
        try {
          fs.linkSync(tmp, r.abs); // fails when the file appeared meanwhile
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new NoteConflictError(`Ghi chú ${r.rel} đã có.`);
          throw e;
        }
        fs.unlinkSync(tmp);
      } else fs.renameSync(tmp, r.abs);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      throw e;
    }
    return fs.statSync(r.abs);
  }

  function bind(p: Principal, sink?: BatchSink): ModuleNotes {
    const principal = principalName(p);
    const agentId = p.kind === 'agent' ? p.id : undefined;

    const mayRead = (folderId: string, rel: string) => agentId === undefined || deps.canRead(agentId, folderId, rel);
    function guardWrite(ref: NoteRef, rel: string): void {
      if (agentId !== undefined && !deps.canWrite(agentId, ref.folderId, rel)) throw new NoteAccessError(`Agent "${agentId}" không có quyền ghi ${ref.folderId}/${rel}.`);
    }

    function commit(ref: NoteRef, r: Resolved, text: string, prev: Current | undefined, exclusive: boolean, message: string): Note {
      const st = atomicWrite(r, text, prev, exclusive);
      const note: Note = toNote(ref.folderId, r.rel, text, st.mtimeMs);
      rememberOwn(ref.folderId, r.rel, note.hash);
      // the file is written: what follows is bookkeeping and must not turn a good write into an error
      changed(ref, r, message);
      return note;
    }

    /** Re-index, then queue the commit (or collect it for the running batch) and announce the change. */
    function changed(ref: NoteRef, r: Resolved, message: string): void {
      try {
        brain.indexPaths(ref.folderId, [r.rel]);
      } catch (e) {
        log.warn({ file: r.rel, err: (e as Error).message }, 'lập chỉ mục ghi chú vừa đổi lỗi');
      }
      if (sink) {
        const s = sink.get(ref.folderId) ?? { root: r.root, paths: new Set<string>() };
        s.paths.add(r.rel);
        sink.set(ref.folderId, s);
      } else {
        emitChanged({ folderId: ref.folderId, paths: [r.rel], by: principal });
        deps.commits?.add(r.root, [r.rel], message, principal);
      }
    }

    /** Shared path of patch/setBlock: read, check, transform, write. */
    function update(ref: NoteRef, opts: UpdateOpts, transform: (text: string) => string, schema: boolean): Note {
      const r = resolve(ref);
      guardWrite(ref, r.rel);
      const cur = current(r.abs);
      if (!cur) throw new NoteNotFoundError(ref);
      checkExpected(cur, opts, ref);
      const next = transform(cur.text);
      if (schema) checkSchema(parseOrThrow(next).data);
      if (next === cur.text) return toNote(ref.folderId, r.rel, cur.text, cur.st.mtimeMs, cur.hash);
      return commit(ref, r, next, cur, false, opts.message);
    }

    const svc: ModuleNotes = {
      principal,

      read<T>(ref: NoteRef) {
        const r = resolve(ref);
        if (!mayRead(ref.folderId, r.rel)) throw new NoteAccessError(`Agent "${agentId}" không có quyền đọc ${ref.folderId}/${r.rel}.`);
        const cur = current(r.abs);
        return cur ? toNote<T>(ref.folderId, r.rel, cur.text, cur.st.mtimeMs, cur.hash) : undefined;
      },

      list<T>(folderId: string, dir: string, filter: { loai?: string } = {}) {
        const root = folderRoot(folderId);
        const base = normalizeRel(dir);
        if (base === null) throw new NoteInputError('Thư mục không hợp lệ.');
        if (base) {
          try {
            checkSegments(root, base);
          } catch {
            return [];
          }
        }
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
            if (!e.isFile() || !e.name.toLowerCase().endsWith('.md') || !mayRead(folderId, rel)) continue;
            try {
              const cur = current(abs);
              if (!cur) continue;
              const note = toNote<T>(folderId, rel, cur.text, cur.st.mtimeMs, cur.hash);
              if (filter.loai !== undefined && (note.data as Record<string, unknown>).loai !== filter.loai) continue;
              out.push(note);
            } catch (err) {
              log.warn({ file: rel, err: (err as Error).message }, 'bỏ qua ghi chú không đọc được');
            }
          }
        };
        visit(base ? path.join(root, ...base.split('/')) : root, base);
        return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
      },

      patch(ref, patch, opts) {
        return update(ref, opts, (text) => {
          parseOrThrow(text);
          return writeFrontmatter(text, patch);
        }, true);
      },

      setBlock(ref, name, markdown, opts) {
        return update(ref, opts, (text) => setBlockText(text, name, markdown), false);
      },

      create(ref, data, body, opts) {
        const r = resolve(ref);
        guardWrite(ref, r.rel);
        if (current(r.abs)) throw new NoteConflictError(`Ghi chú ${ref.folderId}/${r.rel} đã có.`);
        checkSchema(data);
        return commit(ref, r, composeNote(data, body), undefined, true, opts.message);
      },

      write(ref, content, opts) {
        const r = resolve(ref);
        guardWrite(ref, r.rel);
        const cur = current(r.abs);
        checkExpected(cur, opts, ref);
        // the owner may save whatever they typed (Obsidian would let them too); machines must respect the schema
        if (p.kind !== 'owner') checkSchema(parseOrThrow(content).data);
        if (cur && content === cur.text) return toNote(ref.folderId, r.rel, cur.text, cur.st.mtimeMs, cur.hash);
        return commit(ref, r, content, cur, !cur, opts.message);
      },

      remove(ref, opts) {
        const r = resolve(ref);
        guardWrite(ref, r.rel);
        const cur = current(r.abs);
        checkExpected(cur, opts, ref);
        if (!cur) return false;
        // re-check right before unlinking: a change since we read it is a conflict
        checkSegments(r.root, r.rel);
        const now = current(r.abs);
        if (!now || now.hash !== cur.hash) throw new NoteConflictError();
        fs.unlinkSync(r.abs);
        changed(ref, r, opts.message);
        return true;
      },

      backlinks(ref) {
        const r = resolve(ref);
        return brain
          .backlinks(ref.folderId, r.rel)
          .filter((src) => mayRead(ref.folderId, src))
          .map((src) => ({ folderId: ref.folderId, relPath: src }));
      },

      history(ref, limit) {
        const r = resolve(ref);
        if (!mayRead(ref.folderId, r.rel)) throw new NoteAccessError(`Agent "${agentId}" không có quyền đọc ${ref.folderId}/${r.rel}.`);
        return deps.git?.history(r.root, r.rel, limit) ?? [];
      },

      revert(ref, hash, opts = {}) {
        const r = resolve(ref);
        guardWrite(ref, r.rel);
        if (!deps.git) throw new NoteInputError('Chưa bật lịch sử git cho brain.');
        let before: string | undefined;
        try {
          before = deps.git.contentBefore(r.root, r.rel, hash);
        } catch (e) {
          throw new NoteInputError((e as Error).message);
        }
        if (before === undefined) throw new NoteInputError(`Ghi chú ${r.rel} chưa có trước commit ${hash.slice(0, 7)}, không có bản để khôi phục.`);
        const cur = current(r.abs);
        const hasExpect = opts.expectMtimeMs !== undefined || opts.expectHash !== undefined;
        checkExpected(cur, { message: '', ...opts, overwrite: !hasExpect }, ref);
        const message = opts.message ?? `Hoàn tác ${r.rel} về trước ${hash.slice(0, 7)}`;
        if (cur && cur.text === before) return toNote(ref.folderId, r.rel, cur.text, cur.st.mtimeMs, cur.hash);
        return commit(ref, r, before, cur, !cur, message);
      },

      async batch<T>(message: string, fn: (notes: NotesService) => T | Promise<T>): Promise<T> {
        if (sink) return fn(svc); // nested: the outer batch commits
        const mine: BatchSink = new Map();
        try {
          return await fn(bind(p, mine));
        } finally {
          for (const [folderId, s] of mine) {
            emitChanged({ folderId, paths: [...s.paths].sort(), by: principal });
            if (deps.commits) void deps.commits.commitNow(s.root, [...s.paths], message, principal);
          }
        }
      },

      asAgent(id: string) {
        if (p.kind !== 'module') throw new NoteAccessError('Chỉ module mới chuyển sang quyền của agent.');
        return bind({ kind: 'agent', id });
      },
    };
    return svc;
  }

  return {
    owner: () => bind({ kind: 'owner' }),
    forModule: (id) => bind({ kind: 'module', id }),
    forAgent: (id) => bind({ kind: 'agent', id }),
    forSystem: (id) => bind({ kind: 'system', id }),
    isOwnWrite(folderId, relPath, hash) {
      const w = ownWrites.get(ownKey(folderId, relPath));
      return !!w && w.hash === hash && Date.now() - w.at <= OWN_WRITE_TTL_MS;
    },
    flush: async () => {
      await deps.commits?.flush();
    },
  };
}
