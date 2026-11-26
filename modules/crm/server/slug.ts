// File names of customer notes: no diacritics, lower case, hyphens. "Chị Lan" -> "chi-lan".
// A collision gets -2, -3… (the caller decides what is taken). Renaming a customer never renames the file.

const MAX = 80;

export function slugify(text: string): string {
  const s = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX)
    .replace(/-+$/, '');
  return s || 'khach';
}

/** First free `<dir>/<slug>.md`, `<dir>/<slug>-2.md`, … */
export function freeNotePath(dir: string, name: string, taken: (relPath: string) => boolean): string {
  const base = slugify(name);
  for (let i = 1; ; i++) {
    const rel = `${dir}/${i === 1 ? base : `${base}-${i}`}.md`;
    if (!taken(rel)) return rel;
  }
}
