import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { ModuleDefinition, ModuleManifest } from './sdk.js';

const ID = /^_?[a-z][a-z0-9-]*$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const settingSpec = z.object({
  label: z.string(),
  type: z.enum(['boolean', 'number', 'string', 'select', 'secret']),
  default: z.unknown().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  help: z.string().optional(),
});

export const ModuleManifestSchema = z.object({
  id: z.string().regex(ID),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  icon: z.string().optional(),
  category: z.enum(['sales', 'marketing', 'ops', 'other']),
  requires: z
    .object({ modules: z.array(z.string()).optional(), connections: z.array(z.string()).optional() })
    .optional(),
  enhances: z.array(z.string()).optional(),
  scopes: z.record(z.string(), z.string()).optional(),
  tables: z.array(z.string().regex(TABLE)),
  agentTemplates: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  settings: z.record(z.string(), settingSpec).optional(),
  license: z.string().optional(),
}) satisfies z.ZodType<ModuleManifest>;

export interface DiscoveredModule {
  manifest: ModuleManifest;
  dir: string;
  serverEntry: string | null;
  webEntry: string | null;
}

export interface DiscoverResult {
  modules: DiscoveredModule[];
  errors: { id: string; message: string }[];
}

/** True when this file runs from compiled output (dist/src/modules/...). */
export function runningFromDist(metaUrl: string = import.meta.url): boolean {
  const parts = path.dirname(fileURLToPath(metaUrl)).split(path.sep);
  return parts.includes('dist');
}

function firstExisting(...files: string[]): string | null {
  return files.find((f) => fs.existsSync(f)) ?? null;
}

export interface LoaderOptions {
  rootDir: string;
  modulesDir: string;
  /** override dist detection (tests) */
  fromDist?: boolean;
}

export function serverEntryFor(opts: LoaderOptions, id: string): string | null {
  const fromDist = opts.fromDist ?? runningFromDist();
  if (fromDist) {
    const rel = path.relative(opts.rootDir, opts.modulesDir);
    return firstExisting(path.join(opts.rootDir, 'dist', rel, id, 'server', 'index.js'));
  }
  return firstExisting(
    path.join(opts.modulesDir, id, 'server', 'index.ts'),
    path.join(opts.modulesDir, id, 'server', 'index.js'),
  );
}

export function readManifest(dir: string): ModuleManifest {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8')) as unknown;
  const parsed = ModuleManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'module.json'}: ${i.message}`).join('; '));
  }
  if (path.basename(dir) !== parsed.data.id) throw new Error(`id "${parsed.data.id}" không khớp tên thư mục "${path.basename(dir)}"`);
  return parsed.data;
}

/** Scan modules/*; folders starting with '_' are templates and skipped. */
export function discoverModules(opts: LoaderOptions): DiscoverResult {
  const out: DiscoverResult = { modules: [], errors: [] };
  let names: string[] = [];
  try {
    names = fs.readdirSync(opts.modulesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const dir = path.join(opts.modulesDir, name);
    if (!fs.existsSync(path.join(dir, 'module.json'))) continue;
    try {
      out.modules.push({
        manifest: readManifest(dir),
        dir,
        serverEntry: serverEntryFor(opts, name),
        webEntry: firstExisting(path.join(dir, 'web', 'index.tsx')),
      });
    } catch (err) {
      out.errors.push({ id: name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export type ModuleImporter = (file: string) => Promise<unknown>;

export const defaultImporter: ModuleImporter = (file) => import(pathToFileURL(file).href);

export async function loadDefinition(entry: string | null, importer: ModuleImporter = defaultImporter): Promise<ModuleDefinition> {
  if (!entry) return {};
  const mod = (await importer(entry)) as { default?: ModuleDefinition };
  return mod.default ?? (mod as ModuleDefinition);
}
