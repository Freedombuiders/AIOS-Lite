// One-way export: care's customers -> one note per customer at khach-hang/<slug>.md in the chosen brain folder.
//
// The database is the source of truth; nothing is read back from the notes. The exporter
//   1. on first run for a folder, writes every existing customer, page by page (one notes.batch = one commit per page),
//   2. then follows care's durable change feed from the cursor it saved, re-exporting each customer that changed.
//
// Idempotent: a note is rewritten only where the machine-owned content differs (patch/setBlock write nothing when the
// text would not change). Crash-safe: the cursor is saved after the notes and the index; after a crash the same
// changes are applied again, and a customer whose index row is missing is first looked up by its `id` in the folder
// before a note is created, so no second note appears.
import type Database from 'better-sqlite3';
import type { NotesService } from '../../../src/shared/notes.js';
import type { CareCustomerView, CareCustomersApi } from '../../care/server/customers-service.js';
import { BLOCK_LOG, BLOCK_NEED, LOG_MAX, newNoteBody, NOTE_DIR, renderNote } from './note.js';
import { freeNotePath } from './slug.js';

export const BATCH_SIZE = 50;
const FEED_PAGE = 200;

export interface IndexRow {
  customer_id: string;
  folder_id: string;
  rel_path: string;
  content_hash: string | null;
  exported_at: number;
}

export interface SyncState {
  folder_id: string;
  feed_cursor: number;
  bootstrap_after: string | null;
  bootstrap_done: number;
  last_run_at: number | null;
  last_error: string | null;
}

export interface ExporterDeps {
  db: Database.Database;
  /** ctx.brain.notes (writes are signed module:crm) */
  notes: NotesService;
  /** care's customers service, or undefined while care is not enabled */
  care(): CareCustomersApi | undefined;
  /** the brain folder setting; undefined/empty = not configured */
  folderId(): string | undefined;
  attention: {
    raise(item: { key: string; title: string; detail?: string; link?: string; severity?: 'info' | 'warn' | 'error' }): void;
    resolve(key: string): void;
  };
  log: { warn(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void };
  now?: () => number;
  /** test seam: called right after a customer's note is written, before its index row is saved */
  afterNoteWrite?(customerId: string): void;
}

export type ExportStatus =
  | { state: 'chua-cau-hinh'; message: string }
  | { state: 'thieu-care'; message: string }
  | { state: 'dang-chay' | 'san-sang' | 'loi'; folderId: string; message: string };

export interface RunResult {
  /** customers whose note was created, changed or removed */
  written: number;
  /** customers looked at */
  seen: number;
}

/** Errors that belong to one note (the person broke its YAML or markers, edited it mid-write, a bad path…). */
function isNoteError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    code === 'conflict' || code === 'bad_request' || code === 'forbidden' || code === 'not_found' ||
    err.name === 'NoteBlockError' || err.name === 'YAMLParseError' || err.name === 'YAMLException'
  );
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

export function createExporter(deps: ExporterDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  let running: Promise<RunResult> | undefined;
  let stopped = false;

  const q = {
    row: db.prepare('SELECT * FROM crm_note_index WHERE customer_id = ?'),
    pathTaken: db.prepare('SELECT 1 FROM crm_note_index WHERE folder_id = ? AND rel_path = ? AND customer_id <> ?'),
    upsert: db.prepare(
      `INSERT INTO crm_note_index (customer_id, folder_id, rel_path, content_hash, exported_at) VALUES (@customer_id, @folder_id, @rel_path, @content_hash, @exported_at)
       ON CONFLICT(customer_id) DO UPDATE SET folder_id = excluded.folder_id, rel_path = excluded.rel_path,
         content_hash = excluded.content_hash, exported_at = excluded.exported_at`,
    ),
    delete: db.prepare('DELETE FROM crm_note_index WHERE customer_id = ?'),
    state: db.prepare('SELECT * FROM crm_sync_state WHERE folder_id = ?'),
    initState: db.prepare('INSERT OR IGNORE INTO crm_sync_state (folder_id, feed_cursor, bootstrap_after, bootstrap_done) VALUES (?, ?, NULL, 0)'),
    saveState: db.prepare(
      'UPDATE crm_sync_state SET feed_cursor = @feed_cursor, bootstrap_after = @bootstrap_after, bootstrap_done = @bootstrap_done, last_run_at = @last_run_at, last_error = @last_error WHERE folder_id = @folder_id',
    ),
  };

  /** customer id -> rel path of the notes in the folder that carry that id (built once per run, on first need) */
  class FolderScan {
    private map?: Map<string, string>;
    constructor(private readonly folderId: string) {}
    private build(): Map<string, string> {
      const m = new Map<string, string>();
      for (const n of deps.notes.list(this.folderId, NOTE_DIR, { loai: 'khach-hang' })) {
        const id = n.data.id;
        if ((typeof id === 'string' || typeof id === 'number') && !m.has(String(id))) m.set(String(id), n.relPath);
      }
      return m;
    }
    find(id: string): string | undefined {
      this.map ??= this.build();
      return this.map.get(id);
    }
    set(id: string, rel: string) {
      this.map?.set(id, rel);
    }
    forget(id: string) {
      this.map?.delete(id);
    }
  }

  const keyRecreated = (id: string) => `note-recreated:${id}`;
  const keyError = (id: string) => `note-error:${id}`;

  function removeNote(n: NotesService, folderId: string, customerId: string, row: IndexRow | undefined, scan: FolderScan): boolean {
    let wrote = false;
    const rel = row && row.folder_id === folderId ? row.rel_path : scan.find(customerId);
    if (rel) {
      const ref = { folderId, relPath: rel };
      const note = n.read(ref);
      // only a note that still carries this customer's id is removed
      if (note && String(note.data.id) === customerId) {
        n.remove(ref, { message: `CRM: xoá ghi chú của khách đã xoá (${rel})`, expectHash: note.hash });
        wrote = true;
      }
    }
    q.delete.run(customerId);
    scan.forget(customerId);
    deps.attention.resolve(keyRecreated(customerId));
    deps.attention.resolve(keyError(customerId));
    return wrote;
  }

  /** Bring one customer's note in line with the database. Returns true when a file was written or removed. */
  function exportCustomer(n: NotesService, folderId: string, customerId: string, scan: FolderScan, given?: CareCustomerView): boolean {
    const care = deps.care()!;
    const row = q.row.get(customerId) as IndexRow | undefined;
    const v = given ?? care.get(customerId);
    if (!v) return removeNote(n, folderId, customerId, row, scan);

    const r = renderNote(v, care.history(customerId, LOG_MAX));
    const message = `CRM: cập nhật ghi chú khách ${v.displayName}`;
    let rel = row && row.folder_id === folderId ? row.rel_path : undefined;
    let note = rel ? n.read({ folderId, relPath: rel }) : undefined;
    let recreate = false;
    if (!note) {
      // no index row (first export, or a crash before the row was saved), or the file is gone: is the note elsewhere?
      const found = scan.find(customerId);
      const foundNote = found ? n.read({ folderId, relPath: found }) : undefined;
      if (found && foundNote && String(foundNote.data.id) === customerId) {
        rel = found;
        note = foundNote;
      } else if (rel) recreate = true; // the person deleted it: write it again, at the same path when still free
    }
    const taken = (p: string) => !!q.pathTaken.get(folderId, p, customerId) || !!n.read({ folderId, relPath: p });
    if (!note && (!rel || taken(rel))) rel = freeNotePath(NOTE_DIR, v.displayName, taken);
    const ref = { folderId, relPath: rel! };

    let wrote = false;
    let cur = note;
    if (!cur) {
      cur = n.create(ref, r.frontmatter, newNoteBody(v), { message });
      wrote = true;
    } else {
      const next = n.patch(ref, r.frontmatter, { message, expectHash: cur.hash });
      wrote ||= next.hash !== cur.hash;
      cur = next;
    }
    for (const [block, text] of [
      [BLOCK_NEED, r.need],
      [BLOCK_LOG, r.log],
    ] as const) {
      const next = n.setBlock(ref, block, text, { message, expectHash: cur.hash });
      wrote ||= next.hash !== cur.hash;
      cur = next;
    }
    deps.afterNoteWrite?.(customerId);
    q.upsert.run({ customer_id: customerId, folder_id: folderId, rel_path: ref.relPath, content_hash: r.contentHash, exported_at: now() });
    scan.set(customerId, ref.relPath);
    deps.attention.resolve(keyError(customerId));
    if (recreate) {
      deps.attention.raise({
        key: keyRecreated(customerId),
        title: `Ghi chú khách "${v.displayName}" đã bị xoá nên máy tạo lại`,
        detail: `${folderId}/${ref.relPath}. Khách vẫn còn trong Chăm sóc khách hàng; muốn bỏ khách thì xoá ở đó.`,
        severity: 'info',
      });
    }
    return wrote;
  }

  /** exportCustomer with one retry on a write conflict; a note-level error is reported and skipped. */
  function exportSafely(n: NotesService, folderId: string, customerId: string, scan: FolderScan, view?: CareCustomerView): boolean {
    for (let attempt = 0; ; attempt++) {
      try {
        return exportCustomer(n, folderId, customerId, scan, attempt ? undefined : view);
      } catch (err) {
        if (!isNoteError(err)) throw err; // unexpected: abort the run, the cursor is not moved, the next run retries
        if ((err as { code?: string }).code === 'conflict' && attempt === 0) continue;
        deps.log.warn({ customerId, err: errText(err) }, 'crm: không cập nhật được ghi chú khách');
        deps.attention.raise({
          key: keyError(customerId),
          title: 'Không cập nhật được một ghi chú khách',
          detail: `${errText(err)} Máy thử lại ở lần khách này thay đổi tiếp theo.`,
          severity: 'warn',
        });
        return false;
      }
    }
  }

  function loadState(folderId: string, care: CareCustomersApi): SyncState {
    // first run for this folder: the full export covers everything up to now, the feed takes over from here
    q.initState.run(folderId, care.latestCursor());
    return q.state.get(folderId) as SyncState;
  }

  const saveState = (s: SyncState) => q.saveState.run(s);
  const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

  async function runInner(): Promise<RunResult> {
    const result: RunResult = { written: 0, seen: 0 };
    const folderId = deps.folderId()?.trim();
    const care = deps.care();
    if (!folderId || !care) return result;
    const state = loadState(folderId, care);
    const scan = new FolderScan(folderId);
    try {
      while (!state.bootstrap_done && !stopped) {
        const page = care.list({ after: state.bootstrap_after, limit: BATCH_SIZE });
        await deps.notes.batch(`CRM: xuất ghi chú cho ${page.items.length} khách`, (n) => {
          for (const c of page.items) {
            result.seen++;
            if (exportSafely(n, folderId, c.id, scan, c)) result.written++;
          }
        });
        state.bootstrap_after = page.next;
        state.bootstrap_done = page.next ? 0 : 1;
        saveState(state);
        await yieldLoop();
      }
      while (!stopped) {
        const { changes, cursor } = care.changesSince(state.feed_cursor, FEED_PAGE);
        if (!changes.length) break;
        const ids = [...new Set(changes.map((c) => c.customerId))];
        await deps.notes.batch(`CRM: cập nhật ghi chú của ${ids.length} khách`, (n) => {
          for (const id of ids) {
            result.seen++;
            if (exportSafely(n, folderId, id, scan)) result.written++;
          }
        });
        state.feed_cursor = cursor;
        saveState(state);
        await yieldLoop();
      }
      state.last_error = null;
    } catch (err) {
      state.last_error = errText(err);
      deps.log.warn({ err: state.last_error }, 'crm: lượt xuất ghi chú dừng giữa chừng, sẽ chạy lại');
      throw err;
    } finally {
      state.last_run_at = now();
      // only the bookkeeping columns: the cursor fields hold what was saved after the last completed batch
      db.prepare('UPDATE crm_sync_state SET last_run_at = ?, last_error = ? WHERE folder_id = ?').run(state.last_run_at, state.last_error, folderId);
    }
    return result;
  }

  return {
    /** One pass: first-run export if needed, then the change feed to its end. Concurrent calls share one pass. */
    run(): Promise<RunResult> {
      running ??= runInner().finally(() => {
        running = undefined;
      });
      return running;
    },

    stop(): Promise<unknown> {
      stopped = true;
      return running?.catch(() => undefined) ?? Promise.resolve();
    },

    status(): ExportStatus & { running: boolean; cursor?: number; latest?: number; bootstrapDone?: boolean; lastRunAt?: number | null; exported?: number } {
      const folderId = deps.folderId()?.trim();
      if (!folderId) {
        return { state: 'chua-cau-hinh', message: 'Chưa chọn thư mục Second Brain cho ghi chú khách. Vào cài đặt module CRM, điền mã thư mục.', running: false };
      }
      const care = deps.care();
      if (!care) return { state: 'thieu-care', message: 'Module Chăm sóc khách hàng chưa bật nên chưa có khách để xuất.', running: false };
      const s = q.state.get(folderId) as SyncState | undefined;
      const exported = (db.prepare('SELECT COUNT(*) AS n FROM crm_note_index WHERE folder_id = ?').get(folderId) as { n: number }).n;
      const latest = care.latestCursor();
      const base = { folderId, running: !!running, cursor: s?.feed_cursor ?? 0, latest, bootstrapDone: s?.bootstrap_done === 1, lastRunAt: s?.last_run_at ?? null, exported };
      if (s?.last_error) return { ...base, state: 'loi', message: `Lần xuất gần nhất lỗi: ${s.last_error}` };
      if (!s || !s.bootstrap_done) return { ...base, state: 'dang-chay', message: 'Đang tạo ghi chú cho các khách hiện có.' };
      if (s.feed_cursor < latest) return { ...base, state: 'dang-chay', message: 'Đang cập nhật ghi chú theo thay đổi mới.' };
      return { ...base, state: 'san-sang', message: 'Ghi chú khách đã khớp với dữ liệu.' };
    },

    indexRow: (customerId: string) => q.row.get(customerId) as IndexRow | undefined,
  };
}

export type CrmExporter = ReturnType<typeof createExporter>;
