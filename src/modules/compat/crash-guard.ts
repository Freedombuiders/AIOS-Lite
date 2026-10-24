// Side-effect import: keep a failing background task in module code from killing the whole app.
import { logger } from './logger.js';

const FLAG = Symbol.for('aios.compat.crash-guard');
const g = globalThis as unknown as Record<symbol, boolean>;

if (!g[FLAG]) {
  g[FLAG] = true;
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => logger.error({ err }, 'uncaught exception'));
}
export {};
