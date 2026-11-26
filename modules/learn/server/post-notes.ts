// Keeps one `bai-dang` note per Facebook post published through marketing, in the brain folder chosen in the
// module settings. Reads marketing's durable contentFeed with a cursor kept in learn_state (never ctx.events:
// the SDK prefixes event names with the listener's module id, and in-memory events are lost on restart).
//
// Every pass is idempotent: an event only names a post; the note is rebuilt from the post's current row
// (contentFeed.get), so replaying the feed or crashing between a write and the cursor save creates nothing twice.
// What the machine owns in a note: the frontmatter keys it wrote and the `so-do` managed block. Everything else
// (body text, keys the owner adds, values the owner corrects such as tru_cot or mo_dau) is left as it is.
import type { ContentFeed, ContentWithLineage } from '../../_lib/content-feed.js';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import {
  BLOCK_NAME,
  NOTE_DIR,
  SOURCE,
  VIDEO_FORMATS,
  blockMarkdown,
  initialBody,
  initialData,
  measuredMilestones,
  mergeSoDo,
  notePath,
  videoLengthOf,
} from './note-format.js';

type Notes = ModuleContext['brain']['notes'];
type NotesLike = Pick<Notes, 'read' | 'list' | 'create' | 'patch' | 'setBlock' | 'batch'>;
type Db = ModuleContext['db'];
type Log = Pick<ModuleContext['log'], 'info' | 'warn' | 'error'>;

export const BACKFILL_DAYS = 90;
const PAGE = 100;
const DAY = 86400;

export type SyncState = 'ok' | 'no-folder' | 'folder-missing' | 'no-marketing';

export interface SyncStatus {
  state: SyncState;
  /** the folder setting ('' = not chosen) */
  folder: string;
  cursor: number;
  /** folder the 90-day backfill was done for */
  backfilledFolder: string | null;
  /** notes indexed in the current folder */
  notes: number;
  lastRunAt: number | null;
  lastError: string | null;
}

export interface SyncResult {
  state: SyncState;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  backfilled: boolean;
}

export interface PostNoteSyncDeps {
  db: Db;
  notes: NotesLike;
  /** marketing's contentFeed, undefined when marketing is not enabled */
  feed(): ContentFeed | undefined;
  /** the folder setting, '' when not chosen */
  folder(): string;
  /** timezone of a Page (for the note's date and times) */
  timezone(pageId: string | null): string;
  log: Log;
  /** unix seconds */
  now?(): number;
}

export interface PostNoteSync {
  run(): Promise<SyncResult>;
  status(): SyncStatus;
}

const isConflict = (e: unknown) => (e as { code?: unknown })?.code === 'conflict';

export function createPostNoteSync(deps: PostNoteSyncDeps): PostNoteSync {
  const { db, log } = deps;
  const now = () => deps.now?.() ?? Math.floor(Date.now() / 1000);
  let lastRunAt: number | null = null;
  let lastError: string | null = null;
  let lastState: SyncState = 'no-folder';
  let running: Promise<SyncResult> | null = null;

  const getState = (key: string): string | null =>
    (db.prepare('SELECT value FROM learn_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  const setState = (key: string, value: string) =>
    db.prepare(
      `INSERT INTO learn_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, now());
  const cursor = () => Number(getState('feed_cursor') ?? 0) || 0;

  const indexed = (folder: string, id: number) =>
    (db.prepare('SELECT rel_path FROM learn_post_index WHERE folder_id = ? AND source = ? AND source_id = ?').get(folder, SOURCE, String(id)) as
      | { rel_path: string }
      | undefined)?.rel_path;
  const remember = (folder: string, id: number, relPath: string) =>
    db.prepare(
      `INSERT INTO learn_post_index (folder_id, source, source_id, rel_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(folder_id, source, source_id) DO UPDATE SET rel_path = excluded.rel_path, updated_at = excluded.updated_at`,
    ).run(folder, SOURCE, String(id), relPath, now(), now());

  const isOurs = (data: Record<string, unknown> | undefined, id: number) =>
    !!data && data.loai === 'bai-dang' && data.nen_tang === 'facebook' && Number(data.id) === id;

  type Found = { relPath: string; data: Record<string, unknown>; hash: string };
  /** Facebook notes of the folder by post id, read once per batch and only when an indexed path is missing. */
  type Scan = { byId?: Map<number, Found> };

  /** The note of the post: the indexed path, else (moved or renamed by the owner) a note with its id. */
  function locate(n: NotesLike, folder: string, id: number, scan: Scan): Found | undefined {
    const known = indexed(folder, id);
    if (known) {
      const note = n.read({ folderId: folder, relPath: known });
      if (note && isOurs(note.data, id)) return { relPath: note.relPath, data: note.data, hash: note.hash };
    }
    if (!scan.byId) {
      scan.byId = new Map();
      for (const x of n.list(folder, NOTE_DIR, { loai: 'bai-dang' })) {
        if (x.data.nen_tang === 'facebook' && Number.isInteger(Number(x.data.id))) scan.byId.set(Number(x.data.id), { relPath: x.relPath, data: x.data, hash: x.hash });
      }
    }
    const found = scan.byId.get(id);
    if (!found) return undefined;
    // read again: the scan may be older than a write made in this batch
    const note = n.read({ folderId: folder, relPath: found.relPath });
    if (!note || !isOurs(note.data, id)) return undefined;
    remember(folder, id, note.relPath);
    return { relPath: note.relPath, data: note.data, hash: note.hash };
  }

  function create(n: NotesLike, folder: string, c: ContentWithLineage, tz: string): void {
    const data = initialData(c, tz);
    const body = initialBody(c, data.so_do as never);
    for (const withId of [false, true]) {
      const relPath = notePath(c, tz, withId);
      try {
        n.create({ folderId: folder, relPath }, data, body, { message: `Học: ghi chú bài đăng #${c.id}` });
        remember(folder, c.id, relPath);
        return;
      } catch (e) {
        if (!isConflict(e)) throw e;
        const there = n.read({ folderId: folder, relPath });
        if (there && isOurs(there.data, c.id)) {
          // written by an earlier pass that stopped before indexing it
          remember(folder, c.id, relPath);
          update(n, folder, c, tz, { relPath, data: there.data, hash: there.hash });
          return;
        }
      }
    }
    throw new Error(`Không đặt được tên ghi chú cho bài #${c.id}.`);
  }

  /** so_do and the managed block from the post's snapshots; missing static facts are filled, never replaced. */
  function update(n: NotesLike, folder: string, c: ContentWithLineage, tz: string, note: { relPath: string; data: Record<string, unknown>; hash: string }): boolean {
    const ref = { folderId: folder, relPath: note.relPath };
    const soDo = mergeSoDo(note.data.so_do, c.snapshots, tz);
    const patch: Record<string, unknown> = { so_do: soDo, moc_da_do: measuredMilestones(soDo) };
    const missing = (k: string) => note.data[k] === undefined || note.data[k] === null || note.data[k] === '';
    if (missing('do_dai') && VIDEO_FORMATS.has(String(note.data.dinh_dang))) {
      const len = videoLengthOf(c.snapshots);
      if (len !== undefined) patch.do_dai = len;
    }
    if (missing('link') && c.permalink) patch.link = c.permalink;
    if (missing('ma_bai') && c.fbPostId) patch.ma_bai = c.fbPostId;
    const before = note.hash;
    const after = n.patch(ref, patch, { message: `Học: số đo bài #${c.id}`, expectHash: note.hash });
    let final = after;
    try {
      final = n.setBlock(ref, BLOCK_NAME, blockMarkdown(soDo), { message: `Học: số đo bài #${c.id}`, expectHash: after.hash });
    } catch (e) {
      if (isConflict(e)) throw e;
      // the owner broke the block markers: the frontmatter is updated, the table waits until they fix it
      log.warn({ file: note.relPath, err: (e as Error).message }, 'learn: không cập nhật được bảng số đo trong ghi chú');
    }
    return final.hash !== before;
  }

  /** Create or update the note of one post. */
  function upsert(n: NotesLike, feed: ContentFeed, folder: string, id: number, scan: Scan): 'created' | 'updated' | 'skipped' {
    const c = feed.get(id);
    // only posts published through the studio (not ones analytics imported from the Page)
    if (!c || c.origin === 'imported' || c.status !== 'published' || c.publishedAt === null) return 'skipped';
    const tz = deps.timezone(c.pageId);
    for (let attempt = 0; ; attempt++) {
      try {
        const note = locate(n, folder, id, scan);
        if (!note) {
          create(n, folder, c, tz);
          return 'created';
        }
        return update(n, folder, c, tz, note) ? 'updated' : 'skipped';
      } catch (e) {
        // the owner saved the note between our read and our write: read again once
        if (isConflict(e) && attempt === 0) continue;
        throw e;
      }
    }
  }

  async function processIds(folder: string, feed: ContentFeed, ids: number[], message: string, out: SyncResult): Promise<void> {
    if (!ids.length) return;
    const scan: Scan = {};
    await deps.notes.batch(message, (n) => {
      for (const id of ids) {
        try {
          const r = upsert(n, feed, folder, id, scan);
          out[r]++;
        } catch (e) {
          out.failed++;
          lastError = `Bài #${id}: ${(e as Error).message}`;
          log.warn({ contentId: id, err: (e as Error).message }, 'learn: không ghi được ghi chú bài đăng');
        }
      }
    });
  }

  function folderExists(folder: string): boolean {
    try {
      deps.notes.read({ folderId: folder, relPath: `${NOTE_DIR}/.kiem-tra.md` });
      return true;
    } catch (e) {
      if ((e as { code?: unknown }).code === 'bad_request') return false;
      throw e;
    }
  }

  async function runOnce(): Promise<SyncResult> {
    const out: SyncResult = { state: 'ok', created: 0, updated: 0, skipped: 0, failed: 0, backfilled: false };
    const folder = deps.folder().trim();
    const done = (state: SyncState) => {
      lastState = state;
      lastRunAt = now();
      return { ...out, state };
    };
    if (!folder) return done('no-folder'); // nothing is read or written, the cursor stays where it was
    const feed = deps.feed();
    if (!feed) return done('no-marketing');
    if (!folderExists(folder)) return done('folder-missing');
    if (lastState !== 'ok') lastError = null;

    // first run for this folder: notes for the posts of the last 90 days, in batches
    if (getState('backfilled_folder') !== folder) {
      const since = now() - BACKFILL_DAYS * DAY;
      let after = 0;
      for (;;) {
        const ids = feed.publishedSince(since, after, PAGE);
        await processIds(folder, feed, ids, `Học: ghi chú các bài đã đăng trong ${BACKFILL_DAYS} ngày`, out);
        if (ids.length < PAGE) break;
        after = ids[ids.length - 1]!;
      }
      setState('backfilled_folder', folder);
      out.backfilled = true;
    }

    // then everything after the stored cursor, page by page; the cursor is saved after each page
    let at = cursor();
    for (;;) {
      const page = feed.since(at, PAGE);
      const ids = [...new Set(page.events.map((e) => e.contentId))];
      await processIds(folder, feed, ids, 'Học: cập nhật bài đăng và số đo', out);
      if (page.cursor !== at) setState('feed_cursor', String(page.cursor));
      at = page.cursor;
      if (page.events.length < PAGE) break;
    }
    if (out.created || out.updated) log.info({ created: out.created, updated: out.updated }, 'learn: đã cập nhật ghi chú bài đăng');
    return done('ok');
  }

  return {
    run() {
      // one pass at a time: the timer and a manual sync share the pass in flight
      running ??= runOnce().finally(() => {
        running = null;
      });
      return running;
    },
    status() {
      const folder = deps.folder().trim();
      const notes = folder
        ? (db.prepare('SELECT COUNT(*) AS n FROM learn_post_index WHERE folder_id = ? AND source = ?').get(folder, SOURCE) as { n: number }).n
        : 0;
      return { state: folder ? lastState : 'no-folder', folder, cursor: cursor(), backfilledFolder: getState('backfilled_folder'), notes, lastRunAt, lastError };
    },
  };
}
