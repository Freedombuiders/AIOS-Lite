/**
 * Worker handlers for the four Care job types. They only translate a claimed job into a call on an application
 * service (agent turn, outbox dispatcher, connector sync) and map the result onto a JobOutcome. Authority is
 * re-checked right before every step that can cause an effect (`ctx.assertAuthorised`) and the worker applies the
 * outcome through the fenced job CAS; nothing here talks to a provider SDK (connectors are reached through the
 * injected registry and the in-repo CareConnector contract).
 */
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareChannel } from '../../../_lib/care-kit/types.js';
import type { SyncResult } from '../../../_lib/care-kit/contract.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { CareIngestPipeline } from '../application/ingest.js';
import type { AgentTurnOutcome, CareAgentTurn } from '../application/agent-turn.js';
import { applyAgentTurnEffects } from '../application/agent-turn-effects.js';
import type { CareOutboxDispatcher } from '../application/dispatch.js';
import type { CareStores } from '../persistence/index.js';
import type { WorkerHandlers, JobContext, JobOutcome } from './worker.js';
import type Database from 'better-sqlite3';

export type { ConnectorRegistry };

const DEFAULT_BOX: Record<CareChannel, string> = {
  zalo: 'zalo_chat',
  email: 'gmail_mailbox',
  telegram: 'telegram_common_box',
};

export interface HandlerDeps {
  db: Database.Database;
  stores: CareStores;
  turn: CareAgentTurn;
  dispatcher: CareOutboxDispatcher;
  ingest: CareIngestPipeline;
  connectors: ConnectorRegistry;
  /** Called after every finished agent turn (the module raises owner attention from it). Must not throw. */
  onTurnOutcome?: (outcome: AgentTurnOutcome, conversationId: string) => void;
  /** Called with the id of every message a sync stored for the first time (the module copies its images). Must not throw. */
  onMessageStored?: (messageId: string) => void;
  /** Pages one sync job reads before yielding (the next poll continues from the stored checkpoint). */
  syncMaxPages?: number;
  syncPageLimit?: number;
  /** Max intents one dispatch job sends back to back (strictly one at a time per account). */
  dispatchPerJob?: number;
  /** Finished housekeeping jobs older than this are pruned by the cleanup job. */
  retainFinishedJobsMs?: number;
  now?: () => number;
}

const isTerminalError = (e: unknown) => e instanceof CareError && (e.code === 'NOT_FOUND' || e.code === 'INVALID_TARGET' || e.code === 'INVALID_COMMAND');

export function createCareHandlers(deps: HandlerDeps): WorkerHandlers {
  const { stores, turn, dispatcher, ingest, connectors } = deps;
  const now = deps.now ?? (() => Date.now());
  const messageStored = (messageId: string): void => {
    try {
      deps.onMessageStored?.(messageId);
    } catch {
      /* a side effect of ingest never fails the sync */
    }
  };

  const inbound_turn = async (ctx: JobContext): Promise<JobOutcome> => {
    const payload = ctx.job.payload as { conversationId?: unknown; messageId?: unknown };
    if (typeof payload.conversationId !== 'string' || typeof payload.messageId !== 'string') {
      return { kind: 'fail', error: 'BAD_PAYLOAD' };
    }
    ctx.assertAuthorised();
    try {
      const out = await turn.run({ conversationId: payload.conversationId, triggerMessageId: payload.messageId, trigger: 'inbound' });
      applyAgentTurnEffects(stores, payload.conversationId, out.effects);
      try {
        deps.onTurnOutcome?.(out, payload.conversationId);
      } catch {
        /* a notification failure never fails the job */
      }
      switch (out.status) {
        case 'in_progress':
          return { kind: 'retry', error: 'RUN_IN_PROGRESS', backoffMs: 5_000 };
        case 'failed':
          return { kind: 'fail', error: `agent_turn_failed:${out.reason}`.slice(0, 200) };
        default:
          return { kind: 'done' };
      }
    } catch (e) {
      if (isTerminalError(e)) return { kind: 'fail', error: (e as CareError).code };
      throw e;
    }
  };

  const outbox_dispatch = async (ctx: JobContext): Promise<JobOutcome> => {
    const max = deps.dispatchPerJob ?? 5;
    for (let i = 0; i < max; i++) {
      ctx.assertAuthorised();
      const reports = await dispatcher.dispatchDue({ accountIds: [ctx.accountId], limit: 1 });
      if (reports.length === 0) break;
      // a lost claim or an uncertain/failed result ends this burst; recovery and reconcile take it from there
      if (reports.some((r) => r.result === 'lost_claim' || r.result === 'uncertain' || r.result === 'parked_after_commit_failure')) break;
      if (reports.every((r) => r.result === 'deferred' || r.result === 'needs_review' || r.result === 'cancelled')) continue;
      if (!ctx.heartbeat()) throw new CareError('FENCING_REJECTED', 'Lost authority between dispatches', 409);
    }
    return { kind: 'done' };
  };

  /** RATE_LIMITED honours the provider's own horizon; ACCOUNT_FROZEN is terminal (never a retry loop). */
  const mapSyncError = (e: unknown, accountId: string): JobOutcome => {
    if (e instanceof CareError && e.code === 'RATE_LIMITED') {
      const until = (e.details as { nextAttemptAtMs?: unknown } | undefined)?.nextAttemptAtMs;
      const wait = typeof until === 'number' ? until - now() : 60_000;
      return { kind: 'retry', error: 'RATE_LIMITED', backoffMs: Math.min(Math.max(wait, 1_000), 3_600_000) };
    }
    if (e instanceof CareError && e.code === 'ACCOUNT_FROZEN') {
      stores.accounts.updateAccountFlags(accountId, { healthStatus: 'error', healthNote: 'ACCOUNT_FROZEN' });
      return { kind: 'fail', error: 'ACCOUNT_FROZEN' };
    }
    throw e;
  };

  /** Optional extras a connector may put on its sync result (typed loosely: the contract only fixes events/checkpoint). */
  type SyncExtras = {
    checkpoints?: Array<Parameters<CareStores['checkpoints']['advance']>[1]>;
    error?: { code: string; retryAtMs?: number };
    /** Extra boxes to re-read (e.g. a gap in a live feed): one follow-up job each. */
    recoveryNamespaces?: string[];
  };

  const sync_poll = async (ctx: JobContext): Promise<JobOutcome> => {
    const account = stores.accounts.getAccount(ctx.accountId);
    if (!account) return { kind: 'fail', error: 'ACCOUNT_NOT_FOUND' };
    const connector = connectors.forAccount(account);
    if (!connector) return { kind: 'retry', error: 'NO_CONNECTOR', backoffMs: 60_000 };
    const payload = ctx.job.payload as { namespace?: unknown };
    const namespace = typeof payload.namespace === 'string' ? payload.namespace : DEFAULT_BOX[account.channel];
    const maxPages = deps.syncMaxPages ?? 5;
    try {
      let more = false;
      for (let page = 0; page < maxPages; page++) {
        ctx.assertAuthorised();
        const stored = stores.checkpoints.get(account.id, namespace);
        const result: SyncResult = await connector.sync({
          accountId: account.id,
          checkpoint: stored
            ? { namespace: stored.namespace as never, cursor: stored.cursor }
            : namespace !== DEFAULT_BOX[account.channel]
              ? { namespace: namespace as never, cursor: '' }
              : undefined,
          limit: deps.syncPageLimit ?? 50,
        });
        const extras = result as SyncResult & SyncExtras;
        // Stop at the FIRST event that cannot be stored; the connector resumes its window at the page holding it.
        const failedEventIds: string[] = [];
        let ingestFailure: unknown = null;
        for (const event of result.events) {
          ctx.assertAuthorised();
          try {
            const res = ingest.ingestNormalizedEvent({ ...event, epoch: event.epoch ?? ctx.epoch });
            if (res.outcome === 'created' && res.messageId) messageStored(res.messageId);
          } catch (e) {
            // lost authority: nothing may be committed
            if (!connector.commitSync || (e instanceof CareError && e.code === 'FENCING_REJECTED')) throw e;
            failedEventIds.push(event.eventId);
            ingestFailure = e;
            break;
          }
        }
        // acknowledge the feed ONLY after the events of the slice were durably ingested
        await connector.commitSync?.(account.id, result, { failedEventIds });
        if (result.events.length === 0) for (const cp of extras.checkpoints ?? []) stores.checkpoints.advance(account.id, cp, now());
        if (ingestFailure) {
          return { kind: 'retry', error: `INGEST_FAILED:${ingestFailure instanceof CareError ? ingestFailure.code : 'ERROR'}`, backoffMs: 30_000 };
        }
        if (extras.error) {
          if (extras.error.code === 'CONNECTION_EXPIRED') return { kind: 'fail', error: 'CONNECTION_EXPIRED' };
          const wait = extras.error.retryAtMs !== undefined ? extras.error.retryAtMs - now() : 60_000;
          return { kind: 'retry', error: extras.error.code.slice(0, 100), backoffMs: Math.min(Math.max(wait, 1_000), 3_600_000) };
        }
        if (result.events.length === 0 && result.nextCheckpoint) stores.checkpoints.advance(account.id, result.nextCheckpoint, now());
        else if (result.nextCheckpoint && !connector.commitSync) stores.checkpoints.advance(account.id, result.nextCheckpoint, now());
        for (const ns of extras.recoveryNamespaces ?? []) {
          stores.jobs.enqueueJob({ accountId: account.id, jobType: 'sync_poll', dedupeKey: `sync-gap:${ctx.job.id}:${ns}`, payload: { namespace: ns }, ownerEpoch: ctx.epoch, dueAtMs: now() });
        }
        if (!ctx.heartbeat()) throw new CareError('FENCING_REJECTED', 'Lost authority during sync', 409);
        more = result.hasMore;
        if (!more) break;
      }
      if (more) {
        // yield the lane; the continuation is a new job so other work of the account is not starved
        stores.jobs.enqueueJob({
          accountId: account.id,
          jobType: 'sync_poll',
          dedupeKey: `sync-more:${ctx.job.id}`,
          payload: { namespace },
          ownerEpoch: ctx.epoch,
          dueAtMs: now(),
        });
      }
      return { kind: 'done' };
    } catch (e) {
      return mapSyncError(e, account.id);
    }
  };

  const cleanup = (ctx: JobContext): JobOutcome => {
    // epoch-superseded jobs can never be claimed again: close them so they stop showing as open work
    stores.jobs.supersedeStaleEpochJobs(ctx.accountId, now());
    const cutoff = now() - (deps.retainFinishedJobsMs ?? 24 * 3_600_000);
    deps.db
      .prepare(
        `DELETE FROM care_jobs
         WHERE account_id = ? AND status IN ('completed','failed') AND updated_at < ?
           AND job_type IN ('sync_poll','cleanup','outbox_dispatch')`,
      )
      .run(ctx.accountId, cutoff);
    return { kind: 'done' };
  };

  return { inbound_turn, outbox_dispatch, sync_poll, cleanup };
}
