// Extra skill roots persisted in config/skills.yaml, on top of AIOS_SKILLS_DIRS and module roots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMap, isSeq, parse, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { expandHome } from '../core/config.js';
import type { BrainFolder } from '../core/types.js';
import type { SkillLibrary } from './contracts.js';

export type SkillRootKind = 'env' | 'user' | 'module';

export interface SkillRootInfo {
  path: string;
  label: string;
  kind: SkillRootKind;
  readOnly: boolean;
  exists: boolean;
  skills: number;
  /** skill ids in this root that an earlier root already provides (first root wins) */
  clashes: string[];
}

export interface SkillRootSuggestion {
  path: string;
  label: string;
  skills: number;
}

export interface SkillRootsOptions {
  library: SkillLibrary;
  configFile: string;
  rootDir: string;
  /** AIOS_SKILLS_DIRS, absolute */
  envDirs: string[];
  brainFolders: () => Pick<BrainFolder, 'id' | 'name' | 'path'>[];
  home?: string;
}

export class SkillRootsError extends Error {
  constructor(
    public readonly code: 'bad_request' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

interface UserRoot {
  path: string;
  label: string;
}

/** Ids of the skills a directory provides: sub-folders holding a SKILL.md (hidden and `_` folders skipped). */
export function skillIdsIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && !e.name.startsWith('_'))
      .filter((e) => fs.statSync(path.join(dir, e.name), { throwIfNoEntry: false })?.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function createSkillRoots(opts: SkillRootsOptions) {
  const home = opts.home ?? os.homedir();
  const userSource = (r: UserRoot) => (r.label ? `nguồn: ${r.label}` : `nguồn: ${path.basename(r.path)}`);

  function loadUser(): UserRoot[] {
    let raw: unknown;
    try {
      raw = parse(fs.readFileSync(opts.configFile, 'utf8'));
    } catch {
      return [];
    }
    const list = (raw as { roots?: unknown } | null)?.roots;
    if (!Array.isArray(list)) return [];
    const out: UserRoot[] = [];
    for (const r of list as { path?: unknown; label?: unknown }[]) {
      if (typeof r?.path !== 'string' || !r.path.trim()) continue;
      out.push({ path: path.resolve(opts.rootDir, expandHome(r.path)), label: typeof r.label === 'string' ? r.label : '' });
    }
    return out;
  }

  function readDoc() {
    let text = '';
    try {
      text = fs.readFileSync(opts.configFile, 'utf8');
    } catch {
      /* new file */
    }
    const doc = parseDocument(text || '# Nguồn skill thêm từ giao diện AIOS (ngoài AIOS_SKILLS_DIRS).\nroots: []\n');
    let seq = doc.get('roots', true);
    if (!isSeq(seq)) {
      seq = new YAMLSeq();
      doc.set('roots', seq);
    }
    if ((seq as YAMLSeq).items.length === 0) (seq as YAMLSeq).flow = false;
    return { doc, seq: seq as YAMLSeq };
  }

  const save = (doc: ReturnType<typeof readDoc>['doc']) => {
    fs.mkdirSync(path.dirname(opts.configFile), { recursive: true });
    fs.writeFileSync(opts.configFile, String(doc));
  };

  /** Called at boot, after the library is built from AIOS_SKILLS_DIRS. */
  function apply(): void {
    for (const r of loadUser()) {
      if (opts.envDirs.includes(r.path)) continue;
      opts.library.addRoot(r.path, userSource(r));
    }
  }

  function moduleRoots(known: Set<string>): { dir: string; source: string }[] {
    const out = new Map<string, string>();
    for (const s of opts.library.list()) {
      if (s.source === 'library' || s.source.startsWith('nguồn: ')) continue;
      const dir = path.dirname(s.dir);
      if (!known.has(dir)) out.set(dir, s.source);
    }
    return [...out].map(([dir, source]) => ({ dir, source }));
  }

  function list(): SkillRootInfo[] {
    const user = loadUser().filter((r) => !opts.envDirs.includes(r.path));
    const known = new Set([...opts.envDirs, ...user.map((r) => r.path)]);
    const entries: { path: string; label: string; kind: SkillRootKind }[] = [
      ...opts.envDirs.map((p) => ({ path: p, label: path.basename(p) === 'skills' ? 'Thư viện của AIOS' : path.basename(p), kind: 'env' as const })),
      ...user.map((r) => ({ path: r.path, label: r.label || path.basename(r.path), kind: 'user' as const })),
      ...moduleRoots(known).map((m) => ({ path: m.dir, label: m.source, kind: 'module' as const })),
    ];
    const seen = new Map<string, string>();
    return entries.map((e) => {
      const ids = skillIdsIn(e.path);
      const clashes = ids.filter((id) => seen.has(id));
      for (const id of ids) if (!seen.has(id)) seen.set(id, e.path);
      return { ...e, readOnly: e.kind !== 'user', exists: fs.existsSync(e.path), skills: ids.length, clashes };
    });
  }

  function suggestions(): SkillRootSuggestion[] {
    const used = new Set(list().map((r) => r.path));
    const cands: { path: string; label: string }[] = [
      { path: path.join(home, '.claude', 'skills'), label: 'Claude Code (~/.claude/skills)' },
      { path: path.join(home, '.agents', 'skills'), label: 'Agents (~/.agents/skills)' },
      { path: path.join(home, '.codex', 'skills'), label: 'Codex (~/.codex/skills)' },
    ];
    for (const f of opts.brainFolders()) {
      for (const rel of ['.claude/skills', '.agents/skills']) cands.push({ path: path.join(f.path, rel), label: `${f.name} (${rel})` });
    }
    const out: SkillRootSuggestion[] = [];
    for (const c of cands) {
      if (used.has(c.path)) continue;
      const n = skillIdsIn(c.path).length;
      if (n > 0) out.push({ ...c, skills: n });
    }
    return out;
  }

  function add(input: { path: string; label?: string }): SkillRootInfo {
    const raw = input.path.trim();
    if (!raw) throw new SkillRootsError('bad_request', 'Cần nhập đường dẫn thư mục skill.');
    const abs = path.resolve(opts.rootDir, expandHome(raw));
    if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new SkillRootsError('bad_request', 'Thư mục này không tồn tại trên máy.');
    if (list().some((r) => r.path === abs)) throw new SkillRootsError('conflict', 'Nguồn skill này đã có trong danh sách.');
    const { doc, seq } = readDoc();
    const node = new YAMLMap();
    node.set('path', raw);
    if (input.label?.trim()) node.set('label', input.label.trim());
    seq.add(node);
    save(doc);
    opts.library.addRoot(abs, userSource({ path: abs, label: input.label?.trim() ?? '' }));
    return list().find((r) => r.path === abs)!;
  }

  function remove(rawPath: string): void {
    const abs = path.resolve(opts.rootDir, expandHome(rawPath.trim()));
    if (opts.envDirs.includes(abs)) throw new SkillRootsError('bad_request', 'Nguồn này đặt qua AIOS_SKILLS_DIRS, chỉ gỡ được bằng cách sửa biến môi trường.');
    const { doc, seq } = readDoc();
    const i = seq.items.findIndex((it) => isMap(it) && path.resolve(opts.rootDir, expandHome(String(it.get('path')))) === abs);
    if (i < 0) throw new SkillRootsError('not_found', 'Không có nguồn skill này trong cấu hình (nguồn của module không gỡ được ở đây).');
    seq.items.splice(i, 1);
    save(doc);
    opts.library.removeRoot(abs);
  }

  return { apply, list, suggestions, add, remove };
}

export type SkillRoots = ReturnType<typeof createSkillRoots>;
