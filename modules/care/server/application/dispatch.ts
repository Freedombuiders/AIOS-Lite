/**
 * CC-11 outbox dispatcher: claim -> guard -> persist attempt -> RPC -> commit outcome.
 *
 * Invariants (guide section 5, AC-018/019/021/024):
 *  - the intent is claimed under a lease together with the account's CURRENT owner epoch; there is one
 *    delivery lane per account (database-enforced) and accounts are served fairly;
 *  - the injected `DispatchGuard` (plus the built-in target/capability checks) runs BEFORE the connector
 *    and cannot be bypassed by a manual or approved actor; a denial leaves the intent unsent, with a
 *    reason, and never creates an attempt;
 *  - the attempt row (with the persisted native retry token) is written before the RPC; the connector
 *    is called with that token and the attempt's epoch;
 *  - the attempt outcome, the intent state, the canonical message and the event commit in ONE
 *    transaction. If the provider accepted and that transaction fails, the intent is parked as
 *    `uncertain` with the evidence, and recovery reconciles it; it never becomes a new send;
 *  - an expired lease is never proof the RPC did not happen: with an open attempt it means
 *    `uncertain`, only a missing attempt row (written before the RPC) lets the intent return to pending;
 *  - `uncertain` is resolved only by evidence (late receipt) or an explicit reconcile, which may end in
 *    sent, retry_wait (same token, only when the connector dedupes) or needs_review.
 *  No model or network call ever runs inside a database transaction.
 */

import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareConnector, ConnectorCapabilities, DeliveryCommand, DeliveryResult } from '../../../_lib/care-kit/contract.js';
import type { CareAccountRecord, CareConversationRecord, CareReceiptLevel } from '../../../_lib/care-kit/types.js';
import type { CareStores } from '../persistence/index.js';
import {
  receiptRank,
  toReasonCode,
  type AttemptOutcomeInput,
  type OutboxAttemptRecord,
  type OutboxClaim,
  type OutboxIntentRecord,
  type OutboxMaterializer,
  type OutboxStatus,
} from '../persistence/outbox-store.js';
import { createOutboundMaterializer } from './outbox-service.js';

// ── Guard contract (implemented by policy/ and wired by the runtime) ─────────────────────────

export interface DispatchGuardContext {
  intent: OutboxIntentRecord;
  account: CareAccountRecord;
  conversation: CareConversationRecord | null;
  capabilities: ConnectorCapabilities;
  /** The exact command that would be sent (target, text, recipients, token, epoch). */
  command: DeliveryCommand;
  nowMs: number;
}

export type DispatchGuardDecision =
  | { allow: true }
  | {
      allow: false;
      /**
       * defer: stay pending, retry at `retryAtMs` (cooldown, quota, scheduled window; persisted).
       * review: park as needs_review (stale reviewed draft, eligibility revoked: a human must re-review).
       * cancel: terminal, never send (auto intent made stale by a human reply / new inbound / opt-out).
       */
      action: 'defer' | 'review' | 'cancel';
      reason: string;
      retryAtMs?: number;
    };

/**
 * Checked immediately before the RPC for EVERY actor: owner/generation, source/account enabled, send
 * flag, capability, fixed target, opt-out/purpose, quota/cooldown, mandatory data eligibility. Auto
 * intents additionally: human pause, context freshness, scheduled window. A manual or approved intent
 * never skips the mandatory part; a guard that throws is treated as a deferral (fail closed).
 */
export interface DispatchGuard {
  evaluate(ctx: DispatchGuardContext): DispatchGuardDecision | Promise<DispatchGuardDecision>;
}

// ── Failure classification ───────────────────────────────────────────────────────────────────

export interface FailureClass {
  outcome: 'retryable' | 'terminal' | 'uncertain' | 'review';
  code: string;
  retryAtMs?: number;
}

/**
 * Only an error the provider (or the connector's pre-send validation) raised BEFORE anything left is
 * definite. Everything else (timeouts, unknown errors, a lost connection) may have reached the
 * provider and is uncertain. Rate limits may carry `details.retryAtMs` / `details.retryAfterMs`.
 */
export function classifyDeliveryFailure(error: unknown, nowMs: number): FailureClass {
  if (error instanceof CareError) {
    switch (error.code) {
      case 'RATE_LIMITED':
      case 'SEND_DISABLED':
      case 'ACCOUNT_FROZEN': {
        const d = (error.details ?? {}) as { retryAtMs?: unknown; retryAfterMs?: unknown };
        const retryAtMs =
          typeof d.retryAtMs === 'number'
            ? d.retryAtMs
            : typeof d.retryAfterMs === 'number'
              ? nowMs + d.retryAfterMs
              : undefined;
        return { outcome: 'retryable', code: error.code, retryAtMs };
      }
      case 'TERMINAL_REJECTION':
      case 'INVALID_COMMAND':
      case 'INVALID_TARGET':
      case 'UNSUPPORTED_CAPABILITY':
      case 'DUPLICATE_REQUEST_PAYLOAD_MISMATCH':
      case 'CONFIGURATION_CONFLICT':
        return { outcome: 'terminal', code: error.code };
      case 'FENCING_REJECTED':
        return { outcome: 'review', code: error.code };
      default:
        return { outcome: 'uncertain', code: error.code };
    }
  }
  return { outcome: 'uncertain', code: 'UNKNOWN_DELIVERY_ERROR' };
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

// ── Dispatcher ───────────────────────────────────────────────────────────────────────────────

export type DispatchResult =
  | 'sent'
  | 'retry_wait'
  | 'uncertain'
  | 'failed'
  | 'needs_review'
  | 'deferred'
  | 'cancelled'
  | 'lost_claim'
  | 'parked_after_commit_failure';

export interface DispatchReport {
  intentId: string;
  accountId: string;
  result: DispatchResult;
  /** True when the connector's dispatch() was called for this claim. */
  rpc: boolean;
  reason?: string;
}

export interface ReconcileReport {
  intent: OutboxIntentRecord;
  evidence: 'accepted' | 'none' | 'failed' | 'unavailable' | 'not_applicable';
}

export interface DispatcherOptions {
  stores: CareStores;
  guard: DispatchGuard;
  /** The connector that serves an account (null/undefined => the claim is deferred, nothing is sent). */
  resolveConnector: (account: CareAccountRecord) => CareConnector | null | undefined;
  workerId: string;
  leaseMs?: number;
  /** Max wait for the provider answer before parking the attempt as uncertain (late answers still apply). */
  rpcTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Delay for a deferred claim whose guard gave no explicit retry time. */
  defaultDeferMs?: number;
  now?: () => number;
  materialize?: OutboxMaterializer;
}

type RpcSettled =
  | { kind: 'result'; result: DeliveryResult }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

export class CareOutboxDispatcher {
  private readonly stores: CareStores;
  private readonly leaseMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly defaultDeferMs: number;
  private readonly materialize: OutboxMaterializer;
  /** Hook for tests/observability; never receives message text. */
  public onLateOutcomeError?: (error: unknown) => void;

  constructor(private readonly opts: DispatcherOptions) {
    this.stores = opts.stores;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 60_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 5_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 15 * 60_000;
    this.defaultDeferMs = opts.defaultDeferMs ?? 30_000;
    this.materialize = opts.materialize ?? createOutboundMaterializer(opts.stores, () => this.now());
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private backoff(attemptNo: number): number {
    return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.max(0, attemptNo - 1));
  }

  /** Housekeeping + claim + dispatch of whatever is due. Distinct accounts run concurrently. */
  async dispatchDue(opts: { limit?: number; accountIds?: string[] } = {}): Promise<DispatchReport[]> {
    const claims = this.stores.outbox.claimDue({
      workerId: this.opts.workerId,
      leaseDurationMs: this.leaseMs,
      limit: opts.limit,
      accountIds: opts.accountIds,
      nowMs: this.now(),
    });
    return Promise.all(claims.map((claim) => this.processClaim(claim)));
  }

  /**
   * Startup recovery: this worker's own previous leases (it holds nothing after a restart) and any
   * expired lease are resolved. In-flight attempts become uncertain, never pending.
   */
  recover(): { uncertain: number; released: number } {
    return this.stores.outbox.recoverInFlight({ nowMs: this.now(), ownWorkerId: this.opts.workerId });
  }

  // ── one claim ──────────────────────────────────────────────────────────────────────────────

  async processClaim(claim: OutboxClaim): Promise<DispatchReport> {
    const store = this.stores.outbox;
    const report = (result: DispatchResult, rpc: boolean, reason?: string): DispatchReport => ({
      intentId: claim.intentId,
      accountId: claim.accountId,
      result,
      rpc,
      reason,
    });

    const intent = store.getIntent(claim.intentId);
    const account = this.stores.accounts.getAccount(claim.accountId);
    if (!intent || !account) return report('lost_claim', false, 'MISSING_INTENT_OR_ACCOUNT');
    const conversation = intent.conversationId ? this.stores.conversations.getConversation(intent.conversationId) : null;

    const release = (
      status: 'pending' | 'needs_review' | 'cancelled',
      reason: string,
      retryAtMs?: number,
    ): DispatchReport => {
      const nextAttemptAtMs = status === 'pending' ? retryAtMs ?? this.now() + this.defaultDeferMs : undefined;
      const ok = store.releaseWithoutAttempt(claim, { status, reason, nextAttemptAtMs }, this.now());
      if (!ok) return report('lost_claim', false, reason);
      return report(status === 'pending' ? 'deferred' : status === 'cancelled' ? 'cancelled' : 'needs_review', false, reason);
    };

    const connector = this.opts.resolveConnector(account);
    if (!connector) return release('pending', 'NO_CONNECTOR');

    // 1. capabilities, then the command exactly as it would be sent.
    let capabilities: ConnectorCapabilities;
    try {
      capabilities = await connector.capabilities(account.id, conversation?.externalKey);
    } catch {
      return release('pending', 'CAPABILITIES_UNAVAILABLE');
    }
    const command = buildCommand(intent, claim.ownerEpoch);

    // 2. built-in fixed-target / capability checks, then the injected guard (mandatory for every actor).
    const builtin = checkTargetAndCapabilities(intent, account, conversation, capabilities);
    let decision: DispatchGuardDecision = builtin ?? { allow: true };
    if (decision.allow) {
      try {
        decision = await this.opts.guard.evaluate({ intent, account, conversation, capabilities, command, nowMs: this.now() });
      } catch {
        decision = { allow: false, action: 'defer', reason: 'GUARD_ERROR' };
      }
    }
    if (!decision.allow) {
      const target = decision.action === 'review' ? 'needs_review' : decision.action === 'cancel' ? 'cancelled' : 'pending';
      return release(target, decision.reason, decision.retryAtMs);
    }

    // 3. persist the attempt (fenced by lease, epoch and account gates) BEFORE the RPC.
    const attempt = store.beginAttempt(claim, this.now());
    if (!attempt) {
      // Lease lost, epoch moved, or a gate closed between claim and now. No attempt exists, so no RPC.
      const released = store.releaseWithoutAttempt(claim, { status: 'pending', reason: 'ATTEMPT_FENCED', nextAttemptAtMs: this.now() + this.defaultDeferMs }, this.now());
      return report(released ? 'deferred' : 'lost_claim', false, 'ATTEMPT_FENCED');
    }

    // 4. the RPC, with the persisted token and the attempt's epoch; the lease is renewed meanwhile.
    const rpcCommand: DeliveryCommand = { ...command, ownerEpoch: attempt.ownerEpoch, adapterRetryToken: attempt.requestToken };
    const heartbeat = setInterval(
      () => {
        try {
          store.renewLease(claim, this.leaseMs, this.now());
        } catch {
          /* best effort: a lost lease is handled by recovery, never by a second send */
        }
      },
      Math.max(10, Math.floor(this.leaseMs / 3)),
    );
    heartbeat.unref?.();

    let pending: Promise<DeliveryResult>;
    try {
      pending = Promise.resolve(connector.dispatch(rpcCommand));
    } catch (error) {
      pending = Promise.reject(error);
    }
    const answer = pending.then(
      (result): RpcSettled => ({ kind: 'result', result }),
      (error): RpcSettled => ({ kind: 'error', error }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RpcSettled>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), this.rpcTimeoutMs);
      timer.unref?.();
    });
    const settled = await Promise.race([answer, timeout]);
    clearTimeout(timer);
    clearInterval(heartbeat);

    if (settled.kind === 'timeout') {
      // The answer may still come; when it does it is applied to THIS attempt (evidence, not a new send).
      void answer.then((late) => {
        if (late.kind === 'timeout') return;
        try {
          this.commit(attempt, late, 'LATE_ANSWER');
        } catch (error) {
          this.onLateOutcomeError?.(error);
        }
      });
    }

    // 5. one transaction: attempt outcome + intent state + canonical message + event.
    return this.commit(attempt, settled);
  }

  private commit(attempt: OutboxAttemptRecord, settled: RpcSettled, tag?: string): DispatchReport {
    const store = this.stores.outbox;
    const nowMs = this.now();
    const input = this.toOutcome(attempt, settled, nowMs);
    const report = (result: DispatchResult, reason?: string): DispatchReport => ({
      intentId: attempt.intentId,
      accountId: attempt.accountId,
      result,
      rpc: true,
      reason: reason ?? tag,
    });
    try {
      const res = store.commitAttempt({ ...input, materialize: this.materialize });
      const status = res.intent.status;
      const mapped: DispatchResult =
        status === 'sent'
          ? 'sent'
          : status === 'retry_wait' || status === 'uncertain' || status === 'failed' || status === 'needs_review'
            ? status
            : 'lost_claim';
      return report(mapped, res.note ?? undefined);
    } catch {
      // The provider may have accepted. Keep the evidence and park the intent as uncertain: recovery
      // reconciles it. This must never turn into another send.
      try {
        store.parkUncertain(
          attempt.id,
          { nativeMessageId: input.nativeMessageId, remoteTimestampMs: input.remoteTimestampMs, reason: 'COMMIT_FAILED' },
          this.now(),
        );
      } catch {
        /* the open attempt + lease expiry still lead to uncertain via recovery */
      }
      return report('parked_after_commit_failure', 'COMMIT_FAILED');
    }
  }

  private toOutcome(attempt: OutboxAttemptRecord, settled: RpcSettled, nowMs: number): AttemptOutcomeInput {
    const base = { attemptId: attempt.id, nowMs };
    if (settled.kind === 'timeout') {
      return { ...base, outcome: 'uncertain', errorCode: 'RPC_TIMEOUT', error: 'Provider did not answer in time' };
    }
    if (settled.kind === 'error') {
      const cls = classifyDeliveryFailure(settled.error, nowMs);
      return {
        ...base,
        outcome: cls.outcome,
        errorCode: cls.code,
        error: describeError(settled.error),
        retryAtMs: cls.outcome === 'retryable' ? cls.retryAtMs ?? nowMs + this.backoff(attempt.attemptNo) : undefined,
      };
    }
    const r = settled.result;
    switch (r.outcome) {
      case 'accepted':
      case 'delivered':
      case 'read': {
        const named: CareReceiptLevel = r.outcome;
        const level = receiptRank(r.receiptLevel) > receiptRank(named) ? r.receiptLevel! : named;
        return {
          ...base,
          outcome: 'accepted',
          receiptLevel: level,
          nativeMessageId: r.nativeMessageId ?? null,
          remoteTimestampMs: r.remoteTimestampMs ?? null,
        };
      }
      case 'uncertain':
        return { ...base, outcome: 'uncertain', errorCode: 'UNCERTAIN_RESULT', error: r.error, nativeMessageId: r.nativeMessageId ?? null };
      default:
        return { ...base, outcome: 'terminal', errorCode: 'PROVIDER_FAILED', error: r.error };
    }
  }

  // ── reconcile (explicit, never a blind resend) ─────────────────────────────────────────────

  /**
   * Resolves an `uncertain` intent from provider evidence. Evidence of acceptance -> sent (attached to
   * the ORIGINAL attempt). No evidence: a connector that dedupes by token (`sendDedupe`) lets the same
   * token be tried again (retry_wait); any other connector cannot prove the message was not delivered,
   * so it goes to manual review. Never creates a new token, never re-sends by itself.
   */
  async reconcile(intentId: string): Promise<ReconcileReport> {
    const store = this.stores.outbox;
    const intent = store.getIntent(intentId);
    if (!intent) throw new CareError('NOT_FOUND', `Outbox intent not found: ${intentId}`, 404);
    if (intent.status !== 'uncertain') {
      return { intent, evidence: 'not_applicable' };
    }
    const account = this.stores.accounts.getAccount(intent.accountId);
    const connector = account ? this.opts.resolveConnector(account) : null;
    if (!account || !connector) return { intent, evidence: 'unavailable' };

    const original = store.findAttemptForReceipt({ accountId: intent.accountId, clientRequestId: intent.clientRequestId });
    if (!original) return { intent, evidence: 'unavailable' };
    const p = intent.payload;
    const conversationKey = p.target.externalConversationKey;

    let result: DeliveryResult;
    try {
      result = await connector.reconcile({
        clientRequestId: intent.clientRequestId,
        adapterRetryToken: intent.adapterRetryToken,
        accountId: account.id,
        ...(original.nativeMessageId ? { nativeMessageId: original.nativeMessageId } : {}),
        ...(conversationKey ? { externalConversationKey: conversationKey } : {}),
        ownerEpoch: account.ownerEpoch,
      });
    } catch {
      return { intent: store.getIntent(intentId)!, evidence: 'unavailable' };
    }

    if (result.outcome === 'accepted' || result.outcome === 'delivered' || result.outcome === 'read') {
      const level = receiptRank(result.receiptLevel) > receiptRank(result.outcome) ? result.receiptLevel! : result.outcome;
      const res = store.commitAttempt({
        attemptId: original.id,
        outcome: 'accepted',
        receiptLevel: level,
        nativeMessageId: result.nativeMessageId ?? original.nativeMessageId,
        remoteTimestampMs: result.remoteTimestampMs ?? null,
        nowMs: this.now(),
        materialize: this.materialize,
      });
      return { intent: res.intent, evidence: 'accepted' };
    }

    if (result.outcome === 'failed') {
      const res = store.commitAttempt({
        attemptId: original.id,
        outcome: 'terminal',
        errorCode: 'RECONCILE_PROVIDER_FAILED',
        error: result.error,
        nowMs: this.now(),
      });
      return { intent: res.intent, evidence: 'failed' };
    }

    // No evidence either way.
    const caps = await safeCapabilities(connector, account.id, conversationKey);
    const canRetrySameToken = caps?.sendDedupe === true && intent.attemptCount < intent.maxAttempts;
    store.resolveUncertain(
      intent.id,
      canRetrySameToken
        ? { status: 'retry_wait', reason: 'RECONCILE_NO_EVIDENCE_SAME_TOKEN', nextAttemptAtMs: this.now() }
        : { status: 'needs_review', reason: 'RECONCILE_NO_EVIDENCE' },
      this.now(),
    );
    return { intent: store.getIntent(intent.id)!, evidence: 'none' };
  }

  /** Reconciles every uncertain intent (restart sweep). Sequential: reconcile calls are cheap reads. */
  async reconcileAllUncertain(accountId?: string): Promise<ReconcileReport[]> {
    const uncertain = this.stores.outbox.listIntents({ accountId, statuses: ['uncertain'], limit: 200 });
    const reports: ReconcileReport[] = [];
    for (const intent of uncertain) reports.push(await this.reconcile(intent.id));
    return reports;
  }
}

async function safeCapabilities(connector: CareConnector, accountId: string, key: string | undefined): Promise<ConnectorCapabilities | null> {
  try {
    return await connector.capabilities(accountId, key);
  } catch {
    return null;
  }
}

// ── Command building / built-in checks ───────────────────────────────────────────────────────

export function buildCommand(intent: OutboxIntentRecord, ownerEpoch: number): DeliveryCommand {
  const p = intent.payload;
  const base = {
    clientRequestId: intent.clientRequestId,
    accountId: intent.accountId,
    purpose: intent.purpose,
    actor: intent.actor,
    ownerEpoch,
    adapterRetryToken: intent.adapterRetryToken,
    text: p.text,
  };
  if (p.kind === 'chat') {
    return { ...base, kind: 'chat', channel: p.channel, target: { ...p.target } };
  }
  return {
    ...base,
    kind: 'email',
    channel: 'email',
    target: { ...p.target, to: [...p.target.to], ...(p.target.cc ? { cc: [...p.target.cc] } : {}) },
    ...(p.bcc ? { bcc: [...p.bcc] } : {}),
  };
}

/** Fixed-target and capability checks that hold for every actor, independent of the injected policy. */
function checkTargetAndCapabilities(
  intent: OutboxIntentRecord,
  account: CareAccountRecord,
  conversation: CareConversationRecord | null,
  caps: ConnectorCapabilities,
): DispatchGuardDecision | null {
  const deny = (reason: string): DispatchGuardDecision => ({ allow: false, action: 'review', reason: toReasonCode(reason) });
  const p = intent.payload;
  if (p.channel !== account.channel) return deny('CHANNEL_MISMATCH');
  if (intent.conversationId) {
    if (!conversation || conversation.accountId !== account.id) return deny('CONVERSATION_MISSING');
    if (p.target.externalConversationKey !== conversation.externalKey) return deny('TARGET_MISMATCH');
  }
  if (!caps.text) return deny('UNSUPPORTED_CAPABILITY');
  if (p.target.replyToMessageId && !caps.reply) return deny('UNSUPPORTED_CAPABILITY');
  if (p.kind === 'email') {
    if (p.bcc && p.bcc.length > 0 && !caps.bcc) return deny('UNSUPPORTED_CAPABILITY');
    if (p.target.to.length + (p.target.cc?.length ?? 0) > 1 && !caps.replyAll) return deny('UNSUPPORTED_CAPABILITY');
    if (!p.target.externalConversationKey && !caps.newMail) return deny('UNSUPPORTED_CAPABILITY');
  }
  return null;
}

export type { OutboxStatus };
