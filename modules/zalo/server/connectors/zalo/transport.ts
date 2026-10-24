/**
 * Port between the Care Zalo connector and "something that talks to Zalo".
 *
 * The connector (zalo-connector.ts) owns Care semantics: identity of conversations/messages,
 * normalisation, the attempt ledger, error classification, cooldown, honest capabilities. It never
 * touches zca-js, the legacy `zalo_*` tables or the network; everything provider-shaped goes through
 * this port. `zca-transport.ts` is the thin adapter over the real src/zalo code; `fake-transport.ts`
 * is the deterministic one used by tests.
 *
 * The port is deliberately small and READ-ONLY with respect to Care and the legacy tables: a
 * transport sends, reads and listens, it does not persist customer data anywhere.
 */

export type ZaloThreadKind = 'user' | 'group';

/** The in-process fake and the daemon-side adapter answer synchronously; the daemon client over HTTP does not. */
export type MaybePromise<T> = T | Promise<T>;

/** Message payload as zca-js delivers it (listener / history), narrowed to what Care reads. */
export interface ZaloRawData {
  msgId?: string | number;
  cliMsgId?: string | number;
  uidFrom?: string;
  idTo?: string;
  dName?: string;
  /** Milliseconds since epoch, as a string or a number (Zalo's own clock). */
  ts?: string | number;
  msgType?: string;
  content?: unknown;
  /** Wire fields the quoted-reply and seen-marker payloads of zca-js need (kept in the message envelope at ingest). */
  ttl?: number | string;
  st?: number | string;
  at?: number | string;
  cmd?: number | string;
  quote?: { ownerId?: string | number; msg?: string; fromD?: string; globalMsgId?: string | number; cliMsgId?: string | number };
  mentions?: Array<{ uid?: string | number; pos?: number; len?: number; type?: number }>;
  propertyExt?: unknown;
}

export interface ZaloRawMessage {
  threadKind: ZaloThreadKind;
  /** Peer uid (DM) or group id. */
  threadId: string;
  isSelf: boolean;
  data: ZaloRawData;
}

/** A recall ("thu hồi") packet: the recalled message is referenced from `content`, not by `msgId`. */
export interface ZaloRawUndo {
  threadId?: string;
  data: { content?: { globalMsgId?: string | number; cliMsgId?: string | number }; ts?: string | number };
}

/** One entry of the live feed. `seq` is monotonic per feed and is what `ackLive` acknowledges. */
export type ZaloLiveItem =
  | { seq: number; kind: 'message'; origin: 'live' | 'history'; message: ZaloRawMessage }
  | { seq: number; kind: 'undo'; undo: ZaloRawUndo };

export interface ZaloLivePage {
  /** Identifies this feed instance; a new one after a process restart (sequence numbers restart). */
  feedId: string;
  items: ZaloLiveItem[];
  /** More unacknowledged items exist beyond this page. */
  hasMore: boolean;
  /** The feed lost items (buffer overflow / websocket drop): history must be re-read to close the gap. */
  gap: boolean;
}

export interface ZaloFeatures {
  /** The nick can send text right now (not send-locked, chat not disabled). */
  text: boolean;
  /** Quoted replies. The legacy sender never builds the quote payload, so the real adapter says false. */
  quote: boolean;
  typing: boolean;
  /** Seen/read marker towards the customer. */
  markRead: boolean;
  /** MIME kinds the transport can SEND as attachments (DeliveryCommand has no attachment field yet). */
  sendMedia: string[];
  /** Fetching media bytes by URL. */
  fetchMedia: boolean;
  history: {
    /** REST-style group history (getGroupChatHistory). */
    group: boolean;
    /** 1-1 history is pushed by the server after a request; items arrive through the live feed. */
    directPush: boolean;
  };
}

/**
 * Everything zca-js's `SendMessageQuote` needs about the quoted message. Built ONLY from the wire data stored with the
 * canonical message at ingest (`rawEnvelope.wire`); a message without it (bridged legacy history, older rows) has no
 * quote target and a quoted reply to it goes to review instead of being sent unquoted. Text messages only.
 */
export interface ZaloQuoteTarget {
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  ts: string;
  ttl: number;
  msgType: string;
  /** The quoted message's text (content is a plain string for a text message). */
  content: string;
  propertyExt?: unknown;
}

/** zca-js `SendSeenEventMessageParams` for one customer message, from the same stored wire data. */
export interface ZaloSeenTarget {
  threadKind: ZaloThreadKind;
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  idTo: string;
  msgType: string;
  st: number;
  at: number;
  cmd: number;
  ts: string;
}

export interface ZaloSendRequest {
  threadId: string;
  threadKind: ZaloThreadKind;
  text: string;
  /** Native id of the message to quote; only set when `features().quote`. */
  replyToMessageId?: string;
  /** Wire data of the quoted message, when the connector could build it from the canonical message. */
  quote?: ZaloQuoteTarget;
  /**
   * Care's identity of this delivery, used by a remote transport (the Zalo daemon) to re-check ownership
   * and to keep its own once-only ledger. Never part of the message sent to Zalo.
   */
  requestId?: string;
  attemptToken?: string;
  ownerEpoch?: number;
  actor?: 'manual' | 'approved' | 'auto';
}

/** What a remote transport remembers about a request it was asked to send (hard evidence for reconcile). */
export interface ZaloSendLookup {
  state: 'started' | 'accepted' | 'failed_definite' | 'uncertain';
  msgId?: string;
  tsMs?: number;
}

export interface ZaloSendAck {
  /** Zalo's message id when the response carried one (`message.msgId`). Absent => cannot prove the message. */
  msgId?: string;
  /** Provider timestamp in ms when known. */
  tsMs?: number;
}

export interface ZaloRateStatus {
  ok: boolean;
  reason?: 'daily' | 'burst' | 'quiet_hours' | 'locked';
  /** How long until a retry can make sense. */
  retryAfterMs?: number;
}

export type ZaloTransportErrorKind =
  /** Not connected / no live session for the nick. Nothing was sent. */
  | 'not_connected'
  /** Zalo refused the session (cookie expired). Nothing was sent; needs a re-login. */
  | 'session_expired'
  /** The nick is send-locked or chat is disabled by the operator. Nothing was sent. */
  | 'send_locked'
  /** The remote side refused because Care ownership/epoch no longer allows this sender. Nothing was sent. */
  | 'fenced'
  /** A remote ledger holds an unresolved earlier attempt of this request; it was NOT sent again. */
  | 'unresolved'
  /** Our limiter or Zalo flood control. Nothing was sent; carries `retryAfterMs`. */
  | 'rate_limited'
  /** Zalo permanently refused this message (`[zalo:code]`, not in group...). */
  | 'rejected'
  /** The request may have left the process: connection reset, timeout, unknown failure. */
  | 'network'
  | 'timeout'
  | 'unknown';

/** Kinds that guarantee the request never reached Zalo. Everything else is uncertain. */
export const DEFINITE_NOT_SENT: ReadonlySet<ZaloTransportErrorKind> = new Set([
  'not_connected',
  'session_expired',
  'send_locked',
  'fenced',
  'rate_limited',
  'rejected',
]);

export class ZaloTransportError extends Error {
  constructor(
    readonly kind: ZaloTransportErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ZaloTransportError';
  }
}

export interface ZaloAuthStart {
  step: 'qr_pending' | 'authorized' | 'failed' | 'unsupported';
  /** Data-URL / opaque QR payload for the UI; never logged. */
  qr?: string;
  nativeAccountId?: string;
  label?: string;
  error?: string;
}

export interface ZaloTransport {
  /** The nick's own Zalo uid, or null while not logged in. */
  ownUid(accountId: string): MaybePromise<string | null>;
  isConnected(accountId: string): MaybePromise<boolean>;
  features(accountId: string): MaybePromise<ZaloFeatures>;

  /** Read-only preflight against the nick budgets (daily message cap, burst window, quiet hours). */
  rateStatus(accountId: string): MaybePromise<ZaloRateStatus>;
  /**
   * Sends one text message. MUST count the send against the nick budgets, and MUST NOT retry on its own
   * after the request may have left the process (a transient retry is the connector's/outbox's call).
   */
  send(accountId: string, request: ZaloSendRequest): Promise<ZaloSendAck>;

  /** Live feed: peek does not consume; `ackLive` drops everything up to `seq` (called after durable ingest). */
  peekLive(accountId: string, limit: number): MaybePromise<ZaloLivePage>;
  ackLive(accountId: string, feedId: string, upToSeq: number): MaybePromise<void>;

  /** Recent messages of a group (REST history). Throws `rate_limited` when the read budget is gone. */
  readGroupHistory(accountId: string, groupId: string, count: number): Promise<ZaloRawMessage[]>;
  /** Asks the server to push older 1-1 messages (they arrive through the live feed with origin 'history'). */
  requestDirectHistory(accountId: string, cursor: string | null): MaybePromise<void>;

  /** Best-effort display names, budgeted by the adapter; null when unknown or over budget. */
  resolveTitle(accountId: string, threadId: string, kind: ZaloThreadKind): Promise<string | null>;

  markRead(accountId: string, threadId: string, nativeMessageId: string, seen?: ZaloSeenTarget): Promise<void>;
  fetchMedia(accountId: string, url: string): Promise<{ buffer: Buffer; mimeType: string }>;

  startQrLogin(accountId: string): Promise<ZaloAuthStart>;

  /** Optional: what the sending side remembers about a request (a remote transport with its own ledger). */
  lookupSend?(accountId: string, requestId: string): Promise<ZaloSendLookup | null>;

  /** Optional: stop listening and drop in-memory state (process shutdown). Persisted/remote state is untouched. */
  close?(): MaybePromise<void>;
}
