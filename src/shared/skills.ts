import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { Logger } from '../core/log.js';
import type { Skill } from '../core/types.js';
import type { SkillLibrary } from './contracts.js';

interface Root {
  dir: string;
  source: string;
}

const MANIFEST = '.aios-managed.json';

function parseSkillFile(text: string, id: string): { name: string; description: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    try {
      const fm = parse(m[1]!) as Record<string, unknown> | null;
      if (fm && typeof fm === 'object') {
        return { name: String(fm.name ?? id), description: String(fm.description ?? '').trim() };
      }
    } catch {
      // fall through to the heuristic
    }
  }
  const first = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#') && l.trim() !== '---');
  return { name: id, description: first?.trim() ?? '' };
}

export function createSkillLibrary(deps: { dirs: string[]; log: Logger }): SkillLibrary {
  const { log } = deps;
  const roots: Root[] = deps.dirs.map((d) => ({ dir: path.resolve(d), source: 'library' }));
  let skills = new Map<string, Skill>();

  function reload(): void {
    skills = new Map();
    for (const root of roots) {
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(root.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
        const dir = path.join(root.dir, e.name);
        if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
        const file = path.join(dir, 'SKILL.md');
        let text: string;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (skills.has(e.name)) {
          log.debug({ id: e.name, source: root.source }, 'skill trùng id, giữ bản của thư mục đứng trước');
          continue;
        }
        const meta = parseSkillFile(text, e.name);
        skills.set(e.name, { id: e.name, name: meta.name, description: meta.description, path: file, dir, source: root.source });
      }
    }
  }

  function readManifest(file: string): string[] {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { links?: unknown };
      return Array.isArray(j.links) ? j.links.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  reload();

  return {
    reload,
    list: () => [...skills.values()],
    get: (id) => skills.get(id),
    read(id) {
      const s = skills.get(id);
      if (!s) throw new Error(`Không tìm thấy skill "${id}".`);
      return fs.readFileSync(s.path, 'utf8');
    },
    addRoot(dir, source) {
      const abs = path.resolve(dir);
      const ex = roots.find((r) => r.dir === abs);
      if (ex) ex.source = source;
      else roots.push({ dir: abs, source });
      reload();
    },
    removeRoot(dir) {
      const abs = path.resolve(dir);
      const i = roots.findIndex((r) => r.dir === abs);
      if (i >= 0) {
        roots.splice(i, 1);
        reload();
      }
    },
    resolve(allowed) {
      if (allowed === 'all') return [...skills.values()];
      return allowed.map((id) => skills.get(id)).filter((s): s is Skill => Boolean(s));
    },

    linkIntoWorkspace(workspace, list) {
      const base = path.join(workspace, '.claude', 'skills');
      fs.mkdirSync(base, { recursive: true });
      const manifestFile = path.join(base, MANIFEST);
      const managed = new Set(readManifest(manifestFile));
      const wanted = new Map(list.map((s) => [s.id, s]));

      // prune only symlinks AIOS created earlier
      for (const id of [...managed]) {
        if (wanted.has(id)) continue;
        const p = path.join(base, id);
        const st = fs.lstatSync(p, { throwIfNoEntry: false });
        if (st?.isSymbolicLink()) fs.unlinkSync(p);
        managed.delete(id);
      }
      for (const [id, s] of wanted) {
        const p = path.join(base, id);
        const st = fs.lstatSync(p, { throwIfNoEntry: false });
        if (st) {
          if (!st.isSymbolicLink() || !managed.has(id)) continue; // user's own file or link: leave it
          if (fs.readlinkSync(p) === s.dir) continue;
          fs.unlinkSync(p);
        }
        fs.symlinkSync(s.dir, p, 'dir');
        managed.add(id);
      }
      fs.writeFileSync(manifestFile, JSON.stringify({ links: [...managed].sort() }, null, 2));
    },
  };
}
