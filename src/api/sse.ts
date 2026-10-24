import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEvent } from '../core/events.js';
import type { AppDeps } from '../core/deps.js';

export const SSE_TYPES = ['task', 'run', 'run-event', 'message', 'board', 'memory', 'attention', 'audit', 'module', 'custom'];

export function sseHandler(deps: AppDeps, pingMs: number) {
  return (c: Context) => {
    const types = (c.req.query('types') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const filter = types.length ? new Set(types) : null;
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache');
    return streamSSE(c, async (stream) => {
      const queue: AppEvent[] = [];
      let wake: (() => void) | null = null;
      const off = deps.bus.on('*', (e) => {
        if (filter && !filter.has(e.type)) return;
        queue.push(e);
        wake?.();
      });
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      const ping = setInterval(() => {
        stream.write(': ping\n\n').catch(() => {});
      }, pingMs);
      try {
        await stream.write(': connected\n\n');
        while (!closed) {
          const e = queue.shift();
          if (!e) {
            await new Promise<void>((r) => (wake = r));
            wake = null;
            continue;
          }
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
        }
      } finally {
        clearInterval(ping);
        off();
      }
    });
  };
}
