/**
 * Fake Care Connector for testing failure modes and capability enforcement.
 *
 * Models a provider honestly:
 *  - structural + channel-congruent command validation, strict owner-epoch equality;
 *  - capability enforcement (text/reply/bcc/replyAll/newMail) and a MANDATORY native retry
 *    token whenever the connector claims `sendDedupe`;
 *  - request ledger scoped to account + clientRequestId (and token), changed payload => 409,
 *    same request key on another account is independent;
 *  - `sendDedupe` really changes acceptance: with it an identical retry returns the first
 *    result without a second provider send; without it the provider sends a duplicate;
 *  - accepted-lost-ack / delayed-ack / terminal-rejection / epoch-loss behaviours;
 *  - reconcile with no provider evidence is `uncertain`, never a definite failure.
 */

import crypto from 'node:crypto';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareChannel, NormalizedEvent } from '../../../_lib/care-kit/types.js';
import {
  validateAuthCommand,
  validateDeliveryCommand,
  validateReconcileCommand,
  type AuthCommand,
  type AuthResult,
  type CareConnector,
  type ConnectorCapabilities,
  type DeliveryCommand,
  type DeliveryResult,
  type MediaCommand,
  type MediaResult,
  type ReadCommand,
  type ReadResult,
  type ReconcileCommand,
  type SyncCommand,
  type SyncResult,
} from '../../../_lib/care-kit/contract.js';

export type FakeConnectorBehavior =
  | 'normal'
  | 'accepted-lost-ack'
  | 'delayed-ack'
  | 'terminal-rejection'
  | 'epoch-loss';

interface RecordedDelivery {
  clientRequestId: string;
  /** Conversation / thread key the delivery was addressed to (null for brand-new mail). */
  conversationKey: string | null;
  nativeMessageId: string;
  adapterRetryToken: string | null;
  acceptedAtMs: number;
  payloadHash: string;
}

const DEFAULT_BOX: Record<CareChannel, 'zalo_chat' | 'telegram_common_box' | 'gmail_mailbox'> = {
  zalo: 'zalo_chat',
  telegram: 'telegram_common_box',
  email: 'gmail_mailbox',
};

export class FakeCareConnector implements CareConnector {
  public readonly kind: string;
  public readonly channel: CareChannel;
  /** The fake is polled by the care worker (tests drive sync through the runtime tick). */
  public readonly careManagedSync = true;
  public currentCapabilities: ConnectorCapabilities;
  public behavior: FakeConnectorBehavior = 'normal';
  public activeEpoch = 1;
  public delayMs = 0;

  /** Commands that reached the provider (passed every local guard). */
  public readonly dispatchedCommands: DeliveryCommand[] = [];
  /** Number of real provider sends (a non-dedupe retry increments it again). */
  public providerSendCount = 0;
  public readonly reconciledCommands: ReconcileCommand[] = [];
  public readonly readCommands: ReadCommand[] = [];
  public queuedEvents: NormalizedEvent[] = [];

  /** Request ledger, keyed by an unambiguous tuple encoding of (accountId, clientRequestId). */
  public readonly knownDeliveries = new Map<string, RecordedDelivery>();
  /** Token ledger keyed by tuple (accountId, token) => owning clientRequestId. */
  private readonly tokenOwners = new Map<string, string>();
  private readonly delayedResolvers = new Map<string, { accountId: string; clientRequestId: string; release: () => void }>();
  private syncSeq = 0;

  constructor(kind = 'fake-connector', channel: CareChannel = 'zalo', capabilities?: Partial<ConnectorCapabilities>) {
    this.kind = kind;
    this.channel = channel;
    this.currentCapabilities = {
      text: true,
      reply: true,
      replyAll: false,
      edit: true,
      delete: true,
      reaction: false,
      typing: false,
      remoteRead: true,
      backfill: true,
      sendDedupe: true,
      mediaKinds: ['image/jpeg', 'image/png'],
      bcc: false,
      newMail: false,
      ...capabilities,
    };
  }

  async capabilities(_accountId: string, _conversationKey?: string): Promise<ConnectorCapabilities> {
    return { ...this.currentCapabilities, mediaKinds: [...this.currentCapabilities.mediaKinds] };
  }

  setCapabilities(patch: Partial<ConnectorCapabilities>): void {
    this.currentCapabilities = { ...this.currentCapabilities, ...patch };
  }

  setBehavior(behavior: FakeConnectorBehavior): void {
    this.behavior = behavior;
  }

  /**
   * Collision-free tuple key. Opaque IDs may contain ':' (or anything), so ("a:b","c") and
   * ("a","b:c") must never share a key; JSON array encoding is injective.
   */
  private scopeKey(accountId: string, clientRequestId: string): string {
    return JSON.stringify([accountId, clientRequestId]);
  }

  private tokenKey(accountId: string, token: string): string {
    return JSON.stringify([accountId, token]);
  }

  /** The recorded provider delivery for (account, request), if any. */
  getDelivery(accountId: string, clientRequestId: string): RecordedDelivery | undefined {
    return this.knownDeliveries.get(this.scopeKey(accountId, clientRequestId));
  }

  private conversationKeyOf(command: DeliveryCommand): string | null {
    return command.kind === 'chat' ? command.target.externalConversationKey : (command.target.externalConversationKey ?? null);
  }

  /** Hash of everything immutable about the request, including the retry token. */
  private hashPayload(command: DeliveryCommand): string {
    const common = { kind: command.kind, channel: command.channel, text: command.text, token: command.adapterRetryToken ?? '' };
    const norm =
      command.kind === 'chat'
        ? {
            ...common,
            conversation: command.target.externalConversationKey,
            replyTo: command.target.replyToMessageId ?? '',
            topic: command.target.topicId ?? '',
          }
        : {
            ...common,
            conversation: command.target.externalConversationKey ?? '',
            replyTo: command.target.replyToMessageId ?? '',
            inReplyTo: command.target.inReplyToHeader ?? '',
            subject: command.target.subject,
            to: [...command.target.to].map((a) => a.toLowerCase()).sort(),
            cc: [...(command.target.cc ?? [])].map((a) => a.toLowerCase()).sort(),
            bcc: [...(command.bcc ?? [])].map((a) => a.toLowerCase()).sort(),
          };
    return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
  }

  async connect(command: AuthCommand): Promise<AuthResult> {
    const valid = validateAuthCommand(command);
    if (valid.channel !== this.channel) {
      throw new CareError('INVALID_TARGET', `Auth for '${valid.channel}' sent to a '${this.channel}' connector`, 400);
    }
    return {
      ok: true,
      accountId: valid.accountId,
      nativeAccountId: `native_${valid.accountId}`,
      label: `Fake Account ${valid.accountId} (${valid.channel})`,
    };
  }

  async sync(command: SyncCommand): Promise<SyncResult> {
    const limit = command.limit ?? 50;
    const eventsToReturn = this.queuedEvents.slice(0, limit);
    this.queuedEvents = this.queuedEvents.slice(limit);
    this.syncSeq += 1;
    const namespace = command.checkpoint?.namespace ?? DEFAULT_BOX[this.channel];
    return {
      events: eventsToReturn,
      nextCheckpoint: {
        namespace,
        cursor: `cursor_${this.syncSeq}`,
        position: String(this.syncSeq),
        expectedCursor: command.checkpoint?.cursor ?? null,
      },
      hasMore: this.queuedEvents.length > 0,
    };
  }

  private requireCapabilities(command: DeliveryCommand): void {
    const caps = this.currentCapabilities;
    if (!caps.text) {
      throw new CareError('UNSUPPORTED_CAPABILITY', 'Text messaging is disabled or unsupported for this connector');
    }
    if (command.target.replyToMessageId && !caps.reply) {
      throw new CareError('UNSUPPORTED_CAPABILITY', 'Thread reply is not supported for this connector');
    }
    if (command.kind === 'email') {
      if (command.bcc && command.bcc.length > 0 && !caps.bcc) {
        throw new CareError('UNSUPPORTED_CAPABILITY', 'BCC is not supported for this connector');
      }
      if (command.target.to.length + (command.target.cc?.length ?? 0) > 1 && !caps.replyAll) {
        throw new CareError('UNSUPPORTED_CAPABILITY', 'Multi-recipient delivery requires replyAll capability');
      }
      if (!command.target.externalConversationKey && !caps.newMail) {
        throw new CareError('UNSUPPORTED_CAPABILITY', 'New mail (no existing thread) is not supported for this connector');
      }
    }
  }

  async dispatch(command: DeliveryCommand): Promise<DeliveryResult> {
    // 1. Structural + channel-congruent validation, before any provider contact.
    validateDeliveryCommand(command);
    if (command.channel !== this.channel) {
      throw new CareError('INVALID_TARGET', `Delivery for '${command.channel}' sent to a '${this.channel}' connector`, 400);
    }

    // 2. Strict epoch equality (stale AND desynced-future writers are both fenced).
    if (this.behavior === 'epoch-loss' || command.ownerEpoch !== this.activeEpoch) {
      throw new CareError(
        'FENCING_REJECTED',
        `Owner epoch mismatch: connector active epoch is ${this.activeEpoch}, command has ${command.ownerEpoch}`,
        409,
      );
    }

    // 3. Capabilities, and the mandatory stable retry token for dedupe-capable connectors.
    this.requireCapabilities(command);
    if (this.currentCapabilities.sendDedupe && !command.adapterRetryToken) {
      throw new CareError(
        'INVALID_COMMAND',
        'adapterRetryToken is mandatory when the connector claims sendDedupe (persist it before the first attempt)',
        400,
      );
    }

    // 4. Request + token ledger.
    const scopeKey = this.scopeKey(command.accountId, command.clientRequestId);
    const payloadHash = this.hashPayload(command);
    const existing = this.knownDeliveries.get(scopeKey);

    if (command.adapterRetryToken) {
      const owner = this.tokenOwners.get(this.tokenKey(command.accountId, command.adapterRetryToken));
      if (owner !== undefined && owner !== command.clientRequestId) {
        throw new CareError(
          'DUPLICATE_REQUEST_PAYLOAD_MISMATCH',
          'adapterRetryToken is already bound to a different request',
          409,
        );
      }
    }

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new CareError(
          'DUPLICATE_REQUEST_PAYLOAD_MISMATCH',
          `clientRequestId '${command.clientRequestId}' was previously sent with a different payload`,
          409,
        );
      }
      if (this.currentCapabilities.sendDedupe) {
        return {
          outcome: 'accepted',
          nativeMessageId: existing.nativeMessageId,
          adapterRetryToken: existing.adapterRetryToken ?? undefined,
          remoteTimestampMs: existing.acceptedAtMs,
          receiptLevel: 'accepted',
        };
      }
      // No dedupe capability: the provider honestly sends a second message below.
    }

    // 5. Terminal rejection simulation (provider saw it and refused permanently).
    if (this.behavior === 'terminal-rejection') {
      this.dispatchedCommands.push(command);
      throw new CareError('TERMINAL_REJECTION', 'Provider permanently rejected delivery', 400);
    }

    const nativeMessageId = `remote_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const recorded: RecordedDelivery = {
      clientRequestId: command.clientRequestId,
      conversationKey: this.conversationKeyOf(command),
      nativeMessageId,
      adapterRetryToken: command.adapterRetryToken ?? null,
      acceptedAtMs: Date.now(),
      payloadHash,
    };
    this.knownDeliveries.set(scopeKey, recorded);
    if (command.adapterRetryToken) {
      this.tokenOwners.set(this.tokenKey(command.accountId, command.adapterRetryToken), command.clientRequestId);
    }
    this.dispatchedCommands.push(command);
    this.providerSendCount += 1;

    const accepted = (): DeliveryResult => ({
      outcome: 'accepted',
      nativeMessageId,
      adapterRetryToken: recorded.adapterRetryToken ?? undefined,
      remoteTimestampMs: recorded.acceptedAtMs,
      receiptLevel: 'accepted',
    });

    // 6. Accepted but the acknowledgement never reached us.
    if (this.behavior === 'accepted-lost-ack') {
      throw new CareError('NETWORK_TIMEOUT', 'Provider accepted delivery, but network ack was lost', 504);
    }

    // 7. Delayed acknowledgement.
    if (this.behavior === 'delayed-ack') {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        return accepted();
      }
      return new Promise<DeliveryResult>((resolve) => {
        this.delayedResolvers.set(scopeKey, {
          accountId: command.accountId,
          clientRequestId: command.clientRequestId,
          release: () => resolve(accepted()),
        });
      });
    }

    return accepted();
  }

  /** Releases a held ack for exactly the (account, request) it belongs to. */
  releaseDelayedAck(clientRequestId: string, accountId?: string): void {
    for (const [scopeKey, held] of this.delayedResolvers) {
      if (held.clientRequestId === clientRequestId && (accountId === undefined || held.accountId === accountId)) {
        this.delayedResolvers.delete(scopeKey);
        held.release();
        return;
      }
    }
  }

  async reconcile(command: ReconcileCommand): Promise<DeliveryResult> {
    validateReconcileCommand(command);
    this.reconciledCommands.push(command);
    const recorded = this.knownDeliveries.get(this.scopeKey(command.accountId, command.clientRequestId));

    if (recorded) {
      // The caller may only confirm the delivery it actually refers to: any reference it supplies
      // (token, native ID, conversation) must match the recorded one.
      const mismatch =
        (command.adapterRetryToken !== undefined && command.adapterRetryToken !== recorded.adapterRetryToken) ||
        (command.nativeMessageId !== undefined && command.nativeMessageId !== recorded.nativeMessageId) ||
        (command.externalConversationKey !== undefined && command.externalConversationKey !== recorded.conversationKey);
      if (mismatch) {
        return { outcome: 'uncertain', error: 'Reconcile reference does not match the recorded delivery; not confirming it' };
      }
      return {
        outcome: 'accepted',
        nativeMessageId: recorded.nativeMessageId,
        adapterRetryToken: recorded.adapterRetryToken ?? undefined,
        remoteTimestampMs: recorded.acceptedAtMs,
        receiptLevel: 'accepted',
      };
    }

    // No provider evidence is NOT proof of non-delivery. (A token owned by a DIFFERENT request is
    // that other request's delivery and must never be reported as this one's.)
    return {
      outcome: 'uncertain',
      error: 'No provider evidence found; delivery state remains uncertain and requires reconciliation',
    };
  }

  async markRead(command: ReadCommand): Promise<ReadResult> {
    if (!this.currentCapabilities.remoteRead) {
      throw new CareError('UNSUPPORTED_CAPABILITY', 'Remote read receipt is unsupported');
    }
    this.readCommands.push(command);
    return { ok: true };
  }

  async fetchAttachment(command: MediaCommand): Promise<MediaResult> {
    return {
      buffer: Buffer.from(`dummy_attachment_${command.attachmentId}`),
      mimeType: 'image/png',
      fileName: `attachment_${command.attachmentId}.png`,
    };
  }

  enqueueEvent(event: NormalizedEvent): void {
    this.queuedEvents.push(event);
  }

  enqueueDuplicateEvents(event: NormalizedEvent, count = 2): void {
    for (let i = 0; i < count; i++) {
      this.queuedEvents.push({ ...event });
    }
  }

  enqueueOutOfOrderEvents(events: NormalizedEvent[]): void {
    this.queuedEvents.push(...[...events].reverse());
  }
}
