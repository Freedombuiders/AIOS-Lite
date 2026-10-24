// For module code that runs in its OWN process (e.g. the Zalo daemon): open the shared SQLite file and bind compat,
// so the copied stores (getDb()/db) work there too. The AIOS process never calls this.
import { loadConfig } from '../../core/config.js';
import { createCipher } from '../../core/crypto.js';
import { migrateCore, openDb } from '../../core/db.js';
import type { AppDeps } from '../../core/deps.js';
import { createEventBus } from '../../core/events.js';
import { createLogger } from '../../core/log.js';
import { bindCompat } from './state.js';

export function bindDaemonCompat(dbPath: string, opts: { name?: string; dataDir?: string } = {}): AppDeps {
  const db = openDb(dbPath);
  migrateCore(db);
  const env = { ...process.env, ...(opts.dataDir ? { AIOS_DATA_DIR: opts.dataDir } : {}) };
  const config = loadConfig({ loadDotEnv: false, env });
  const log = createLogger({ name: opts.name ?? 'module-daemon' });
  // A daemon has no engine/dispatcher: only the pieces compat helpers read are provided.
  const deps = { config, db, bus: createEventBus(), log, cipher: createCipher(config.encryptionKey) } as unknown as AppDeps;
  bindCompat(deps);
  return deps;
}
