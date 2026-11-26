// HTTP API under /api/m/learn. Read-only except the manual sync: every number comes from stats.ts over the notes.
import type { Hono } from 'hono';
import type { ModuleContext } from '../../../src/modules/sdk.js';
import { MILESTONE_LABELS, MILESTONES, NOTE_DIR } from './note-format.js';
import type { PostNoteSync } from './post-notes.js';
import { DEFAULT_DAYS, DEFAULT_MOC, comparePost, contentLabStats, isMilestone, type NoteInput } from './stats.js';

const nowSec = () => Math.floor(Date.now() / 1000);
const err = (code: string, message: string) => ({ error: { code, message } });

function daysParam(v: string | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_DAYS;
}

export const MOC_OPTIONS = MILESTONES.map((m) => ({ value: m, label: MILESTONE_LABELS[m]! }));

export function registerRoutes(app: Hono, ctx: ModuleContext, sync: () => PostNoteSync | null): void {
  const folder = () => String(ctx.settings.get<string>('folder', '') ?? '').trim();
  const status = () => sync()?.status() ?? { state: 'no-folder' as const, folder: folder(), cursor: 0, backfilledFolder: null, notes: 0, lastRunAt: null, lastError: null };

  /** bai-dang notes of the folder, or undefined when the folder is not usable */
  function readNotes(): NoteInput[] | undefined {
    const f = folder();
    if (!f) return undefined;
    try {
      return ctx.brain.notes.list(f, NOTE_DIR, { loai: 'bai-dang' }).map((n) => ({ relPath: n.relPath, data: n.data }));
    } catch {
      return undefined;
    }
  }

  app.get('/status', (c) => c.json({ ...status(), dir: `${NOTE_DIR}/` }));

  app.post('/sync', async (c) => {
    const s = sync();
    if (!s) return c.json(err('unavailable', 'Module chưa chạy.'), 503);
    return c.json(await s.run());
  });

  app.get('/content-lab', (c) => {
    const days = daysParam(c.req.query('days'));
    const mocQ = c.req.query('moc') ?? DEFAULT_MOC;
    if (!isMilestone(mocQ)) return c.json(err('bad_request', `Mốc "${mocQ}" không hợp lệ. Chọn một trong: ${MILESTONES.join(', ')}.`), 400);
    const notes = readNotes();
    const st = status();
    const base = { status: st, dir: `${NOTE_DIR}/`, mocs: MOC_OPTIONS };
    if (!notes) return c.json({ ...base, stats: null });
    return c.json({ ...base, stats: contentLabStats(notes, { days, moc: mocQ, now: nowSec() }) });
  });

  app.get('/posts/*', (c) => {
    const raw = c.req.path.replace(/^.*?\/posts\//, '');
    let path: string;
    try {
      path = decodeURIComponent(raw);
    } catch {
      return c.json(err('bad_request', 'Đường dẫn ghi chú không hợp lệ.'), 400);
    }
    if (!path.startsWith(`${NOTE_DIR}/`) || !path.endsWith('.md') || path.split('/').includes('..')) {
      return c.json(err('bad_request', `Chỉ xem được ghi chú trong ${NOTE_DIR}/.`), 400);
    }
    const mocQ = c.req.query('moc');
    if (mocQ !== undefined && !isMilestone(mocQ)) return c.json(err('bad_request', `Mốc "${mocQ}" không hợp lệ.`), 400);
    const f = folder();
    if (!f) return c.json(err('not_found', 'Chưa chọn thư mục Second Brain cho module Học.'), 404);
    let note;
    try {
      note = ctx.brain.notes.read({ folderId: f, relPath: path });
    } catch (e) {
      return c.json(err('bad_request', (e as Error).message), 400);
    }
    if (!note || note.data.loai !== 'bai-dang') return c.json(err('not_found', 'Không tìm thấy ghi chú bài đăng này.'), 404);
    const notes = readNotes() ?? [];
    const days = daysParam(c.req.query('days'));
    const comparison = comparePost(notes, note.relPath, { days, moc: mocQ, now: nowSec() });
    return c.json({ folder: f, path: note.relPath, data: note.data, body: note.body, comparison, mocs: MOC_OPTIONS, days });
  });
}
