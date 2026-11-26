// Test helpers for the learn server: a temporary brain folder behind the real notes service, an in-memory
// database with the module's migrations, and fakes for attention and audit. Not imported by production code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../../src/core/db.js';
import { createLogger } from '../../../src/core/log.js';
import { createNotes } from '../../../src/shared/notes.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface Kit {
  root: string;
  brainDir: string;
  db: ReturnType<typeof openDb>;
  notes: ReturnType<ReturnType<typeof createNotes>['forModule']>;
  owner: ReturnType<ReturnType<typeof createNotes>['owner']>;
  attention: { raised: Array<{ key: string; title: string; detail?: string }>; resolved: string[]; raise(i: { key: string; title: string; detail?: string }): void; resolve(k: string): void };
  audit: { entries: Array<{ action: string; target: string | null | undefined; actor: string | undefined }>; log(action: string, target?: string | null, detail?: Record<string, unknown>, actor?: string): void };
  log: ReturnType<typeof createLogger>;
  cleanup(): void;
}

export function makeKit(): Kit {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
  const brainDir = path.join(root, 'brain');
  fs.mkdirSync(brainDir);
  const db = openDb(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  const log = createLogger({ level: 'silent' });
  const service = createNotes({
    brain: { folders: () => [{ id: 'b1', name: 'Brain', path: brainDir }], indexPaths: () => ({ indexed: 0, removed: 0 }), backlinks: () => [] },
    canRead: () => true,
    canWrite: () => true,
    log,
  });
  const attention: Kit['attention'] = {
    raised: [],
    resolved: [],
    raise(i) {
      this.raised.push(i);
    },
    resolve(k) {
      this.resolved.push(k);
    },
  };
  const audit: Kit['audit'] = {
    entries: [],
    log(action, target, _detail, actor) {
      this.entries.push({ action, target, actor });
    },
  };
  return {
    root, brainDir, db, notes: service.forModule('learn'), owner: service.owner(), attention, audit, log,
    cleanup: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A published Facebook post note with an ER at 24h (null = not measured). */
export function writePost(kit: Kit, slug: string, er: number | null, over: Record<string, unknown> = {}): string {
  const relPath = `noi-dung/bai/${slug}.md`;
  const data: Record<string, unknown> = {
    loai: 'bai-dang', id: slug, nen_tang: 'facebook', tieu_de: slug, dinh_dang: 'video-ngan', do_dai: 40,
    dang_luc: '2026-11-20T19:00:00+07:00', so_do: er === null ? [] : [{ moc: '24h', reach: 1000, er }], ...over,
  };
  kit.notes.create({ folderId: 'b1', relPath }, data, `# ${slug}\n`, { message: 'test' });
  return relPath;
}

export function writeLesson(kit: Kit, slug: string, data: Record<string, unknown>, body = ''): string {
  const relPath = `bai-hoc/${slug}.md`;
  kit.notes.create({ folderId: 'b1', relPath }, { loai: 'bai-hoc', mang: 'noi-dung', trang_thai: 'gia-thuyet', bang_chung: [], dung_boi: [], ...data }, body || `# ${slug}\n\nNội dung bài học ${slug}.\n`, { message: 'test' });
  return relPath;
}
