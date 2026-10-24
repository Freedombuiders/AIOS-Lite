// Where the zalo module keeps files. The AIOS process sets it from ctx.dataDir (setZaloDataDir) and the daemon child from
// ZALO_DATA_DIR; importers always read the live bindings.
import path from 'node:path';
import { STORE_DIR } from './compat.js';

export let ZALO_DATA_DIR = path.join(STORE_DIR, 'zalo');
export let ZALO_MEDIA_DIR = path.join(ZALO_DATA_DIR, 'media');
export let ZALO_MEDIA_CACHE_DIR = path.join(ZALO_DATA_DIR, 'media-cache');
export let ZALO_PID_FILE = path.join(ZALO_DATA_DIR, 'zalo-daemon.pid');
/** Daemon log; the supervisor appends the child's stdout/stderr here. */
export let ZALO_LOG_FILE = path.join(ZALO_DATA_DIR, 'zalo.log');

export function setZaloDataDir(dir: string): void {
  ZALO_DATA_DIR = dir;
  ZALO_MEDIA_DIR = path.join(dir, 'media');
  ZALO_MEDIA_CACHE_DIR = path.join(dir, 'media-cache');
  ZALO_PID_FILE = path.join(dir, 'zalo-daemon.pid');
  ZALO_LOG_FILE = path.join(dir, 'zalo.log');
}
