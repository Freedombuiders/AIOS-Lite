// Tiny glob matcher for brain grants: `**` (any depth), `*` (within a segment), `?` (one char).

const cache = new Map<string, RegExp>();

function toRegex(glob: string): RegExp {
  let re = cache.get(glob);
  if (re) return re;
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${out}$`);
  cache.set(glob, re);
  return re;
}

/** Normalise a relative posix path; returns null for absolute paths or `..` escapes. */
export function normalizeRel(p: string): string | null {
  const s = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.includes('\0')) return null;
  const parts = s.split('/').filter((x) => x !== '' && x !== '.');
  if (parts.includes('..')) return null;
  return parts.join('/');
}

export function matchGlob(glob: string, relPath: string): boolean {
  const rel = normalizeRel(relPath);
  if (rel === null) return false;
  return toRegex(normalizeRel(glob) ?? glob).test(rel);
}

export function matchAnyGlob(globs: readonly string[], relPath: string): boolean {
  return globs.some((g) => matchGlob(g, relPath));
}

/** Narrowest directory (relative, '' = root) that covers every file the glob can match. */
export function globBaseDir(glob: string): string {
  const parts = (normalizeRel(glob) ?? '').split('/').filter(Boolean);
  const base: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    if (/[*?]/.test(seg)) break;
    // a final literal segment is a file name, not a directory
    if (i === parts.length - 1) break;
    base.push(seg);
  }
  return base.join('/');
}
