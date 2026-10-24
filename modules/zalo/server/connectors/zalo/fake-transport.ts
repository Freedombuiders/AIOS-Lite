/**
 * Deterministic fake Zalo "world" behind the `ZaloTransport` port. Synthetic only: no zca-js, no
 * network, no session. It models Zalo honestly where it matters for the connector:
 *  - the provider records a message the moment it "accepts" it, whether or not the ack comes back;
 *  - with `selfListen` Zalo echoes every own send through the live feed (same msgId as the ack);
 *  - a lost ack, flood control, an expired session and a permanent rejection are separate failures;
 *  - the live feed is a buffer that is peeked and acknowledged, and it can lose items (history gap).
 */

import {
  ZaloTransportError,
  type ZaloAuthStart,
  type ZaloFeatures,
  type ZaloLiveItem,
  type ZaloLivePage,
  type ZaloRateStatus,
  type ZaloRawMessage,
  type ZaloRawUndo,
  type ZaloSeenTarget,
  type ZaloSendAck,
  type ZaloSendRequest,
  type ZaloThreadKind,
  type ZaloTransport,
} from './transport.js';

export type FakeSendBehavior = 'normal' | 'lost-ack' | 'ack-without-id' | 'reject' | 'flood' | 'session-expired';

export interface FakeDelivered {
  msgId: string;
  threadId: string;
  threadKind: ZaloThreadKind;
  text: string;
  tsMs: number;
  replyToMessageId?: string;
}

/** What the real legacy code can do today (see zca-transport.ts): no quoting, no seen marker. */
export function legacyLikeFeatures(): ZaloFeatures {
  return {
    text: true,
    quote: false,
    typing: true,
    markRead: false,
    sendMedia: [],
    fetchMedia: true,
    history: { group: true, directPush: true },
  };
}

export class FakeZaloTransport implements ZaloTransport {
  public ownUidValue: string | null = 'own-uid-1';
  public connected = true;
  public behavior: FakeSendBehavior = 'normal';
  public floodRetryMs = 45_000;
  public rate: ZaloRateStatus = { ok: true };
  public featureSet: ZaloFeatures = {
    text: true,
    quote: true,
    typing: true,
    markRead: true,
    sendMedia: [],
    fetchMedia: true,
    history: { group: true, directPush: true },
  };
  /** selfListen: Zalo echoes own sends through the live feed. */
  /** Lifecycle hook a test may set; the connector's close() calls it. */
  public close?: () => void | Promise<void>;
  /** selfListen echo switch below. */
  public echoOwnSends = true;
  public now = 1_700_000_000_000;

  /** Every send() call that reached the transport (before the provider decided anything). */
  public readonly sendCalls: ZaloSendRequest[] = [];
  /** What the provider accepted (the ground truth for "was it delivered"). */
  public readonly delivered: FakeDelivered[] = [];
  public readonly readMarks: Array<{ threadId: string; nativeMessageId: string; seen?: ZaloSeenTarget }> = [];
  public readonly directHistoryRequests: Array<string | null> = [];
  public readonly groupHistoryReads: Array<{ groupId: string; count: number }> = [];
  public readonly titleLookups: string[] = [];
  public readonly qrStarts: string[] = [];
  public titles = new Map<string, string>();
  public media = new Map<string, { buffer: Buffer; mimeType: string }>();

  private feedSeq = 0;
  private feedIdValue = 'feed-1';
  private feedCounter = 1;
  private items: ZaloLiveItem[] = [];
  private gapFlag = false;
  private msgCounter = 0n;
  private groupHistory = new Map<string, ZaloRawMessage[]>();

  /** Next provider message id; beyond Number.MAX_SAFE_INTEGER on purpose (ids must stay strings). */
  nextMsgId(): string {
    this.msgCounter += 1n;
    return (7_400_000_000_000_000_000n + this.msgCounter).toString();
  }

  ownUid(): string | null {
    return this.ownUidValue;
  }
  isConnected(): boolean {
    return this.connected;
  }
  features(): ZaloFeatures {
    return { ...this.featureSet, sendMedia: [...this.featureSet.sendMedia], history: { ...this.featureSet.history } };
  }
  rateStatus(): ZaloRateStatus {
    return { ...this.rate };
  }

  async send(_accountId: string, request: ZaloSendRequest): Promise<ZaloSendAck> {
    this.sendCalls.push(request);
    if (!this.connected) throw new ZaloTransportError('not_connected', 'Nick Zalo chưa kết nối');
    switch (this.behavior) {
      case 'session-expired':
        throw new ZaloTransportError('session_expired', 'session expired');
      case 'flood':
        throw new ZaloTransportError('rate_limited', 'flood control', this.floodRetryMs);
      case 'reject':
        throw new ZaloTransportError('rejected', 'Zalo refused the message [zalo:114]');
      default:
        break;
    }
    const msgId = this.nextMsgId();
    this.now += 1;
    const record: FakeDelivered = {
      msgId,
      threadId: request.threadId,
      threadKind: request.threadKind,
      text: request.text,
      tsMs: this.now,
      ...(request.replyToMessageId ? { replyToMessageId: request.replyToMessageId } : {}),
    };
    this.delivered.push(record);
    if (this.echoOwnSends) this.pushLive(this.echoOf(record));
    if (this.behavior === 'lost-ack') throw new ZaloTransportError('timeout', 'ack lost');
    if (this.behavior === 'ack-without-id') return { tsMs: record.tsMs };
    return { msgId, tsMs: record.tsMs };
  }

  private echoOf(d: FakeDelivered): ZaloRawMessage {
    return {
      threadKind: d.threadKind,
      threadId: d.threadId,
      isSelf: true,
      data: {
        msgId: d.msgId,
        cliMsgId: `cli-${d.msgId.slice(-6)}`,
        uidFrom: this.ownUidValue ?? '',
        idTo: d.threadId,
        ts: String(d.tsMs),
        msgType: 'webchat',
        content: d.text,
      },
    };
  }

  // ── live feed ────────────────────────────────────────────────────────────────────────────
  pushLive(message: ZaloRawMessage, origin: 'live' | 'history' = 'live'): void {
    this.items.push({ seq: ++this.feedSeq, kind: 'message', origin, message });
  }
  pushUndo(undo: ZaloRawUndo): void {
    this.items.push({ seq: ++this.feedSeq, kind: 'undo', undo });
  }
  /** The websocket dropped something: the feed says so, and the item never arrives. */
  markGap(): void {
    this.gapFlag = true;
  }
  clearGap(): void {
    this.gapFlag = false;
  }
  /** Process restart: a new feed, unacknowledged items are gone, sequence numbers restart. */
  restartFeed(): void {
    this.feedCounter += 1;
    this.feedIdValue = `feed-${this.feedCounter}`;
    this.feedSeq = 0;
    this.items = [];
    this.gapFlag = true;
  }

  peekLive(_accountId: string, limit: number): ZaloLivePage {
    const items = this.items.slice(0, limit);
    // The gap signal is reported once, to exactly one sync result (like a real feed's report-once flag).
    const gap = this.gapFlag;
    this.gapFlag = false;
    return { feedId: this.feedIdValue, items, hasMore: this.items.length > items.length, gap };
  }
  ackLive(_accountId: string, feedId: string, upToSeq: number): void {
    if (feedId !== this.feedIdValue) return;
    this.items = this.items.filter((i) => i.seq > upToSeq);
  }
  pendingLive(): number {
    return this.items.length;
  }

  // ── history ──────────────────────────────────────────────────────────────────────────────
  setGroupHistory(groupId: string, messages: ZaloRawMessage[]): void {
    this.groupHistory.set(groupId, messages);
  }
  async readGroupHistory(_accountId: string, groupId: string, count: number): Promise<ZaloRawMessage[]> {
    this.groupHistoryReads.push({ groupId, count });
    if (!this.rate.ok && this.rate.reason !== 'quiet_hours') {
      throw new ZaloTransportError('rate_limited', 'group_read budget exhausted', this.rate.retryAfterMs);
    }
    return (this.groupHistory.get(groupId) ?? []).slice(-count);
  }
  requestDirectHistory(_accountId: string, cursor: string | null): void {
    this.directHistoryRequests.push(cursor);
  }

  async resolveTitle(_accountId: string, threadId: string): Promise<string | null> {
    this.titleLookups.push(threadId);
    return this.titles.get(threadId) ?? null;
  }

  async markRead(_accountId: string, threadId: string, nativeMessageId: string, seen?: ZaloSeenTarget): Promise<void> {
    this.readMarks.push({ threadId, nativeMessageId, ...(seen ? { seen } : {}) });
  }

  async fetchMedia(_accountId: string, url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const hit = this.media.get(url);
    if (!hit) throw new ZaloTransportError('unknown', 'media not found');
    return hit;
  }

  async startQrLogin(accountId: string): Promise<ZaloAuthStart> {
    this.qrStarts.push(accountId);
    return this.connected
      ? { step: 'authorized', nativeAccountId: this.ownUidValue ?? undefined, label: 'Fake Zalo' }
      : { step: 'qr_pending', qr: 'data:image/png;base64,FAKEQR' };
  }
}
