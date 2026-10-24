/**
 * Transactional Customer Care Ingest Pipeline
 *
 * Every event branch (created/edited/deleted/conversation/account/read/delivery) and the direct
 * message helper run through ONE boundary, inside a single IMMEDIATE SQLite transaction:
 *
 *   validate envelope -> account exists -> owner-epoch fence -> ledger dedupe (account+eventId)
 *   -> effects (validated against account/conversation/identity/namespace) -> typed checkpoint
 *   (adapter CAS / monotonic position) -> ledger row -> done
 *
 * Any throw rolls back effects, checkpoint, ledger row and jobs together. A repeated
 * (account, eventId) is suppressed BEFORE any effect (so it cannot double-apply anything), and
 * deduped / tombstoned / ignored outcomes still leave a ledger row.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { compareNativeVersions, deriveNativeOrderKey, hasMonotonicNativeIds, isValidMessageNamespace } from '../../../_lib/care-kit/checkpoint.js';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { resolveEffectiveRule } from '../policy/assignment-resolver.js';
import type {
  CareAccountRecord,
  CareCheckpoint,
  CareConversationRecord,
  CareIdentityRecord,
  CareReceiptLevel,
  NormalizedEvent,
  NormalizedMessage,
} from '../../../_lib/care-kit/types.js';
import {
  CARE_HEALTH_STATES,
  defaultConversationKind,
  oneOf,
  requireConversationKindForChannel,
  requireNonEmptyString,
  requireSafeInteger,
  requireTimestampMs,
} from '../../../_lib/care-kit/validation.js';
import type { CareStores } from '../persistence/index.js';
import type { CheckpointOutcome } from '../persistence/stores.js';
import type { WatermarkTarget } from '../persistence/conversation-store.js';
import { isDirectedAtAccount } from './projector.js';
import { aiChannelGate } from '../domain/ai-block.js';

export type IngestOutcome =
  | 'created'
  | 'edited'
  | 'deleted'
  | 'duplicate_ignored'
  | 'duplicate_event'
  | 'ignored_tombstone'
  | 'ignored_stale_version'
  | 'ignored_unordered_version'
  | 'tombstone_created'
  | 'conversation_updated'
  | 'account_status_updated'
  | 'read_updated'
  | 'read_pending'
  | 'read_unresolved'
  | 'live_observed'
  | 'delivery_confirmed';

export interface IngestResult {
  outcome: IngestOutcome;
  messageId?: string;
  conversationId?: string;
  eventId?: string;
  jobId?: string;
  /** What happened to the adapter checkpoint (absent when the event carried none). */
  checkpoint?: CheckpointOutcome;
}

/** Re-exported: adapter-owned causal comparison (null => unordered, never guessed). */
export { compareNativeVersions };

interface Effect {
  outcome: IngestOutcome;
  messageId?: string;
  conversationId?: string;
  jobId?: string;
  /** Allowlisted, ID-only ledger fields (scrubbed again by the event store). */
  ledger: Record<string, unknown>;
}

const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A provider receipt that names a message we sent. Handed to the delivery layer after the ingest commit. */
export interface DeliveryConfirmation {
  accountId: string;
  clientRequestId: string;
  nativeMessageId: string;
  receiptLevel: CareReceiptLevel;
  remoteTimestampMs: number;
}

export interface IngestPipelineOptions {
  /**
   * Called AFTER the ingest transaction committed, for every `delivery.confirmed` event (also a
   * replayed one, so a crash between commit and callback is repaired by the adapter's retry; the
   * receipt handler must be idempotent). An exception propagates so the adapter retries.
   * Default: no-op, ingest has no dependency on the delivery layer.
   */
  onDeliveryConfirmed?: (receipt: DeliveryConfirmation) => void;
}

export class CareIngestPipeline {
  constructor(
    private readonly db: Database.Database,
    private readonly stores: CareStores,
    private readonly options: IngestPipelineOptions = {},
  ) {}

  /** Ingest a normalized event atomically. */
  ingestNormalizedEvent(event: NormalizedEvent): IngestResult {
    this.validateEnvelope(event);

    switch (event.type) {
      case 'message.created':
      case 'message.edited': {
        if (event.accountId !== event.message?.accountId) {
          throw new CareError(
            'INVALID_TARGET',
            `Cross-account mismatch: event.accountId (${event.accountId}) !== message.accountId (${event.message?.accountId})`,
            400,
          );
        }
        return this.execute(event, (account) =>
          event.type === 'message.created' ? this.applyCreate(account, event.message) : this.applyEdit(account, event.message),
        );
      }
      case 'message.deleted':
        return this.execute(event, (account) => this.applyDelete(account, event));
      case 'conversation.updated':
        return this.execute(event, (account) => this.applyConversationUpdated(account, event));
      case 'account.status':
        return this.execute(event, (account) => this.applyAccountStatus(account, event));
      case 'read.updated':
        return this.execute(event, (account) => this.applyRead(account, event));
      case 'delivery.confirmed': {
        const result = this.execute(event, (account) => this.applyDeliveryConfirmed(account, event));
        this.options.onDeliveryConfirmed?.({
          accountId: event.accountId,
          clientRequestId: event.clientRequestId,
          nativeMessageId: event.nativeMessageId,
          receiptLevel: event.receiptLevel,
          remoteTimestampMs: event.timestampMs,
        });
        return result;
      }
      default:
        throw new CareError('INVALID_COMMAND', `Unsupported event type '${String((event as { type?: string }).type)}'`, 400);
    }
  }

  /**
   * Direct helper for a single message: same boundary as a `message.created` event, so epoch,
   * ledger and checkpoint rules are identical. `epoch` is the runtime's ownership epoch.
   */
  ingestNormalizedMessage(
    msg: NormalizedMessage,
    checkpoint?: CareCheckpoint,
    epoch = 1,
    eventId?: string,
  ): IngestResult {
    return this.ingestNormalizedEvent({
      type: 'message.created',
      eventId: eventId ?? `direct_${crypto.randomUUID()}`,
      accountId: msg.accountId,
      timestampMs: msg.sentAtMs,
      epoch,
      checkpoint,
      message: msg,
    });
  }

  // ── boundary ────────────────────────────────────────────────────────────────────────────

  private validateEnvelope(event: NormalizedEvent): void {
    requireNonEmptyString(event?.eventId, 'eventId', 256);
    requireNonEmptyString(event.accountId, 'accountId', 256);
    requireTimestampMs(event.timestampMs, 'timestampMs');
    if (event.epoch !== undefined) requireSafeInteger(event.epoch, 'epoch', 1);
    if (event.checkpoint !== undefined && (event.checkpoint === null || typeof event.checkpoint !== 'object')) {
      throw new CareError('INVALID_CURSOR', 'checkpoint must be a typed { namespace, cursor } object', 400);
    }
  }

  private execute(event: NormalizedEvent, apply: (account: CareAccountRecord) => Effect): IngestResult {
    const tx = this.db.transaction((): IngestResult => {
      const account = this.stores.accounts.getAccount(event.accountId);
      if (!account) {
        throw new CareError('INVALID_TARGET', `Account not found: ${event.accountId}`, 404);
      }

      // Owner-epoch fence. A missing epoch means epoch 1, so a writer that never learnt a newer
      // epoch is rejected as soon as the account moves on.
      const epoch = event.epoch ?? 1;
      // One narrow exception: a provider RECEIPT from an OLDER epoch still belongs to the attempt
      // that epoch made (the remote fact is true whoever owns the account now). It is ledgered and
      // handed to the delivery layer, nothing more: no checkpoint, no conversation/message
      // effect, no job, and it grants that epoch no permission to send. A NEWER epoch, a
      // different account and every other event kind stay fenced.
      const staleReceipt = event.type === 'delivery.confirmed' && epoch < account.ownerEpoch;
      if (epoch !== account.ownerEpoch && !staleReceipt) {
        throw new CareError(
          'FENCING_REJECTED',
          `Stale ingest epoch ${epoch}; account ${account.id} is at epoch ${account.ownerEpoch}`,
          409,
        );
      }

      // Ledger dedupe: (account, eventId) already processed => no effect of any kind.
      if (this.stores.events.hasEvent(account.id, event.eventId)) {
        return { outcome: 'duplicate_event', eventId: event.eventId };
      }

      const effect = apply(account);

      // A stale-epoch receipt never moves an adapter checkpoint (that writer no longer owns it).
      const checkpointOutcome = event.checkpoint && !staleReceipt ? this.stores.checkpoints.advance(account.id, event.checkpoint) : undefined;

      this.stores.events.appendEvent({
        eventId: event.eventId,
        accountId: account.id,
        conversationId: effect.conversationId ?? null,
        eventType: event.type,
        checkpoint: event.checkpoint ? { namespace: event.checkpoint.namespace, cursor: event.checkpoint.cursor } : null,
        epoch,
        payload: {
          ...effect.ledger,
          outcome: effect.outcome,
          checkpointOutcome: checkpointOutcome ?? null,
        },
      });

      return {
        outcome: effect.outcome,
        messageId: effect.messageId,
        conversationId: effect.conversationId,
        jobId: effect.jobId,
        eventId: event.eventId,
        checkpoint: checkpointOutcome,
      };
    });
    return tx.immediate();
  }

  // ── message branches ────────────────────────────────────────────────────────────────────

  private messageLedger(msg: NormalizedMessage, messageId?: string): Record<string, unknown> {
    return {
      messageId: messageId ?? null,
      nativeMessageId: msg.nativeMessageId,
      nativeNamespace: msg.nativeMessageNamespace,
      direction: msg.direction,
      senderRole: msg.senderRole,
      origin: msg.origin,
      sentAtMs: msg.sentAtMs,
      nativeVersion: msg.nativeVersion ?? null,
    };
  }

  /** Existing message for this native key must live in exactly the conversation the event names. */
  private requireSameConversation(
    existingConversationId: string,
    conversation: CareConversationRecord | null,
  ): CareConversationRecord {
    if (!conversation || conversation.id !== existingConversationId) {
      throw new CareError(
        'INVALID_TARGET',
        'Native message ID is already bound to a different conversation; refusing to re-home it',
        400,
      );
    }
    return conversation;
  }

  /**
   * `edit_first_sight`: the message was first seen through an EDIT. We hold its latest body but
   * learned nothing about when it really arrived, so it is stored as a recovery sighting
   * (provenance) and never triggers a turn; a later genuine live observation can still promote it.
   */
  private applyCreate(account: CareAccountRecord, msg: NormalizedMessage, mode: 'create' | 'edit_first_sight' = 'create'): Effect {
    this.stores.messages.assertValid(msg, account.channel);

    const existing = this.stores.messages.getMessageByNativeId(account.id, msg.nativeMessageNamespace, msg.nativeMessageId);
    let conversation = this.stores.conversations.getConversationByExternalKey(account.id, msg.externalConversationKey);

    if (existing) {
      const conv = this.requireSameConversation(existing.conversationId, conversation);
      const ledger = this.messageLedger(msg, existing.id);
      if (existing.tombstone || existing.isDeleted) {
        return { outcome: 'ignored_tombstone', messageId: existing.id, conversationId: conv.id, ledger };
      }
      // A payload that states the message is deleted is a delete of what we already hold.
      if (msg.isDeleted) return this.deleteExisting(existing.id, conv.id, ledger);

      // History/recovery/edit first, genuine live observation later: promote (durable flag; the
      // original origin stays as provenance) and evaluate the policy job exactly once.
      if (mode === 'create' && msg.origin === 'live' && !existing.liveObserved) {
        if (msg.direction !== existing.direction || msg.senderRole !== existing.senderRole) {
          throw new CareError('INVALID_TARGET', 'Live observation contradicts the stored direction/sender of the message', 400);
        }
        this.stores.messages.markLiveObserved(existing.id);
        const refreshed = this.stores.conversations.recomputeProjection(conv.id);
        const identity = this.resolveSender(account, msg);
        const { jobId, job } = this.maybeEnqueueTurn(account, refreshed, msg, existing.id, identity, existing.directedAtAccount);
        return { outcome: 'live_observed', messageId: existing.id, conversationId: conv.id, jobId, ledger: { ...ledger, job } };
      }
      return { outcome: 'duplicate_ignored', messageId: existing.id, conversationId: conv.id, ledger };
    }

    // A delete that arrived first (possibly without a peer) suppresses the body and is bound now.
    const tombstone = this.stores.messages.getTombstone(account.id, msg.nativeMessageNamespace, msg.nativeMessageId);
    if (tombstone && tombstone.externalConversationKey && tombstone.externalConversationKey !== msg.externalConversationKey) {
      throw new CareError('INVALID_TARGET', 'Native message ID was deleted in a different conversation; refusing to re-home it', 400);
    }

    // Conversation kind comes from the typed payload; absent => the channel's default (DM / email thread).
    const declaredKind = msg.metadata.type === 'chat' ? msg.metadata.conversationKind : 'email_thread';
    if (!conversation) {
      const kind = requireConversationKindForChannel(account.channel, declaredKind ?? defaultConversationKind(account.channel));
      const title = msg.metadata.type === 'email' ? msg.metadata.subject : `Chat ${msg.externalConversationKey}`;
      conversation = this.stores.conversations.upsertConversation({
        accountId: account.id,
        externalKey: msg.externalConversationKey,
        kind,
        title,
      });
    }

    // Already flagged deleted on arrival, or a tombstone is waiting for it: store only the tombstone row.
    if (msg.isDeleted || tombstone) {
      const row = this.stores.messages.insertTombstone(
        account.id,
        conversation.id,
        msg.nativeMessageNamespace,
        msg.nativeMessageId,
        msg.sentAtMs,
      );
      if (tombstone) this.stores.messages.deleteTombstone(account.id, msg.nativeMessageNamespace, msg.nativeMessageId);
      return {
        outcome: tombstone ? 'ignored_tombstone' : 'tombstone_created',
        messageId: row.id,
        conversationId: conversation.id,
        ledger: this.messageLedger(msg, row.id),
      };
    }

    const origin = mode === 'edit_first_sight' && msg.origin === 'live' ? 'recovery' : msg.origin;
    const stored = origin === msg.origin ? msg : { ...msg, origin };
    const identity = this.resolveSender(account, msg);
    const directedAtAccount = isDirectedAtAccount(account, msg);
    const saved = this.stores.messages.insertMessage(stored, conversation.id, identity?.id ?? null, undefined, { directedAtAccount });

    if (
      identity &&
      msg.senderRole === 'customer' &&
      conversation.kind === 'direct' &&
      !conversation.primaryCustomerId
    ) {
      this.stores.conversations.setPrimaryCustomer(conversation.id, identity.customerId);
    }

    // Provider receipts that arrived before this message take effect now (same original event).
    this.resolvePendingReceipts(account, conversation.externalKey, saved);

    conversation = this.stores.conversations.recomputeProjection(conversation.id);

    if (mode === 'edit_first_sight') {
      return {
        outcome: 'created',
        messageId: saved.id,
        conversationId: conversation.id,
        ledger: { ...this.messageLedger(stored, saved.id), job: 'none_first_sight_edit' },
      };
    }
    const { jobId, job } = this.maybeEnqueueTurn(account, conversation, msg, saved.id, identity, directedAtAccount);

    return {
      outcome: 'created',
      messageId: saved.id,
      conversationId: conversation.id,
      jobId,
      ledger: { ...this.messageLedger(msg, saved.id), job },
    };
  }

  private watermarkOf(row: { nativeMessageNamespace: string; nativeOrderKey: string | null; sentAtMs: number; id: string }): WatermarkTarget {
    return { namespace: row.nativeMessageNamespace, orderKey: row.nativeOrderKey, sentAtMs: row.sentAtMs, messageId: row.id };
  }

  private resolvePendingReceipts(
    account: CareAccountRecord,
    externalConversationKey: string,
    message: { id: string; conversationId: string; nativeMessageNamespace: string; nativeMessageId: string; nativeOrderKey: string | null; sentAtMs: number },
  ): void {
    const pending = this.stores.conversations.listPendingReceipts(
      account.id,
      externalConversationKey,
      message.nativeMessageNamespace,
      message.nativeMessageId,
    );
    for (const receipt of pending) {
      this.stores.conversations.advanceRemoteWatermark(
        message.conversationId,
        receipt.direction,
        this.watermarkOf({ ...message }),
      );
      this.stores.conversations.deletePendingReceipt(account.id, receipt.eventId);
    }
  }

  /** Customers are only auto-created for customer-role senders; other roles only link existing identities. */
  private resolveSender(account: CareAccountRecord, msg: NormalizedMessage): CareIdentityRecord | null {
    if (!msg.senderIdentityKey) return null;
    const namespace = msg.metadata.type === 'email' ? 'email' : 'user';
    const found = this.stores.identities.getIdentityByExternal(account.id, namespace, msg.senderIdentityKey);
    if (found) {
      if (found.accountId !== account.id) throw new CareError('INVALID_TARGET', 'Cross-account identity mismatch', 400);
      return found;
    }
    if (msg.senderRole !== 'customer') return null;

    const customer = this.stores.customers.createCustomer({
      displayName: msg.senderIdentityKey,
      email: msg.metadata.type === 'email' ? msg.senderIdentityKey : null,
    });
    return this.stores.identities.createIdentity({
      customerId: customer.id,
      accountId: account.id,
      namespace,
      externalIdentityId: msg.senderIdentityKey,
      displayName: msg.senderIdentityKey,
    });
  }

  /**
   * Cheap policy-evaluation job, never a model call. Requires ALL of: live + inbound + customer,
   * core write owner, active desired state, AI and sync gates on, non-Telegram, the message is
   * relevant to this account (DM/email, or a group message that targets it), and the effective
   * assignment (conversation > customer > identity > domain > account > channel > global,
   * explicit disabled = deny) is enabled and not `observe`. The full agent policy is CC-10.
   */
  private maybeEnqueueTurn(
    account: CareAccountRecord,
    conversation: CareConversationRecord,
    msg: NormalizedMessage,
    savedMessageId: string,
    identity: CareIdentityRecord | null,
    directedAtAccount: boolean,
  ): { jobId?: string; job: string } {
    const eligibleLiveInbound =
      msg.origin === 'live' &&
      msg.direction === 'in' &&
      msg.senderRole === 'customer' &&
      account.writeOwner === 'core' &&
      account.desiredState === 'active' &&
      account.aiEnabled &&
      account.syncEnabled &&
      aiChannelGate(account.channel).allowed;
    if (!eligibleLiveInbound) return { job: 'none' };

    const relevant = conversation.kind === 'direct' || conversation.kind === 'email_thread' || directedAtAccount;
    if (!relevant) return { job: 'skipped_not_directed' };

    let resolution;
    try {
      resolution = resolveEffectiveRule(this.stores.assignments.listAssignments(account.id), {
        accountId: account.id,
        channel: account.channel,
        conversationKey: msg.externalConversationKey,
        conversationKind: conversation.kind,
        customerId: identity?.customerId ?? conversation.primaryCustomerId,
        identityKey: msg.senderIdentityKey,
        emailSender: msg.metadata.type === 'email' ? msg.senderIdentityKey : null,
      });
    } catch (err) {
      if (err instanceof CareError && err.code === 'CONFIGURATION_CONFLICT') return { job: 'skipped_assignment_conflict' };
      throw err;
    }
    if (resolution.status === 'none') return { job: 'skipped_no_assignment' };
    if (resolution.status === 'denied') return { job: 'skipped_assignment_disabled' };
    if (resolution.rule.mode === 'observe') return { job: 'skipped_observe' };

    const job = this.stores.jobs.enqueueJob({
      accountId: account.id,
      jobType: 'inbound_turn',
      conversationId: conversation.id,
      dedupeKey: `turn_${conversation.id}_${savedMessageId}`,
      payload: {
        accountId: account.id,
        conversationId: conversation.id,
        messageId: savedMessageId,
        sentAtMs: msg.sentAtMs,
      },
      ownerEpoch: account.ownerEpoch,
    });
    return { jobId: job.id, job: 'enqueued' };
  }

  /** Purges the body/metadata of a held message, keeps the native key as a tombstone, refreshes the projection. */
  private deleteExisting(messageId: string, conversationId: string, ledger: Record<string, unknown>): Effect {
    this.stores.messages.softDeleteMessage(messageId);
    this.stores.conversations.recomputeProjection(conversationId);
    return { outcome: 'deleted', messageId, conversationId, ledger };
  }

  private applyEdit(account: CareAccountRecord, msg: NormalizedMessage): Effect {
    this.stores.messages.assertValid(msg, account.channel);

    const existing = this.stores.messages.getMessageByNativeId(account.id, msg.nativeMessageNamespace, msg.nativeMessageId);
    // An edit for a message we never saw is the first sight of that message.
    if (!existing) return this.applyCreate(account, msg, 'edit_first_sight');

    const conversation = this.requireSameConversation(
      existing.conversationId,
      this.stores.conversations.getConversationByExternalKey(account.id, msg.externalConversationKey),
    );
    const base = { messageId: existing.id, conversationId: conversation.id, ledger: this.messageLedger(msg, existing.id) };

    if (existing.tombstone || existing.isDeleted) return { outcome: 'ignored_tombstone', ...base };
    if (msg.isDeleted) return this.deleteExisting(existing.id, conversation.id, base.ledger);
    if (msg.direction !== existing.direction) {
      throw new CareError('INVALID_TARGET', 'Edit cannot change the direction of a message', 400);
    }

    // Adapter-owned causal versions only. Unordered pairs are NOT resolved by arrival time: the
    // adapter must re-fetch the latest state.
    const cmp = compareNativeVersions(msg.nativeVersion, existing.nativeVersion);
    if (cmp === null) return { outcome: 'ignored_unordered_version', ...base };
    if (cmp <= 0) return { outcome: 'ignored_stale_version', ...base };

    this.stores.messages.updateMessageVersion(existing.id, msg.nativeVersion as string, msg.text, msg.metadata, {
      directedAtAccount: isDirectedAtAccount(account, msg),
    });
    this.stores.conversations.recomputeProjection(conversation.id);
    return { outcome: 'edited', ...base };
  }

  /**
   * Delete. The peer is OPTIONAL (Telegram common-box deletes carry message IDs only):
   *  - message held      -> delete it; a stated peer must match the message's conversation
   *  - message not held  -> persist an account+namespace tombstone WITHOUT inventing a
   *                         conversation; it is bound (and suppresses the body) when the message
   *                         later arrives with its peer. A stated peer that conflicts with an
   *                         already-bound tombstone is rejected.
   */
  private applyDelete(account: CareAccountRecord, event: Extract<NormalizedEvent, { type: 'message.deleted' }>): Effect {
    if (!isValidMessageNamespace(account.channel, event.nativeMessageNamespace)) {
      throw new CareError(
        'INVALID_TARGET',
        `Message namespace '${event.nativeMessageNamespace}' is not valid for channel '${account.channel}'`,
        400,
      );
    }
    requireNonEmptyString(event.nativeMessageId, 'nativeMessageId', 512);
    const peer = event.externalConversationKey === undefined ? null : requireNonEmptyString(event.externalConversationKey, 'externalConversationKey', 1024);

    const ledger = {
      nativeMessageId: event.nativeMessageId,
      nativeNamespace: event.nativeMessageNamespace,
      nativeVersion: event.nativeVersion ?? null,
    };

    const existing = this.stores.messages.getMessageByNativeId(account.id, event.nativeMessageNamespace, event.nativeMessageId);
    if (existing) {
      if (peer !== null) {
        this.requireSameConversation(existing.conversationId, this.stores.conversations.getConversationByExternalKey(account.id, peer));
      }
      if (existing.tombstone || existing.isDeleted) {
        return { outcome: 'ignored_tombstone', messageId: existing.id, conversationId: existing.conversationId, ledger: { ...ledger, messageId: existing.id } };
      }
      return this.deleteExisting(existing.id, existing.conversationId, { ...ledger, messageId: existing.id });
    }

    const bound = this.stores.messages.getTombstone(account.id, event.nativeMessageNamespace, event.nativeMessageId);
    if (bound && bound.externalConversationKey && peer !== null && bound.externalConversationKey !== peer) {
      throw new CareError('INVALID_TARGET', 'Native message ID was already deleted in a different conversation', 400);
    }
    this.stores.messages.recordTombstone(account.id, event.nativeMessageNamespace, event.nativeMessageId, peer, event.timestampMs);
    return { outcome: bound ? 'ignored_tombstone' : 'tombstone_created', ledger };
  }

  // ── non-message branches ────────────────────────────────────────────────────────────────

  private applyConversationUpdated(
    account: CareAccountRecord,
    event: Extract<NormalizedEvent, { type: 'conversation.updated' }>,
  ): Effect {
    requireNonEmptyString(event.externalConversationKey, 'externalConversationKey', 1024);
    const kind = event.kind === undefined ? undefined : requireConversationKindForChannel(account.channel, event.kind);
    if (event.title !== undefined && typeof event.title !== 'string') {
      throw new CareError('INVALID_COMMAND', 'title must be a string', 400);
    }

    let conversation = this.stores.conversations.getConversationByExternalKey(account.id, event.externalConversationKey);
    if (!conversation) {
      conversation = this.stores.conversations.upsertConversation({
        accountId: account.id,
        externalKey: event.externalConversationKey,
        kind: kind ?? defaultConversationKind(account.channel),
        title: event.title ?? `Chat ${event.externalConversationKey}`,
      });
    } else if (event.title !== undefined || kind !== undefined) {
      conversation = this.stores.conversations.upsertConversation({
        accountId: account.id,
        externalKey: event.externalConversationKey,
        kind: kind ?? conversation.kind,
        title: event.title ?? conversation.title,
      });
    }

    // Title is deliberately NOT part of the ledger payload.
    return {
      outcome: 'conversation_updated',
      conversationId: conversation.id,
      ledger: { conversationId: conversation.id, kind: conversation.kind },
    };
  }

  private applyAccountStatus(
    account: CareAccountRecord,
    event: Extract<NormalizedEvent, { type: 'account.status' }>,
  ): Effect {
    const health = oneOf(CARE_HEALTH_STATES, event.healthStatus, 'healthStatus');
    const note = event.errorNote !== undefined ? String(event.errorNote) : health === 'healthy' ? null : undefined;
    this.stores.accounts.updateAccountFlags(account.id, { healthStatus: health, ...(note !== undefined ? { healthNote: note } : {}) });
    const errorCode = typeof event.errorCode === 'string' && ERROR_CODE.test(event.errorCode) ? event.errorCode : null;
    // The free-text note lives encrypted on the account; only the status + a code reach the journal.
    return { outcome: 'account_status_updated', ledger: { healthStatus: health, errorCode } };
  }

  /**
   * Provider read receipt, kept in NATIVE coordinates (never local IDs):
   *  - target held                      -> watermark = its native key / timestamp
   *  - not held, namespace is provider-monotonic (Telegram boxes) -> watermark = the native key
   *    alone (an unseen message is still ordered by its ID)
   *  - not held otherwise               -> durable pending receipt of THIS provider event, applied
   *    when the target lands; replaying the same eventId later is suppressed by the ledger and
   *    must not be needed.
   * The dashboard's local-seen marker is never touched.
   */
  private applyRead(account: CareAccountRecord, event: Extract<NormalizedEvent, { type: 'read.updated' }>): Effect {
    requireNonEmptyString(event.externalConversationKey, 'externalConversationKey', 1024);
    requireNonEmptyString(event.remoteReadMessageId, 'remoteReadMessageId', 512);
    const direction = event.direction ?? 'inbound';
    if (direction !== 'inbound' && direction !== 'outbound') {
      throw new CareError('INVALID_COMMAND', `Invalid read direction '${String(direction)}'`, 400);
    }
    if (event.nativeMessageNamespace !== undefined && !isValidMessageNamespace(account.channel, event.nativeMessageNamespace)) {
      throw new CareError(
        'INVALID_TARGET',
        `Message namespace '${event.nativeMessageNamespace}' is not valid for channel '${account.channel}'`,
        400,
      );
    }
    const ledger = { remoteReadMessageId: event.remoteReadMessageId, readDirection: direction };

    const conversation = this.stores.conversations.getConversationByExternalKey(account.id, event.externalConversationKey);

    let target = event.nativeMessageNamespace
      ? this.stores.messages.getMessageByNativeId(account.id, event.nativeMessageNamespace, event.remoteReadMessageId)
      : this.stores.messages.findUniqueByNativeId(account.id, event.remoteReadMessageId);
    // Without a namespace an ID shared by several messages cannot be resolved honestly.
    if (!target && !event.nativeMessageNamespace && this.stores.messages.countByNativeId(account.id, event.remoteReadMessageId) > 1) {
      return { outcome: 'read_unresolved', conversationId: conversation?.id, ledger };
    }

    if (target) {
      if (!conversation || target.conversationId !== conversation.id) {
        throw new CareError('INVALID_TARGET', 'Read receipt references a message of another conversation', 400);
      }
      this.stores.conversations.advanceRemoteWatermark(conversation.id, direction, this.watermarkOf(target));
      return { outcome: 'read_updated', conversationId: conversation.id, ledger: { ...ledger, messageId: target.id } };
    }

    const ns = event.nativeMessageNamespace;
    if (conversation && ns && hasMonotonicNativeIds(ns)) {
      const orderKey = deriveNativeOrderKey(ns, event.remoteReadMessageId);
      if (orderKey) {
        this.stores.conversations.advanceRemoteWatermark(conversation.id, direction, {
          namespace: ns,
          orderKey,
          sentAtMs: null,
          messageId: null,
        });
        return { outcome: 'read_updated', conversationId: conversation.id, ledger };
      }
    }

    this.stores.conversations.addPendingReceipt({
      accountId: account.id,
      eventId: event.eventId,
      externalConversationKey: event.externalConversationKey,
      namespace: ns ?? null,
      nativeMessageId: event.remoteReadMessageId,
      direction,
    });
    return { outcome: 'read_pending', conversationId: conversation?.id, ledger };
  }

  private applyDeliveryConfirmed(
    _account: CareAccountRecord,
    event: Extract<NormalizedEvent, { type: 'delivery.confirmed' }>,
  ): Effect {
    requireNonEmptyString(event.clientRequestId, 'clientRequestId', 256);
    requireNonEmptyString(event.nativeMessageId, 'nativeMessageId', 512);
    oneOf(['accepted', 'delivered', 'read'] as const, event.receiptLevel, 'receiptLevel');
    return {
      outcome: 'delivery_confirmed',
      ledger: {
        clientRequestId: event.clientRequestId,
        nativeMessageId: event.nativeMessageId,
        receiptLevel: event.receiptLevel,
      },
    };
  }
}
