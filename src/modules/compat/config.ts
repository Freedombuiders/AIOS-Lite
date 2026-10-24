import path from 'node:path';
import { defaultRootDir } from '../../core/config.js';
import { onBind } from './state.js';

// Live bindings: re-assigned by bindCompat, so importers always see current values.
export let PROJECT_ROOT: string = defaultRootDir();
export let STORE_DIR: string = path.join(PROJECT_ROOT, 'data', 'store');
export let ZALO_CONTROL_PORT = 4381;
export let AGENT_ID = 'main';
export let CLAUDECLAW_CONFIG: Record<string, unknown> = {};
export let DB_ENCRYPTION_KEY = '';

onBind((deps) => {
  PROJECT_ROOT = deps.config.rootDir;
  STORE_DIR = path.join(deps.config.dataDir, 'store');
  ZALO_CONTROL_PORT = Number(process.env.ZALO_CONTROL_PORT) || deps.config.port + 1;
  CLAUDECLAW_CONFIG = { timezone: deps.config.timezone, host: deps.config.host, port: deps.config.port };
  DB_ENCRYPTION_KEY = deps.config.encryptionKey ?? '';
});
