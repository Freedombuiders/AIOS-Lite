/** Shared by the vault index and browser: links only resolve to indexed notes. */
export function resolveBrainLink(target: string, source: string, ids: ReadonlySet<string>, wiki = false): string | undefined {
  try { target = decodeURIComponent(target.split('#')[0]); } catch { return undefined; }
  if (!target) return source;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target) || target.includes('\\')) return undefined;
  if (!/\.md$/i.test(target)) {
    if (!wiki) return undefined;
    target += '.md';
  }
  const normalize = (value: string) => {
    const parts: string[] = [];
    for (const part of value.split('/')) {
      if (part === '..') { if (!parts.length) return ''; parts.pop(); }
      else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
  };
  const local = normalize(`${source.split('/').slice(0, -1).join('/')}/${target}`);
  const rooted = normalize(target);
  const candidates = wiki ? [rooted, local] : [local, rooted];
  for (const candidate of candidates) if (ids.has(candidate)) return candidate;
  if (target.includes('/')) return undefined;
  const matches = [...ids].filter(id => id.split('/').pop() === target);
  return matches.length === 1 ? matches[0] : undefined;
}

export function brainNoteUrl(path: string, heading = ''): string {
  const query = new URLSearchParams({ note: path });
  if (heading) query.set('heading', heading);
  return `/brain?${query}`;
}
