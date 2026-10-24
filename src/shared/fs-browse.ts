// Safe directory browser for the folder pickers: directories only, never file names or contents.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from '../core/config.js';

export interface DirEntry {
  name: string;
  path: string;
  isVault: boolean;
  hasSkills: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

const MAX_DIRS = 500;

export function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** True when `dir` is a skills folder: it has at least one `<sub>/SKILL.md`. */
export function looksLikeSkillsDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => !e.name.startsWith('.') && e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')));
  } catch {
    return false;
  }
}

/** A directory "has skills" when a skills folder sits inside it (`.claude/skills`, `.agents/skills`, `skills`) or it is one. */
export function hasSkillsIn(dir: string): boolean {
  return ['.claude/skills', '.agents/skills', 'skills'].some((rel) => looksLikeSkillsDir(path.join(dir, rel))) || looksLikeSkillsDir(dir);
}

export function listDirs(requested: string | undefined, opts: { home?: string } = {}): DirListing {
  const home = fs.realpathSync(opts.home ?? os.homedir());
  const raw = requested?.trim() ? expandHome(requested.trim()) : home;
  if (!path.isAbsolute(raw)) throw new Error('Đường dẫn phải là đường dẫn tuyệt đối hoặc bắt đầu bằng ~.');
  let real: string;
  try {
    real = fs.realpathSync(raw);
  } catch {
    throw new Error('Thư mục không tồn tại.');
  }
  if (!isInside(home, real)) throw new Error('Chỉ được duyệt thư mục bên trong thư mục người dùng.');
  if (!fs.statSync(real).isDirectory()) throw new Error('Đây không phải là thư mục.');

  const dirs: DirEntry[] = [];
  for (const e of fs.readdirSync(real, { withFileTypes: true })) {
    if (dirs.length >= MAX_DIRS) break;
    if (e.name.startsWith('.') && e.name !== '.claude') continue;
    const abs = path.join(real, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        const target = fs.realpathSync(abs);
        isDir = isInside(home, target) && fs.statSync(target).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    dirs.push({ name: e.name, path: abs, isVault: fs.existsSync(path.join(abs, '.obsidian')), hasSkills: hasSkillsIn(abs) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  return { path: real, parent: real === home ? null : path.dirname(real), dirs };
}
