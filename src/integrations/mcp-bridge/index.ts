import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

/** `node --import tsx <server.ts>` when running from source, `node <server.js>` once compiled. */
export function bridgeCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  // The CLI starts the bridge with the agent workspace as cwd, where a bare `tsx` cannot be resolved:
  // pass tsx's loader by absolute URL instead.
  if (here.endsWith('.ts')) return { command: process.execPath, args: ['--import', tsxLoader(), path.join(dir, 'server.ts')] };
  return { command: process.execPath, args: [path.join(dir, 'server.js')] };
}

/** Absolute file URL of tsx's ESM loader (falls back to the bare name). */
function tsxLoader(): string {
  try {
    const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
    return pathToFileURL(path.join(path.dirname(pkg), 'dist', 'loader.mjs')).href;
  } catch {
    return 'tsx';
  }
}
