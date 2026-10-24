import pino from 'pino';
import { redactString } from './redact.js';

export type Logger = pino.Logger;

/** Root logger. Messages pass through the secret redactor. */
export function createLogger(opts: { level?: string; name?: string } = {}): Logger {
  return pino({
    name: opts.name ?? 'aios',
    level: opts.level ?? process.env.AIOS_LOG_LEVEL ?? (process.env.NODE_ENV === 'test' || process.env.VITEST ? 'silent' : 'info'),
    hooks: {
      logMethod(args, method) {
        const clean = args.map((a) => (typeof a === 'string' ? redactString(a) : a)) as Parameters<typeof method>;
        method.apply(this, clean);
      },
    },
  });
}

export const log: Logger = createLogger();
