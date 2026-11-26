// Watch the brain folders (config/brain.yaml) so edits made outside the app (Obsidian, an editor, git pull)
// reach the index within about a second, and announce them as `brain:changed`.
//
// Events are gathered per folder for `debounceMs` (500 ms) after the last one (at most `maxWaitMs`), then:
// changed markdown files are indexed one by one (brain.indexPaths); a directory added or removed makes the
// folder rescan incrementally (brain.reindex). Writes the notes service just made are recognised by content
// hash and skipped: the service already indexed them and announced them, and never commits twice.
import fs from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { EventBus } from '../core/events.js';
import type { Logger } from '../core/log.js';
import type { BrainService } from './contracts.js';
import type { BrainChanged } from './notes.js';
import { hashOf } from './notes.js';

const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);
const MAX_FILE_BYTES = 1024 * 1024;

export interface BrainWatchOptions {
  brain: Pick<BrainService, 'folders' | 'reloadConfig' | 'reindex' | 'indexPaths'>;
  bus: Pick<EventBus, 'emit'>;
  log: Logger;
  /** config/brain.yaml: when it changes the folder list is reloaded and the watchers rebuilt */
  configFile?: string;
  /** notes.isOwnWrite */
  isOwnWrite?(folderId: string, relPath: string, hash: string): boolean;
  debounceMs?: number;
  maxWaitMs?: number;
  /** test hook: polling instead of native events */
  usePolling?: boolean;
}

export interface BrainWatch {
  /** resolves once every watcher is ready */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** re-read brain.yaml and rebuild the watchers (also done automatically when the file changes) */
  refresh(): Promise<void>;
  /** ids of the folders being watched */
  watching(): string[];
}

interface FolderWatch {
  id: string;
  path: string;
  watcher: FSWatcher;
  paths: Set<string>;
  rescan: boolean;
  timer?: NodeJS.Timeout;
  firstAt?: number;
  running: Promise<void>;
}

/** chokidar `ignored`: anything inside .git/.obsidian/.trash/node_modules, and our own temp files */
function ignoredUnder(root: string) {
  return (p: string): boolean => {
    const rel = path.relative(root, p);
    if (!rel || rel.startsWith('..')) return false;
    const parts = rel.split(path.sep);
    if (parts.some((seg) => SKIP_DIRS.has(seg))) return true;
    return parts[parts.length - 1]!.endsWith('.aios-tmp');
  };
}

export function createBrainWatch(opts: BrainWatchOptions): BrainWatch {
  const { brain, bus, log } = opts;
  const debounceMs = opts.debounceMs ?? 500;
  const maxWaitMs = opts.maxWaitMs ?? 2000;
  const folders = new Map<string, FolderWatch>();
  let configWatcher: FSWatcher | undefined;
  let stopped = false;

  function relOf(f: FolderWatch, abs: string): string | null {
    const rel = path.relative(f.path, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  function schedule(f: FolderWatch): void {
    if (stopped) return;
    const now = Date.now();
    f.firstAt ??= now;
    if (f.timer) clearTimeout(f.timer);
    const wait = Math.max(0, Math.min(debounceMs, f.firstAt + maxWaitMs - now));
    f.timer = setTimeout(() => {
      f.running = f.running.then(() => flush(f));
    }, wait);
    f.timer.unref?.();
  }

  /** a markdown file that now holds exactly what the notes service wrote */
  function ownWrite(f: FolderWatch, rel: string): boolean {
    if (!opts.isOwnWrite) return false;
    try {
      const abs = path.join(f.path, ...rel.split('/'));
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return false;
      return opts.isOwnWrite(f.id, rel, hashOf(fs.readFileSync(abs, 'utf8')));
    } catch {
      return false; // deleted: not ours
    }
  }

  async function flush(f: FolderWatch): Promise<void> {
    f.timer = undefined;
    f.firstAt = undefined;
    const rescan = f.rescan;
    const paths = [...f.paths].filter((rel) => !ownWrite(f, rel)).sort();
    f.paths.clear();
    f.rescan = false;
    if (!rescan && !paths.length) return;
    try {
      if (rescan) await brain.reindex({ folderId: f.id });
      else brain.indexPaths(f.id, paths);
    } catch (e) {
      log.warn({ folder: f.id, err: (e as Error).message }, 'lập chỉ mục sau thay đổi file lỗi');
      return;
    }
    const payload: BrainChanged = { folderId: f.id, paths };
    bus.emit({ type: 'custom', name: 'brain:changed', payload });
  }

  async function watchFolder(id: string, dir: string): Promise<void> {
    const w = watch(dir, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: ignoredUnder(dir),
      ...(opts.usePolling ? { usePolling: true, interval: 50 } : {}),
    });
    const f: FolderWatch = { id, path: dir, watcher: w, paths: new Set(), rescan: false, running: Promise.resolve() };
    folders.set(id, f);
    const onFile = (abs: string) => {
      const rel = relOf(f, abs);
      if (!rel || !rel.toLowerCase().endsWith('.md')) return;
      f.paths.add(rel);
      schedule(f);
    };
    const onDir = (abs: string) => {
      if (!relOf(f, abs)) return;
      f.rescan = true;
      schedule(f);
    };
    w.on('add', onFile).on('change', onFile).on('unlink', onFile).on('addDir', onDir).on('unlinkDir', onDir);
    w.on('error', (err) => log.warn({ folder: id, err: (err as Error).message }, 'theo dõi thư mục brain lỗi'));
    await new Promise<void>((resolve) => w.once('ready', () => resolve()));
  }

  async function unwatch(f: FolderWatch): Promise<void> {
    if (f.timer) clearTimeout(f.timer);
    folders.delete(f.id);
    await f.watcher.close();
  }

  async function rebuild(): Promise<void> {
    const want = new Map(brain.folders().filter((x) => fs.existsSync(x.path)).map((x) => [x.id, x.path] as const));
    for (const f of [...folders.values()]) if (want.get(f.id) !== f.path) await unwatch(f);
    for (const [id, dir] of want) {
      if (folders.has(id) || stopped) continue;
      await watchFolder(id, dir);
    }
  }

  async function refresh(): Promise<void> {
    const before = new Set(brain.folders().map((f) => `${f.id}\0${f.path}`));
    brain.reloadConfig();
    await rebuild();
    // folders new to the config are indexed now, not at the next 15-minute pass
    for (const f of brain.folders()) {
      if (before.has(`${f.id}\0${f.path}`)) continue;
      brain.reindex({ folderId: f.id }).catch((e) => log.warn({ folder: f.id, err: (e as Error).message }, 'lập chỉ mục thư mục mới lỗi'));
    }
  }

  return {
    async start() {
      stopped = false;
      await rebuild();
      if (opts.configFile && !configWatcher) {
        // watch the directory, not the file: editors that save through a rename replace the file's inode
        const cfg = path.resolve(opts.configFile);
        const cw = watch(path.dirname(cfg), { ignoreInitial: true, depth: 0, ...(opts.usePolling ? { usePolling: true, interval: 50 } : {}) });
        configWatcher = cw;
        let t: NodeJS.Timeout | undefined;
        const onConfig = (p: string) => {
          if (path.resolve(p) !== cfg) return;
          if (t) clearTimeout(t);
          t = setTimeout(() => void refresh().catch((e) => log.warn({ err: (e as Error).message }, 'nạp lại brain.yaml lỗi')), debounceMs);
          t.unref?.();
        };
        cw.on('add', onConfig).on('change', onConfig).on('unlink', onConfig);
        await new Promise<void>((resolve) => cw.once('ready', () => resolve()));
      }
      log.info({ folders: [...folders.keys()] }, 'Đang theo dõi thay đổi trong Second Brain');
    },

    async stop() {
      stopped = true;
      await configWatcher?.close();
      configWatcher = undefined;
      for (const f of [...folders.values()]) await unwatch(f);
    },

    refresh,
    watching: () => [...folders.keys()],
  };
}
