// Brain folders CRUD on config/brain.yaml. Files on disk are never created, changed or deleted here.
import fs from 'node:fs';
import path from 'node:path';
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import type { AgentRegistry } from '../agents/contracts.js';
import { expandHome } from '../core/config.js';
import type { DB } from '../core/db.js';
import type { BrainService } from './contracts.js';
import { isInside } from './fs-browse.js';

export interface BrainFolderInput {
  id?: string;
  name: string;
  path: string;
  description?: string;
}

export interface BrainFolderDetail {
  id: string;
  name: string;
  path: string;
  description?: string;
  exists: boolean;
  isVault: boolean;
  mdCount: number;
  docs: number;
  /** agent ids with read / write globs on this folder */
  readers: string[];
  writers: string[];
}

export interface BrainAdminOptions {
  brain: BrainService;
  db: DB;
  agents: Pick<AgentRegistry, 'list' | 'update'>;
  configFile: string;
  rootDir: string;
  /** directories the owner may not register (the app's own data) */
  forbidden: string[];
}

export class BrainAdminError extends Error {
  constructor(
    public readonly code: 'bad_request' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

const SKIP = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

export function slugify(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'brain';
}

function countMarkdown(root: string, cap = 20000): number {
  let n = 0;
  const visit = (dir: string): void => {
    if (n >= cap) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) visit(path.join(dir, e.name));
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) n++;
    }
  };
  visit(root);
  return n;
}

export function createBrainAdmin(opts: BrainAdminOptions) {
  const { brain, db, agents } = opts;

  const resolveDir = (p: string): string => {
    const raw = p.trim();
    if (!raw) throw new BrainAdminError('bad_request', 'Cần nhập đường dẫn thư mục.');
    const abs = path.resolve(opts.rootDir, expandHome(raw));
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      throw new BrainAdminError('bad_request', 'Thư mục này không tồn tại trên máy.');
    }
    if (!fs.statSync(real).isDirectory()) throw new BrainAdminError('bad_request', 'Đường dẫn này không phải là thư mục.');
    if (real.split(path.sep).includes('node_modules')) throw new BrainAdminError('bad_request', 'Không dùng thư mục node_modules làm Second Brain.');
    for (const f of opts.forbidden) {
      let fr = f;
      try {
        fr = fs.realpathSync(f);
      } catch {
        /* not created yet */
      }
      if (isInside(fr, real)) throw new BrainAdminError('bad_request', 'Không dùng thư mục dữ liệu của chính AIOS làm Second Brain.');
    }
    return abs;
  };

  function readDoc() {
    let text = '';
    try {
      text = fs.readFileSync(opts.configFile, 'utf8');
    } catch {
      /* new file */
    }
    const doc = parseDocument(text || '# Các thư mục Second Brain (quản lý trong giao diện AIOS).\nfolders: []\n');
    let seq = doc.get('folders', true);
    if (!isSeq(seq)) {
      seq = new YAMLSeq();
      doc.set('folders', seq);
    }
    if ((seq as YAMLSeq).items.length === 0) (seq as YAMLSeq).flow = false;
    return { doc, seq: seq as YAMLSeq };
  }

  function save(doc: ReturnType<typeof readDoc>['doc']): void {
    fs.mkdirSync(path.dirname(opts.configFile), { recursive: true });
    fs.writeFileSync(opts.configFile, String(doc));
  }

  const findIndex = (seq: YAMLSeq, id: string) => seq.items.findIndex((it) => isMap(it) && it.get('id') === id);

  const count = () => db.prepare('SELECT COUNT(*) AS n FROM brain_docs WHERE folder_id = ?');

  function detail(id: string): BrainFolderDetail | undefined {
    const f = brain.folders().find((x) => x.id === id);
    if (!f) return undefined;
    const exists = fs.existsSync(f.path) && fs.statSync(f.path).isDirectory();
    const list = agents.list();
    return {
      ...f,
      exists,
      isVault: exists && fs.existsSync(path.join(f.path, '.obsidian')),
      mdCount: exists ? countMarkdown(f.path) : 0,
      docs: (count().get(id) as { n: number }).n,
      readers: list.filter((a) => (a.access.brain[id]?.read.length ?? 0) > 0).map((a) => a.id),
      writers: list.filter((a) => (a.access.brain[id]?.write.length ?? 0) > 0).map((a) => a.id),
    };
  }

  function sameFolder(abs: string, exceptId?: string): BrainFolderDetail | undefined {
    for (const f of brain.folders()) {
      if (f.id === exceptId) continue;
      if (path.resolve(f.path) === abs) return detail(f.id);
    }
    return undefined;
  }

  return {
    list: (): BrainFolderDetail[] => brain.folders().map((f) => detail(f.id)!),
    get: detail,

    async create(input: BrainFolderInput): Promise<BrainFolderDetail> {
      const name = input.name.trim();
      if (!name) throw new BrainAdminError('bad_request', 'Cần nhập tên Second Brain.');
      const abs = resolveDir(input.path);
      const dup = sameFolder(abs);
      if (dup) throw new BrainAdminError('conflict', `Thư mục này đã được thêm với tên "${dup.name}".`);
      const { doc, seq } = readDoc();
      const taken = new Set(seq.items.map((it) => (isMap(it) ? String(it.get('id')) : '')));
      let id = input.id?.trim() ?? '';
      if (id) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new BrainAdminError('bad_request', 'Mã chỉ gồm chữ thường không dấu, số và dấu gạch ngang.');
        if (taken.has(id)) throw new BrainAdminError('conflict', `Mã "${id}" đã tồn tại.`);
      } else {
        const base = slugify(name);
        id = base;
        for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
      }
      const node = new YAMLMap();
      node.set('id', id);
      node.set('name', name);
      node.set('path', input.path.trim());
      if (input.description?.trim()) node.set('description', input.description.trim());
      seq.add(node);
      save(doc);
      brain.reloadConfig();
      await brain.reindex({ folderId: id });
      return detail(id)!;
    },

    async update(id: string, patch: Partial<Omit<BrainFolderInput, 'id'>>): Promise<BrainFolderDetail> {
      const { doc, seq } = readDoc();
      const i = findIndex(seq, id);
      if (i < 0) throw new BrainAdminError('not_found', `Không tìm thấy Second Brain "${id}".`);
      const node = seq.items[i] as YAMLMap;
      let pathChanged = false;
      if (patch.name !== undefined) {
        if (!patch.name.trim()) throw new BrainAdminError('bad_request', 'Tên không được để trống.');
        node.set('name', patch.name.trim());
      }
      if (patch.description !== undefined) {
        if (patch.description.trim()) node.set('description', patch.description.trim());
        else node.delete('description');
      }
      if (patch.path !== undefined) {
        const abs = resolveDir(patch.path);
        const dup = sameFolder(abs, id);
        if (dup) throw new BrainAdminError('conflict', `Thư mục này đã được thêm với tên "${dup.name}".`);
        pathChanged = path.resolve(opts.rootDir, expandHome(String(node.get('path')))) !== abs;
        node.set('path', patch.path.trim());
      }
      save(doc);
      brain.reloadConfig();
      if (pathChanged) await brain.reindex({ folderId: id, full: true });
      return detail(id)!;
    },

    /** Removes the folder from config, its index rows and every agent grant. Files stay untouched. */
    remove(id: string): { agentsUpdated: string[] } {
      const { doc, seq } = readDoc();
      const i = findIndex(seq, id);
      if (i < 0) throw new BrainAdminError('not_found', `Không tìm thấy Second Brain "${id}".`);
      seq.items.splice(i, 1);
      save(doc);
      brain.reloadConfig();
      db.prepare('DELETE FROM brain_docs WHERE folder_id = ?').run(id);
      const agentsUpdated: string[] = [];
      for (const a of agents.list()) {
        if (!(id in a.access.brain)) continue;
        const { [id]: _gone, ...rest } = a.access.brain;
        agents.update(a.id, { access: { ...a.access, brain: rest } });
        agentsUpdated.push(a.id);
      }
      return { agentsUpdated };
    },
  };
}

export type BrainAdmin = ReturnType<typeof createBrainAdmin>;
