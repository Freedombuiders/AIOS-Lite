import type { Logger } from '../../../src/core/log.js';
import { currentContext } from './context.js';

const noop = () => undefined;

/** pino-compatible logger that forwards to the bound module context (silent when none). */
export const logger: Logger = new Proxy({} as Logger, {
  get(_t, prop) {
    const real = currentContext()?.log as unknown as Record<string | symbol, unknown> | undefined;
    const v = real?.[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : noop;
  },
});
