// Daemon-process entry: the daemon is its own OS process, so it opens the shared SQLite file and binds compat itself.
import { bindDaemonCompat as bind } from '../../../src/modules/compat/index.js';

export function bindDaemonCompat(dbPath: string): void {
  bind(dbPath, { name: 'zalo-daemon', ...(process.env.ZALO_DATA_DIR ? { dataDir: process.env.ZALO_DATA_DIR } : {}) });
}
