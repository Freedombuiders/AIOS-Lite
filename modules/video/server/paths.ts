import path from 'node:path';
import os from 'node:os';

// Live bindings: bindPaths() re-points them at the module's data dir when the module starts.
export let PROJECT_ROOT: string = process.cwd();
export let STORE_DIR: string = path.join(os.tmpdir(), 'aios-video');
export let DASHBOARD_PORT = 4300;
export let CLAUDECLAW_CONFIG: string = path.join(os.tmpdir(), 'aios-video-config');

export interface PathBinding { rootDir: string; dataDir: string; port?: number }

/** STORE_DIR is the module data dir: projects live in <dataDir>/video-edit, media in <dataDir>/... */
export function bindPaths(b: PathBinding): void {
  PROJECT_ROOT = b.rootDir;
  STORE_DIR = b.dataDir;
  CLAUDECLAW_CONFIG = path.join(b.dataDir, 'config');
  if (b.port) DASHBOARD_PORT = b.port;
}
