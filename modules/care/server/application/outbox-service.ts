/**
 * CC-11 outbox service: draft -> approve -> enqueue -> cancel, idempotent receipts, reply port and
 * draft sink.
 *
 * The service owns the *intent* side of the outbox (what may be sent, to whom, in which revision).
 * The dispatcher (dispatch.ts) owns the *delivery* side (claim, guard, RPC, outcome). Both share
 * `CareOutboxStore`, which holds every state transition.
 *
 * The target of a delivery is derived here, never taken from the caller: the conversation fixes
 * account, channel and native conversation key. A caller (UI, agent) supplies content and, for
 * email, explicit recipients; it cannot point a reply at another account or conversation.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CareDeliveryStatusDto, CareOutboxIntentDto } from '../api/dto.js';
import type { CareReplyAcceptance, CareReplyPort, CareReplyRequest } from '../api/ports.js';
import { validateDeliveryCommand, type DeliveryCommand } from '../../../_lib/care-kit/contract.js';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type {
  CareAccountRecord,
  CareActorType,
  CareChannel,
  CareConversationRecord,
  CareIntentPurpose,
  CareReceiptLevel,
  NormalizedMessage,
} from '../../../_lib/care-kit/types.js';
import { CARE_CHANNELS, oneOf, requireNonEmptyString } from '../../../_lib/care-kit/validation.js';
import type { CareStores } from '../persistence/index.js';
import type { DraftProposal } from './agent-ports.js';
import { withSignatureOnce } from './agent-output.js';
import {
  type AttemptOutcomeResult,
  type CancelResult,
  type OutboxIntentRecord,
  type OutboxMaterializer,
  type OutboxPayload,
  type OutboxStatus,
} from '../persistence/outbox-store.js';

const ACTORS: readonly CareActorType[] = ['manual', 'approved', 'auto'];
const PURPOSES: readonly CareIntentPurpose[] = ['care', 'campaign'];

/** What a caller supplies. Everything else about the target is derived from the conversation. */
export type OutboxContent =
  | {
      kind: 'chat';
      text: string;
      /** LOCAL canonical message ID this reply answers (must belong to the same conversation). */
      replyToMessageId?: string;
      /** Alternative to `replyToMessageId`: the provider's native ID of the answered message. */
      replyToNativeMessageId?: string;
      topicId?: string;
    }
  | {
      kind: 'email';
      text: string;
      /** Explicit recipient preview: Reply All is the caller's visible choice, never a model's. */
      to: readonly string[];
      cc?: readonly string[];
      /** Private delivery envelope of the sending account; stored encrypted, never on shared timelines. */
      bcc?: readonly string[];
      subject: string;
      replyToMessageId?: string;
      replyToNativeMessageId?: string;
      inReplyToHeader?: string;
    };

export interface CreateIntentInput {
  /** Required for a brand-new email (no conversation); otherwise derived from the conversation. */
  accountId?: string;
  conversationId?: string | null;
  /** Idempotency key, unique per account. Generated for drafts when absent. */
  clientRequestId?: string;
  actor: CareActorType;
  purpose?: CareIntentPurpose;
  content: OutboxContent;
  contextRevision?: number | null;
  policyRevision?: string | number | null;
  sourceRunId?: string | null;
  createdBy?: string | null;
  maxAttempts?: number;
  /** Earliest dispatch time (auto-reply delay / scheduled window). */
  notBeforeMs?: number;
}

/**
 * Client-safe view for the API (never the native retry token, BCC list or message text). The status is
 * passed through as stored, `needs_review` included: the client decides how to present a delivery that
 * waits for a human.
 */
export function toCareOutboxDto(intent: OutboxIntentRecord): CareOutboxIntentDto {
  const status: CareDeliveryStatusDto = intent.status;
  return {
    id: intent.id,
    clientRequestId: intent.clientRequestId,
    conversationId: intent.conversationId ?? '',
    accountId: intent.accountId,
    status,
    receiptLevel: intent.receiptLevel,
    messageId: intent.canonicalMessageId,
    retryAtMs: intent.status === 'retry_wait' || intent.status === 'pending' ? intent.nextAttemptAtMs : null,
    errorCode: intent.statusReason ?? intent.lastErrorCode,
    createdAtMs: intent.createdAtMs,
    updatedAtMs: intent.updatedAtMs,
  };
}

/** Telegram: signed 64-bit random ID as a decimal string (never 0). Others: an opaque stable token. */
export function generateRetryToken(channel: CareChannel): string {
  if (channel === 'telegram') {
    for (;;) {
      const n = crypto.randomBytes(8).readBigInt64BE();
      if (n !== 0n) return n.toString();
    }
  }
  return `care-${crypto.randomUUID()}`;
}

const NAMESPACE: Record<CareChannel, string> = {
  zalo: 'zalo_chat',
  telegram: 'telegram_common_box',
  email: 'gmail_mailbox',
};

/** Prefix of the provisional native ID given to an accepted message the provider did not name. */
export const PROVISIONAL_NATIVE_PREFIX = 'local-out:';

/**
 * Builds the materializer the store runs inside the commit transaction: the accepted delivery becomes
 * (or links to) the canonical outbound message. If the provider echo arrived first, that row is
 * reused; if the echo comes later it finds this row (inserted live-observed) and is a duplicate, so
 * one delivery is exactly one canonical message.
 */
export function createOutboundMaterializer(stores: CareStores, now: () => number = Date.now): OutboxMaterializer {
  return ({ intent, nativeMessageId, remoteTimestampMs }) => {
    if (!intent.conversationId) return null; // brand-new mail: the sync brings the thread in
    const account = stores.accounts.getAccount(intent.accountId);
    const conversation = stores.conversations.getConversation(intent.conversationId);
    if (!account || !conversation) return null;

    const namespace = NAMESPACE[account.channel];
    const nativeId = nativeMessageId ?? `${PROVISIONAL_NATIVE_PREFIX}${intent.id}`;
    const existing = stores.messages.getMessageByNativeId(account.id, namespace, nativeId);
    if (existing) {
      if (existing.conversationId !== conversation.id) {
        throw new CareError('CONFIGURATION_CONFLICT', 'Provider message ID is already held by another conversation', 409);
      }
      return existing.id;
    }
    if (stores.messages.getTombstone(account.id, namespace, nativeId)) return null;

    const p = intent.payload;
    const message: NormalizedMessage = {
      accountId: account.id,
      externalConversationKey: conversation.externalKey,
      nativeMessageNamespace: namespace,
      nativeMessageId: nativeId,
      senderIdentityKey: null,
      senderRole: intent.actor === 'auto' ? 'agent' : 'operator',
      direction: 'out',
      origin: 'live',
      sentAtMs: remoteTimestampMs ?? now(),
      nativeVersion: null,
      text: p.text,
      metadata:
        p.kind === 'chat'
          ? {
              type: 'chat',
              conversationKind: conversation.kind,
              topicId: p.target.topicId,
              quote: p.target.replyToMessageId ? { messageId: p.target.replyToMessageId } : null,
            }
          : {
              type: 'email',
              subject: p.target.subject,
              from: account.nativeAccountId,
              to: [...p.target.to],
              cc: p.target.cc ? [...p.target.cc] : undefined,
              inReplyToHeader: p.target.inReplyToHeader,
            },
    };
    const saved = stores.messages.insertMessage(message, conversation.id, null, undefined, { liveObserved: true });
    stores.conversations.recomputeProjection(conversation.id);
    return saved.id;
  };
}

export interface ReceiptInput {
  accountId: string;
  clientRequestId?: string;
  nativeMessageId?: string;
  receiptLevel: CareReceiptLevel;
  remoteTimestampMs?: number;
}

export class CareOutboxService {
  private readonly materialize: OutboxMaterializer;

  constructor(
    private readonly db: Database.Database,
    private readonly stores: CareStores,
    private readonly opts: {
      now?: () => number;
      /**
       * Mail signature of an account. Applied (idempotently, via `withSignatureOnce`) to every email
       * payload built here: reply port, draft sink, draft edits. Chat channels never get one.
       */
      signatureFor?: (account: CareAccountRecord) => string | null | undefined;
    } = {},
  ) {
    this.materialize = createOutboundMaterializer(stores, () => this.now());
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  // ── creation ─────────────────────────────────────────────────────────────────────────────

  /** A draft awaiting human review. Idempotent per (account, clientRequestId). */
  createDraft(input: CreateIntentInput): { intent: OutboxIntentRecord; created: boolean } {
    return this.insert(input, 'draft');
  }

  /**
   * A delivery request that is ready to go (manual reply endpoint, auto reply). Idempotent: the same
   * clientRequestId with the same payload returns the same intent; a different payload is a 409.
   */
  enqueue(input: CreateIntentInput & { clientRequestId: string }): { intent: OutboxIntentRecord; created: boolean } {
    requireNonEmptyString(input.clientRequestId, 'clientRequestId', 256);
    return this.insert(input, 'pending');
  }

  private insert(input: CreateIntentInput, status: 'draft' | 'pending'): { intent: OutboxIntentRecord; created: boolean } {
    const actor = oneOf(ACTORS, input.actor, 'actor');
    const purpose = oneOf(PURPOSES, input.purpose ?? 'care', 'purpose');
    const { account, conversation } = this.resolveScope(input.accountId, input.conversationId);
    const built = this.buildPayload(account, conversation, input.content, actor, purpose);
    const clientRequestId = input.clientRequestId ?? `draft-${crypto.randomUUID()}`;

    const run = this.db.transaction(() => {
      // Re-use the stored token on an idempotent replay: only a new intent mints one.
      const existing = this.stores.outbox.getIntentByRequest(account.id, clientRequestId);
      const result = this.stores.outbox.insertIntent({
        accountId: account.id,
        conversationId: conversation?.id ?? null,
        clientRequestId,
        actor,
        purpose,
        status,
        payload: built.payload,
        payloadHash: this.hashFor(account, conversation, purpose, built),
        adapterRetryToken: existing?.adapterRetryToken ?? generateRetryToken(account.channel),
        replyMessageId: built.replyMessageId,
        contextRevision: input.contextRevision ?? null,
        policyRevision: input.policyRevision === undefined || input.policyRevision === null ? null : String(input.policyRevision),
        notBeforeMs: input.notBeforeMs,
        sourceRunId: input.sourceRunId ?? null,
        createdBy: input.createdBy ?? null,
        maxAttempts: input.maxAttempts,
        nowMs: this.now(),
      });
      return result;
    });
    return run.immediate();
  }

  // ── draft lifecycle ──────────────────────────────────────────────────────────────────────

  /** Edit bumps the payload revision and drops any approval; the target stays the one derived at creation. */
  editDraft(
    intentId: string,
    input: { expectedRevision: number; content: OutboxContent; contextRevision?: number | null; policyRevision?: string | number | null },
  ): OutboxIntentRecord {
    const intent = this.require(intentId);
    const { account, conversation } = this.resolveScope(intent.accountId, intent.conversationId);
    const built = this.buildPayload(account, conversation, input.content, intent.actor, intent.purpose);
    return this.stores.outbox.updatePayload(intentId, {
      expectedRevision: input.expectedRevision,
      payload: built.payload,
      payloadHash: this.hashFor(account, conversation, intent.purpose, built),
      contextRevision: input.contextRevision,
      policyRevision: input.policyRevision === undefined || input.policyRevision === null ? undefined : String(input.policyRevision),
      nowMs: this.now(),
    });
  }

  /** Approves exactly the reviewed revision; stale => 409 and re-review, never a silent send. */
  approveDraft(
    intentId: string,
    input: { expectedRevision: number; approvedBy?: string | null; currentContextRevision?: number | null },
  ): OutboxIntentRecord {
    return this.stores.outbox.approve(intentId, { ...input, nowMs: this.now() });
  }

  discardDraft(intentId: string): OutboxIntentRecord {
    return this.stores.outbox.discard(intentId, this.now());
  }

  /** Cancels only what has not gone out; otherwise says honestly whether it is underway/uncertain/sent. */
  cancel(intentId: string): CancelResult {
    return this.stores.outbox.cancel(intentId, this.now());
  }

  resolveReview(intentId: string, decision: 'resend' | 'abandon'): OutboxIntentRecord {
    return this.stores.outbox.resolveReview(intentId, decision, this.now());
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────

  get(intentId: string): OutboxIntentRecord | null {
    return this.stores.outbox.getIntent(intentId);
  }

  getByRequest(accountId: string, clientRequestId: string): OutboxIntentRecord | null {
    return this.stores.outbox.getIntentByRequest(accountId, clientRequestId);
  }

  list(filter: Parameters<CareStores['outbox']['listIntents']>[0] = {}): OutboxIntentRecord[] {
    return this.stores.outbox.listIntents(filter);
  }

  // ── receipts ─────────────────────────────────────────────────────────────────────────────

  /**
   * A provider receipt / echo / late ack for a delivery. It resolves the ORIGINAL attempt (even one
   * made under an older owner epoch), raises the receipt level monotonically, and links the canonical
   * message. It never makes the intent sendable again. Returns null when it refers to nothing we sent.
   */
  recordReceipt(receipt: ReceiptInput): AttemptOutcomeResult | null {
    oneOf(['accepted', 'delivered', 'read'] as const, receipt.receiptLevel, 'receiptLevel');
    const attempt = this.stores.outbox.findAttemptForReceipt(receipt);
    if (!attempt) return null;
    const run = this.db.transaction(() => {
      const result = this.stores.outbox.commitAttempt({
        attemptId: attempt.id,
        outcome: 'accepted',
        receiptLevel: receipt.receiptLevel,
        nativeMessageId: receipt.nativeMessageId ?? attempt.nativeMessageId,
        remoteTimestampMs: receipt.remoteTimestampMs ?? null,
        nowMs: this.now(),
        materialize: this.materialize,
      });
      this.adoptRealNativeId(result.intent, receipt.nativeMessageId);
      return result;
    });
    return run.immediate();
  }

  /** The provider named a message we booked under a provisional ID: move the canonical row to the real key. */
  private adoptRealNativeId(intent: OutboxIntentRecord, nativeMessageId: string | undefined): void {
    if (!nativeMessageId || !intent.canonicalMessageId) return;
    const message = this.stores.messages.getMessage(intent.canonicalMessageId);
    if (message && message.nativeMessageId.startsWith(PROVISIONAL_NATIVE_PREFIX) && message.nativeMessageId !== nativeMessageId) {
      this.stores.messages.rekeyNative(message.id, nativeMessageId);
    }
  }

  materializer(): OutboxMaterializer {
    return this.materialize;
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────

  private require(intentId: string): OutboxIntentRecord {
    const intent = this.stores.outbox.getIntent(intentId);
    if (!intent) throw new CareError('NOT_FOUND', `Outbox intent not found: ${intentId}`, 404);
    return intent;
  }

  private resolveScope(
    accountId: string | undefined,
    conversationId: string | null | undefined,
  ): { account: CareAccountRecord; conversation: CareConversationRecord | null } {
    let conversation: CareConversationRecord | null = null;
    if (conversationId) {
      conversation = this.stores.conversations.getConversation(conversationId);
      if (!conversation) throw new CareError('INVALID_TARGET', `Conversation not found: ${conversationId}`, 404);
      if (accountId && accountId !== conversation.accountId) {
        throw new CareError('INVALID_TARGET', 'Conversation does not belong to the given account', 400);
      }
    }
    const id = conversation?.accountId ?? accountId;
    if (!id) throw new CareError('INVALID_TARGET', 'accountId or conversationId is required', 400);
    const account = this.stores.accounts.getAccount(id);
    if (!account) throw new CareError('INVALID_TARGET', `Account not found: ${id}`, 404);
    return { account, conversation };
  }

  private buildPayload(
    account: CareAccountRecord,
    conversation: CareConversationRecord | null,
    content: OutboxContent,
    actor: CareActorType,
    purpose: CareIntentPurpose,
  ): { payload: OutboxPayload; replyMessageId: string | null } {
    oneOf(CARE_CHANNELS, account.channel, 'channel');
    if (!content || typeof content !== 'object') throw new CareError('INVALID_COMMAND', 'content is required', 400);

    let replyMessageId: string | null = null;
    let replyNativeId: string | undefined;
    let replyEmailHeader: string | undefined;
    if (content.replyToMessageId || content.replyToNativeMessageId) {
      const replied = content.replyToMessageId
        ? this.stores.messages.getMessage(content.replyToMessageId)
        : this.stores.messages.getMessageByNativeId(account.id, NAMESPACE[account.channel], content.replyToNativeMessageId!);
      if (!replied || replied.accountId !== account.id || (conversation && replied.conversationId !== conversation.id)) {
        throw new CareError('INVALID_TARGET', 'The answered message does not belong to this conversation', 400);
      }
      replyMessageId = replied.id;
      replyNativeId = replied.nativeMessageId;
      if (replied.metadata.type === 'email') replyEmailHeader = replied.metadata.messageIdHeader;
    }

    let payload: OutboxPayload;
    if (content.kind === 'chat') {
      if (account.channel === 'email') throw new CareError('INVALID_TARGET', 'Chat content cannot be sent from an email account', 400);
      if (!conversation) throw new CareError('INVALID_TARGET', 'A chat reply needs a conversation', 400);
      payload = {
        kind: 'chat',
        channel: account.channel,
        text: content.text,
        target: {
          externalConversationKey: conversation.externalKey,
          ...(replyNativeId ? { replyToMessageId: replyNativeId } : {}),
          ...(content.topicId ? { topicId: content.topicId } : {}),
        },
      };
    } else if (content.kind === 'email') {
      if (account.channel !== 'email') throw new CareError('INVALID_TARGET', 'Email content needs an email account', 400);
      payload = {
        kind: 'email',
        channel: 'email',
        text: withSignatureOnce(content.text, this.opts.signatureFor?.(account)),
        target: {
          ...(conversation ? { externalConversationKey: conversation.externalKey } : {}),
          to: [...(content.to ?? [])],
          ...(content.cc?.length ? { cc: [...content.cc] } : {}),
          subject: content.subject,
          ...(replyNativeId ? { replyToMessageId: replyNativeId } : {}),
          ...((content.inReplyToHeader ?? replyEmailHeader) ? { inReplyToHeader: content.inReplyToHeader ?? replyEmailHeader } : {}),
        },
        ...(content.bcc?.length ? { bcc: [...content.bcc] } : {}),
      };
    } else {
      throw new CareError('INVALID_COMMAND', `Unknown content kind '${String((content as { kind?: string }).kind)}'`, 400);
    }

    // Structural validation (channel congruence, recipient syntax, header safety) at the boundary.
    const probe = { ...payload, clientRequestId: 'probe', accountId: account.id, purpose, actor, ownerEpoch: 1 } as DeliveryCommand;
    validateDeliveryCommand(probe);
    return { payload, replyMessageId };
  }

  private hashFor(
    account: CareAccountRecord,
    conversation: CareConversationRecord | null,
    purpose: CareIntentPurpose,
    built: { payload: OutboxPayload; replyMessageId: string | null },
  ): string {
    const p = built.payload;
    const lower = (list: string[] | undefined) => [...(list ?? [])].map((a) => a.toLowerCase()).sort();
    const normalized =
      p.kind === 'email'
        ? { ...p, target: { ...p.target, to: lower(p.target.to), cc: lower(p.target.cc) }, bcc: lower(p.bcc) }
        : p;
    return this.stores.outbox.hashPayload({
      accountId: account.id,
      conversationId: conversation?.id ?? null,
      purpose,
      replyMessageId: built.replyMessageId,
      payload: normalized,
    });
  }
}

// ── Reply port (consumed by the API layer: api/ports.ts) ─────────────────────────────────────

/**
 * Implements `CareReplyPort`. `POST /conversations/:id/replies` => `submitReply`: the immutable
 * target arrives already resolved from the stored conversation; this port re-derives and compares it
 * (a caller cannot redirect a reply), enforces idempotency, and applies `expectedConversationRevision`
 * only to a NEW request (a retry of an accepted request returns the same intent regardless).
 */
export function createCareReplyPort(deps: {
  service: CareOutboxService;
  stores: CareStores;
  /** Wired to `dispatcher.reconcile`; absent => the reconcile route answers UNSUPPORTED_CAPABILITY. */
  reconcile?: (intentId: string) => Promise<OutboxIntentRecord>;
}): CareReplyPort {
  const { service, stores } = deps;
  return {
    async submitReply(request: CareReplyRequest): Promise<CareReplyAcceptance> {
      const conversation = stores.conversations.getConversation(request.conversationId);
      if (!conversation || conversation.accountId !== request.accountId) {
        throw new CareError('INVALID_TARGET', 'Conversation not found for this account', 404);
      }
      const account = stores.accounts.getAccount(conversation.accountId);
      if (!account || account.channel !== request.channel) {
        throw new CareError('INVALID_TARGET', 'Channel does not match the conversation account', 400);
      }
      if (request.target.externalConversationKey !== conversation.externalKey) {
        throw new CareError('INVALID_TARGET', 'Target does not match the stored conversation', 400);
      }
      const t = request.target;
      const content: OutboxContent =
        t.kind === 'chat'
          ? {
              kind: 'chat',
              text: request.text,
              ...(t.replyToMessageId ? { replyToNativeMessageId: t.replyToMessageId } : {}),
              ...(t.topicId ? { topicId: t.topicId } : {}),
            }
          : {
              kind: 'email',
              text: request.text,
              to: t.to,
              ...(t.cc ? { cc: t.cc } : {}),
              ...(request.bcc ? { bcc: request.bcc } : {}),
              subject: t.subject,
              ...(t.replyToMessageId ? { replyToNativeMessageId: t.replyToMessageId } : {}),
              ...(t.inReplyToHeader ? { inReplyToHeader: t.inReplyToHeader } : {}),
            };

      const known = service.getByRequest(account.id, request.clientRequestId);
      if (!known && request.expectedConversationRevision !== undefined && request.expectedConversationRevision !== conversation.revision) {
        throw new CareError('STALE_REVISION', 'The conversation changed since it was viewed; review the new messages first', 409, {
          currentRevision: conversation.revision,
        });
      }
      const { intent, created } = service.enqueue({
        accountId: account.id,
        conversationId: conversation.id,
        clientRequestId: request.clientRequestId,
        actor: 'manual',
        purpose: 'care',
        content,
        contextRevision: request.expectedConversationRevision ?? conversation.revision,
      });
      return { intent: toCareOutboxDto(intent), duplicate: !created };
    },

    async getOutbox(intentId) {
      const intent = service.get(intentId);
      return intent ? toCareOutboxDto(intent) : null;
    },

    async cancel(intentId) {
      if (!service.get(intentId)) return null;
      // Not cancellable (underway / uncertain / sent) is not an error: the DTO carries the truth.
      return toCareOutboxDto(service.cancel(intentId).intent);
    },

    async reconcile(intentId) {
      if (!service.get(intentId)) return null;
      if (!deps.reconcile) throw new CareError('UNSUPPORTED_CAPABILITY', 'Reconcile is not wired', 501);
      return toCareOutboxDto(await deps.reconcile(intentId));
    },
  };
}

// ── Draft sink (consumed by the Agent Care turn: application/agent-ports.ts) ─────────────────

function composeDraftText(proposal: DraftProposal): string {
  // Same helper as the reply route and the service: the signature is appended exactly once.
  return withSignatureOnce(proposal.text, proposal.signature);
}

/**
 * The only way a model decision becomes an outbound candidate: always through core, into the same
 * idempotent store (the proposal's `idempotencyKey` = run ID, so a crashed turn proposing twice yields
 * one intent). A proposal that needs review, or whose effective mode is `draft`, waits for a human
 * (actor `approved` once approved); an effective `auto` proposal is enqueued as actor `auto` with its
 * delay, and still passes every dispatch guard (including the auto-only freshness / human-pause ones)
 * before the RPC. The model cannot change account, conversation, channel or recipient.
 */
export function createCareDraftSink(
  service: CareOutboxService,
  stores: CareStores,
  opts: { now?: () => number; random?: () => number } = {},
): { propose(proposal: DraftProposal): { draftRef: string } } {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  return {
    propose(proposal: DraftProposal): { draftRef: string } {
      const conversation = stores.conversations.getConversation(proposal.target.conversationId);
      if (!conversation || conversation.accountId !== proposal.target.accountId) {
        throw new CareError('INVALID_TARGET', 'Proposal target does not match the stored conversation', 400);
      }
      const account = stores.accounts.getAccount(conversation.accountId);
      if (!account || account.channel !== proposal.target.channel) {
        throw new CareError('INVALID_TARGET', 'Proposal channel does not match the conversation account', 400);
      }
      const text = composeDraftText(proposal);
      const replied = proposal.replies.length === 1 ? proposal.replies[0].replyToMessageId : null;

      let content: OutboxContent;
      if (account.channel === 'email') {
        const trigger = stores.messages.getMessage(proposal.triggerMessageId);
        if (!trigger || trigger.conversationId !== conversation.id || trigger.metadata.type !== 'email') {
          throw new CareError('INVALID_TARGET', 'Email draft needs the triggering email of this conversation', 400);
        }
        const meta = trigger.metadata;
        const subject = /^re:/i.test(meta.subject) ? meta.subject : `Re: ${meta.subject}`;
        content = { kind: 'email', text, to: [meta.replyTo ?? meta.from], subject, replyToMessageId: trigger.id };
      } else {
        content = { kind: 'chat', text, ...(replied ? { replyToMessageId: replied } : {}) };
      }

      const base = {
        accountId: account.id,
        conversationId: conversation.id,
        clientRequestId: `agent-turn:${proposal.idempotencyKey}`,
        purpose: 'care' as const,
        content,
        contextRevision: proposal.contextRevision,
        policyRevision: proposal.policyRevision,
        sourceRunId: proposal.runId,
        createdBy: `agent:${proposal.agentId}`,
      };

      const auto = proposal.delivery.effective === 'auto' && !proposal.needsReview;
      if (!auto) {
        return { draftRef: service.createDraft({ ...base, actor: 'approved' }).intent.id };
      }
      const delay = proposal.delivery.autoDelay;
      const delayMs = delay ? Math.round((delay.minSeconds + random() * Math.max(0, delay.maxSeconds - delay.minSeconds)) * 1000) : 0;
      const adjustment = proposal.delivery.adjustment;
      const deferUntil = adjustment?.kind === 'defer' && adjustment.notBeforeMs ? adjustment.notBeforeMs : 0;
      const notBeforeMs = Math.max(now() + delayMs, deferUntil);
      return { draftRef: service.enqueue({ ...base, actor: 'auto', notBeforeMs }).intent.id };
    },
  };
}
