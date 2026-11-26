// Architecture rule: the chat core of the Zalo module never reaches the marketing files (templates, broadcasts,
// birthday). Marketing may import the core; the core must not know marketing exists. The daemon (composition root)
// and the route/index wiring are the only places allowed to mention both.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER = path.dirname(fileURLToPath(import.meta.url));

/** Marketing feature files (modules/zalo/server). Add a new marketing file here. */
const MARKETING = [
  'template.ts', 'variants.ts', 'group-broadcast.ts', 'list-broadcast.ts', 'birthday.ts', 'birthday-schedule.ts',
  'broadcast-cost.ts', 'schedule.ts', 'send-window.ts', 'marketing-deps.ts',
  'routes-templates.ts', 'routes-group-broadcast.ts', 'routes-list-broadcast.ts', 'routes-birthday.ts',
].map((f) => path.join(SERVER, f));

/** Chat core: sessions, ingest, history, sending, limits, storage and the care connector. */
const CORE_FILES = [
  'session.ts', 'ingest.ts', 'history.ts', 'sender.ts', 'care-bridge.ts', 'limits.ts', 'store.ts',
  'content.ts', 'media.ts', 'media-cache.ts', 'profiles.ts', 'care-profiles.ts', 'stickers.ts', 'turn-images.ts',
  'control.ts', 'supervisor.ts', 'compat.ts', 'paths.ts', 'rich-text.ts', 'field-crypto.ts', 'daemon-bind.ts',
].map((f) => path.join(SERVER, f));

function connectorFiles(): string[] {
  const dir = path.join(SERVER, 'connectors', 'zalo');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => path.join(dir, f));
}

const SPEC = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g;

/** Resolve a relative specifier ('./x.js') to the .ts file it names, or null when it leaves modules/zalo/server's tree of ts files. */
function resolveImport(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(candidate)) return candidate;
  return null;
}

function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(SPEC)) {
    const target = resolveImport(file, m[1]!);
    if (target) out.push(target);
  }
  return out;
}

/** Every file reachable from `root` through imports, with the chain that reached it. */
function reach(root: string): Map<string, string[]> {
  const seen = new Map<string, string[]>([[root, [root]]]);
  const queue = [root];
  while (queue.length) {
    const f = queue.shift()!;
    for (const t of importsOf(f)) {
      if (seen.has(t)) continue;
      seen.set(t, [...seen.get(f)!, t]);
      queue.push(t);
    }
  }
  return seen;
}

const rel = (f: string) => path.relative(SERVER, f);

describe('zalo chat core does not depend on marketing', () => {
  it('the marketing list names files that exist (a rename must update this test)', () => {
    for (const f of MARKETING) expect(fs.existsSync(f), rel(f)).toBe(true);
    for (const f of [...CORE_FILES, ...connectorFiles()]) expect(fs.existsSync(f), rel(f)).toBe(true);
  });

  it('no core file reaches a marketing file, directly or through other imports', () => {
    const marketing = new Set(MARKETING);
    const violations: string[] = [];
    for (const root of [...CORE_FILES, ...connectorFiles()]) {
      for (const [file, chain] of reach(root)) {
        if (marketing.has(file)) violations.push(chain.map(rel).join(' -> '));
      }
    }
    expect(violations).toEqual([]);
  });

  it('the detector sees real imports (guards against a regex that matches nothing)', () => {
    expect(importsOf(path.join(SERVER, 'ingest.ts')).map(rel)).toContain('store.ts');
    expect(importsOf(path.join(SERVER, 'birthday.ts')).map(rel)).toContain('marketing-deps.ts');
    expect(importsOf(path.join(SERVER, 'daemon.ts')).map(rel)).toContain('birthday.ts');
  });
});
