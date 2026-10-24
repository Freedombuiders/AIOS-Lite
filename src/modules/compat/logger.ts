import { createLogger, type Logger } from '../../core/log.js';
import { tryDeps } from './state.js';

const fallback = createLogger({ name: 'aios-compat' });
const compatLog = (): Logger => tryDeps()?.log ?? fallback;

/** pino-compatible logger forwarding to the app logger once bound. */
export const logger: Logger = new Proxy({} as Logger, {
  get(_t, prop) {
    const real = compatLog() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});
