// Second Brain: folders from config/brain.yaml, FTS5 index in brain_docs, guarded read/write.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { EffectiveAccess } from '../access/contracts.js';
import { expandHome } from '../core/config.js';
import { nowIso, type DB } from '../core/db.js';
import type { Logger } from '../core/log.js';
import type { BrainFolder, BrainHit } from '../core/types.js';
import type { BrainService, BrainTreeNode } from './contracts.js';
import { matchAnyGlob, normalizeRel } from './glob.js';
import { ftsQuery } from './text.js';

export type BrainFolderInfo = BrainFolder & { exists: boolean };

const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);
const MAX_FILE_BYTES = 1024 * 1024;

const configSchema = z.object({
  folders: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        name: z.string().default(''),
        path: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .default([]),
});

export interface BrainOptions {
  db: DB;
  configFile: string;
  rootDir: string;
  log: Logger;
}

function titleOf(content: string, relPath: string): string {
  const m = content.match(/^#\s+(.+?)\s*$/m);
  if (m?.[1]) return m[1].replace(/\s+#+\s*$/, '').trim();
  return path.basename(relPath, path.extname(relPath));
}

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

export function createBrainService(opts: BrainOptions): BrainService & { folderInfos(): BrainFolderInfo[] } {
  const { db, log } = opts;
  let folders: BrainFolderInfo[] = [];

  function loadConfig(): void {
    folders = [];
    let text: string;
    try {
      text = fs.readFileSync(opts.configFile, 'utf8');
    } catch {
      return;
    }
    let raw: unknown;
    try {
      raw = parse(text);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'brain.yaml không phải YAML hợp lệ');
      return;
    }
    const parsed = configSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      log.warn('brain.yaml sai định dạng: cần `folders: [{id, name, path}]`');
      return;
    }
    const seen = new Set<string>();
    for (const f of parsed.data.folders) {
      if (seen.has(f.id)) {
        log.warn({ id: f.id }, 'brain.yaml: id thư mục bị trùng, bỏ qua');
        continue;
      }
      seen.add(f.id);
      const abs = path.resolve(opts.rootDir, expandHome(f.path));
      folders.push({
        id: f.id,
        name: f.name || f.id,
        path: abs,
        ...(f.description ? { description: f.description } : {}),
        exists: fs.existsSync(abs) && fs.statSync(abs).isDirectory(),
      });
    }
  }

  function folderOf(id: string): BrainFolderInfo {
    const f = folders.find((x) => x.id === id);
    if (!f) throw new Error(`Không có thư mục Second Brain "${id}".`);
    return f;
  }

  /** Resolve a safe absolute path inside the folder; rejects traversal and escaping symlinks. */
  function safePath(folder: BrainFolderInfo, relPath: string): { abs: string; rel: string } {
    const rel = normalizeRel(relPath);
    if (rel === null || rel === '') throw new Error('Đường dẫn không hợp lệ: không được dùng "..", đường dẫn tuyệt đối hoặc để trống.');
    if (!fs.existsSync(folder.path)) throw new Error(`Thư mục "${folder.id}" chưa tồn tại trên máy.`);
    const realRoot = fs.realpathSync(folder.path);
    const abs = path.join(realRoot, ...rel.split('/'));
    if (!within(realRoot, realAncestor(abs))) throw new Error('Đường dẫn trỏ ra ngoài thư mục Second Brain, đã chặn.');
    return { abs, rel };
  }

  const upsert = db.prepare(`INSERT INTO brain_docs (folder_id, path, title, content, mtime_ms, size, indexed_at)
    VALUES (@folder_id, @path, @title, @content, @mtime_ms, @size, @indexed_at)
    ON CONFLICT(folder_id, path) DO UPDATE SET title=excluded.title, content=excluded.content,
      mtime_ms=excluded.mtime_ms, size=excluded.size, indexed_at=excluded.indexed_at`);

  function indexFile(folderId: string, rel: string, abs: string, st: fs.Stats, content?: string): void {
    const text = content ?? fs.readFileSync(abs, 'utf8');
    upsert.run({
      folder_id: folderId,
      path: rel,
      title: titleOf(text, rel),
      content: text,
      mtime_ms: Math.floor(st.mtimeMs),
      size: st.size,
      indexed_at: nowIso(),
    });
  }

  /** Markdown files under root (posix relative paths). Symlinks are skipped on purpose. */
  function walk(root: string): { rel: string; abs: string; st: fs.Stats }[] {
    const out: { rel: string; abs: string; st: fs.Stats }[] = [];
    const visit = (dir: string, prefix: string): void => {
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.isSymbolicLink()) continue;
        const abs = path.join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) visit(abs, rel);
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
          const st = fs.statSync(abs);
          if (st.size <= MAX_FILE_BYTES) out.push({ rel, abs, st });
        }
      }
    };
    visit(root, '');
    return out;
  }

  function search(query: string, o: { folders?: string[]; limit?: number } = {}): BrainHit[] {
    const limit = o.limit ?? 10;
    if (o.folders && o.folders.length === 0) return [];
    const run = (mode: 'and' | 'or'): BrainHit[] => {
      const q = ftsQuery(query, mode, 24);
      if (!q) return [];
      const params: unknown[] = [q];
      let where = 'brain_fts MATCH ?';
      if (o.folders) {
        where += ` AND d.folder_id IN (${o.folders.map(() => '?').join(',')})`;
        params.push(...o.folders);
      }
      params.push(limit);
      const rows = db
        .prepare(
          `SELECT d.folder_id, d.path, d.title,
                  snippet(brain_fts, 1, '', '', '…', 24) AS snippet,
                  bm25(brain_fts, 5.0, 1.0) AS rank
             FROM brain_fts JOIN brain_docs d ON d.id = brain_fts.rowid
            WHERE ${where} ORDER BY rank LIMIT ?`,
        )
        .all(...params) as { folder_id: string; path: string; title: string; snippet: string; rank: number }[];
      return rows.map((r) => ({
        folderId: r.folder_id,
        path: r.path,
        title: r.title,
        snippet: r.snippet.replace(/\s+/g, ' ').trim(),
        score: -r.rank,
      }));
    };
    try {
      const and = run('and');
      return and.length ? and : run('or');
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'brain.search lỗi');
      return [];
    }
  }

  loadConfig();

  return {
    folders: () => folders.map(({ exists: _e, ...f }) => f),
    folderInfos: () => folders.slice(),
    reloadConfig: loadConfig,

    async reindex(o = {}) {
      const t0 = Date.now();
      let indexed = 0;
      let removed = 0;
      const targets = o.folderId ? [folderOf(o.folderId)] : folders;
      for (const f of targets) {
        const have = new Map(
          (db.prepare('SELECT path, mtime_ms FROM brain_docs WHERE folder_id = ?').all(f.id) as { path: string; mtime_ms: number }[]).map((r) => [r.path, r.mtime_ms]),
        );
        const files = f.exists ? walk(f.path) : [];
        const seen = new Set<string>();
        db.transaction(() => {
          for (const file of files) {
            seen.add(file.rel);
            if (!o.full && have.get(file.rel) === Math.floor(file.st.mtimeMs)) continue;
            try {
              indexFile(f.id, file.rel, file.abs, file.st);
              indexed++;
            } catch (e) {
              log.warn({ file: file.rel, err: (e as Error).message }, 'không đọc được ghi chú');
            }
          }
          for (const p of have.keys()) {
            if (seen.has(p)) continue;
            db.prepare('DELETE FROM brain_docs WHERE folder_id = ? AND path = ?').run(f.id, p);
            removed++;
          }
        })();
      }
      if (!o.folderId) {
        // folders removed from config
        const ids = folders.map((f) => f.id);
        const stale = (db.prepare('SELECT DISTINCT folder_id FROM brain_docs').all() as { folder_id: string }[]).map((r) => r.folder_id).filter((id) => !ids.includes(id));
        for (const id of stale) removed += db.prepare('DELETE FROM brain_docs WHERE folder_id = ?').run(id).changes;
      }
      return { indexed, removed, durationMs: Date.now() - t0 };
    },

    search,

    searchForAccess(query, access: EffectiveAccess, limit = 5) {
      if (!access.readDirs.length) return [];
      const byFolder = new Map<string, string[][]>();
      for (const g of access.readDirs) byFolder.set(g.folderId, [...(byFolder.get(g.folderId) ?? []), g.globs]);
      const hits = search(query, { folders: [...byFolder.keys()], limit: limit * 8 + 20 });
      const out: BrainHit[] = [];
      for (const h of hits) {
        const grants = byFolder.get(h.folderId) ?? [];
        if (grants.some((globs) => matchAnyGlob(globs, h.path))) out.push(h);
        if (out.length >= limit) break;
      }
      return out;
    },

    read(folderId, relPath) {
      const f = folderOf(folderId);
      const { abs } = safePath(f, relPath);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        throw new Error(`Không tìm thấy ghi chú ${folderId}/${relPath}.`);
      }
      if (!st.isFile()) throw new Error(`${relPath} không phải là file.`);
      if (st.size > MAX_FILE_BYTES) throw new Error('Ghi chú quá lớn (trên 1 MB).');
      const content = fs.readFileSync(abs, 'utf8');
      return { title: titleOf(content, relPath), content, mtimeMs: st.mtimeMs };
    },

    tree(folderId, o = {}) {
      const f = folderOf(folderId);
      const maxDepth = o.depth ?? 4;
      if (!f.exists) return [];
      const realRoot = fs.realpathSync(f.path);
      const visit = (dir: string, prefix: string, depth: number): BrainTreeNode[] => {
        let ents: fs.Dirent[];
        try {
          ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return [];
        }
        const nodes: BrainTreeNode[] = [];
        for (const e of ents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
          if (e.isSymbolicLink()) continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            const node: BrainTreeNode = { name: e.name, path: rel, type: 'dir' };
            if (depth < maxDepth) node.children = visit(path.join(dir, e.name), rel, depth + 1);
            nodes.push(node);
          } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) nodes.push({ name: e.name, path: rel, type: 'file' });
        }
        return nodes;
      };
      return visit(realRoot, '', 1);
    },

    write(folderId, relPath, content) {
      const f = folderOf(folderId);
      const { abs, rel } = safePath(f, relPath);
      if (!rel.toLowerCase().endsWith('.md')) throw new Error('Chỉ được ghi file Markdown (.md).');
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Nội dung quá lớn (trên 1 MB).');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // recheck after mkdir: a symlinked parent could only appear now
      if (!within(fs.realpathSync(f.path), realAncestor(path.dirname(abs)))) throw new Error('Đường dẫn trỏ ra ngoài thư mục Second Brain, đã chặn.');
      fs.writeFileSync(abs, content);
      indexFile(f.id, rel, abs, fs.statSync(abs), content);
    },
  };
}
