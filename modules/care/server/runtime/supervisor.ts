/**
 * Generic restart-with-backoff supervision. It never retries forever on a fatal error (auth failure,
 * handshake mismatch, revoked session): `isFatal` stops the loop in state `failed`, and `maxConsecutiveFailures`
 * bounds a crash loop. A run that stayed up for `resetAfterMs` resets the backoff.
 */
import { systemClock, type RuntimeClock } from './clock.js';

export interface BackoffPolicy {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** A run that lasted at least this long counts as healthy: the failure streak resets. */
  resetAfterMs: number;
  /** Failure streak after which supervision gives up (state `failed`). Omit for unbounded (still backed off). */
  maxConsecutiveFailures?: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { initialMs: 1_000, maxMs: 60_000, factor: 2, resetAfterMs: 120_000, maxConsecutiveFailures: 20 };

export type SupervisorState = 'idle' | 'running' | 'backoff' | 'stopped' | 'failed';

export interface SupervisorEvent {
  type: 'started' | 'crashed' | 'restarting' | 'gave_up' | 'fatal' | 'stopped';
  name: string;
  restarts: number;
  delayMs?: number;
  error?: string;
}

export interface SupervisorDeps {
  name: string;
  /** Runs until `signal` aborts (normal return = clean end, no restart). A throw = crash. */
  run: (signal: AbortSignal) => Promise<void>;
  clock?: RuntimeClock;
  backoff?: Partial<BackoffPolicy>;
  isFatal?: (error: unknown) => boolean;
  onEvent?: (event: SupervisorEvent) => void;
}

export function backoffDelay(policy: BackoffPolicy, consecutiveFailures: number): number {
  const raw = policy.initialMs * Math.pow(policy.factor, Math.max(0, consecutiveFailures - 1));
  return Math.min(policy.maxMs, Math.max(0, Math.round(raw)));
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export class Supervisor {
  private readonly clock: RuntimeClock;
  private readonly policy: BackoffPolicy;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;
  private _state: SupervisorState = 'idle';
  private _restarts = 0;
  private _lastError: string | null = null;

  constructor(private readonly deps: SupervisorDeps) {
    this.clock = deps.clock ?? systemClock;
    this.policy = { ...DEFAULT_BACKOFF, ...deps.backoff };
  }

  get state(): SupervisorState {
    return this._state;
  }
  get restarts(): number {
    return this._restarts;
  }
  get lastError(): string | null {
    return this._lastError;
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.supervise();
  }

  /** Aborts the current run and any backoff sleep, then waits for the loop to end. */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
    if (this._state !== 'failed') this._state = 'stopped';
  }

  /** Resolves when the loop has ended on its own (clean return, fatal, or gave up). */
  async done(): Promise<void> {
    await this.loop;
  }

  private emit(e: Omit<SupervisorEvent, 'name' | 'restarts'>): void {
    this.deps.onEvent?.({ name: this.deps.name, restarts: this._restarts, ...e });
  }

  private async supervise(): Promise<void> {
    let streak = 0;
    this.emit({ type: 'started' });
    while (!this.abort.signal.aborted) {
      const startedAt = this.clock.now();
      this._state = 'running';
      try {
        await this.deps.run(this.abort.signal);
        this._state = 'stopped';
        this.emit({ type: 'stopped' });
        return;
      } catch (e) {
        if (this.abort.signal.aborted) {
          this._state = 'stopped';
          return;
        }
        this._lastError = msg(e);
        if (this.deps.isFatal?.(e)) {
          this._state = 'failed';
          this.emit({ type: 'fatal', error: this._lastError });
          return;
        }
        streak = this.clock.now() - startedAt >= this.policy.resetAfterMs ? 1 : streak + 1;
        this.emit({ type: 'crashed', error: this._lastError });
        if (this.policy.maxConsecutiveFailures !== undefined && streak > this.policy.maxConsecutiveFailures) {
          this._state = 'failed';
          this.emit({ type: 'gave_up', error: this._lastError });
          return;
        }
        const delayMs = backoffDelay(this.policy, streak);
        this._state = 'backoff';
        this._restarts += 1;
        this.emit({ type: 'restarting', delayMs });
        await this.clock.sleep(delayMs, this.abort.signal);
      }
    }
    this._state = 'stopped';
  }
}
