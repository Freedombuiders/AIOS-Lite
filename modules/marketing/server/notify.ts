/**
 * Owner notifications for the studio (publish failures, comments that need a human, expired
 * connections) become attention items. Without a bound context they are only logged.
 */
import { logger } from './compat.js';
import { getRuntime } from './runtime.js';

export interface NotifyOptions {
  key?: string;
  severity?: 'info' | 'warn' | 'error';
  link?: string;
}

/** Best-effort: never throws. */
export async function notifyOwner(text: string, opts: NotifyOptions = {}): Promise<void> {
  const ctx = getRuntime();
  if (!ctx) {
    logger.info({ text: text.slice(0, 200) }, 'marketing notification (no context bound)');
    return;
  }
  try {
    const [title, ...rest] = text.split('\n');
    ctx.attention.raise({
      key: opts.key ?? `notify:${text.slice(0, 80)}`,
      title: title.slice(0, 160),
      detail: rest.join('\n').trim() || undefined,
      link: opts.link ?? '/m/marketing',
      severity: opts.severity ?? 'warn',
    });
  } catch (err) {
    logger.warn({ err }, 'marketing notification failed');
  }
}
