/**
 * Injected time for the Care runtime. Nothing in runtime/ reads Date.now() or setTimeout directly,
 * so worker/supervisor/cutover behaviour is deterministic under test.
 */

export interface RuntimeClock {
  now(): number;
  /** Resolves after `ms`, or early (resolved, not rejected) when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: RuntimeClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(done, Math.max(0, ms));
      const onAbort = () => {
        clearTimeout(t);
        done();
      };
      function done() {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

export interface ManualClock extends RuntimeClock {
  /** Moves time forward and wakes every sleeper whose deadline has passed (in deadline order). */
  advance(ms: number): Promise<void>;
  set(ms: number): void;
  pendingSleepers(): number;
}

/** Deterministic clock: sleepers only wake through `advance` (or an abort signal). */
export function createManualClock(startMs = 1_000_000): ManualClock {
  let current = startMs;
  const sleepers: Array<{ at: number; wake: () => void }> = [];
  const flush = async () => {
    // let awakened continuations run before the next deadline is considered
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    now: () => current,
    set(ms) {
      current = ms;
    },
    pendingSleepers: () => sleepers.length,
    sleep(ms, signal) {
      return new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const entry = {
          at: current + Math.max(0, ms),
          wake: () => {
            signal?.removeEventListener('abort', entry.wake);
            const i = sleepers.indexOf(entry);
            if (i >= 0) sleepers.splice(i, 1);
            resolve();
          },
        };
        sleepers.push(entry);
        signal?.addEventListener('abort', entry.wake, { once: true });
      });
    },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = sleepers.filter((s) => s.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        current = Math.max(current, due.at);
        due.wake();
        await flush();
      }
      current = target;
      await flush();
    },
  };
}
