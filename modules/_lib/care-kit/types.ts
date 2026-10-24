/**
 * Canonical Customer Care Domain Types
 * Pure frontend-safe data types: no Node Buffer, no provider SDK imports.
 * Millisecond timestamps, opaque string IDs.
 */

import type { CareCheckpoint } from './checkpoint.js';

export type { CareCheckpoint } from './checkpoint.js';

export type CareChannel = 'zalo' | 'telegram' | 'email';
export type CareOrigin = 'live' | 'history' | 'recovery';
export type CareSenderRole = 'customer' | 'self' | 'operator' | 'agent' | 'system';
export type CareMessageDirection = 'in' | 'out';
export type CareDeliveryStatus =
  | 'draft'
  | 'pending'
  | 'sending'
  | 'sent'
  | 'retry_wait'
  | 'uncertain'
  | 'needs_review'
  | 'failed'
  | 'cancelled'
  | 'discarded';
export type CareReceiptLevel = 'accepted' | 'delivered' | 'read';
export type CareActorType = 'manual' | 'approved' | 'auto';
export type CareIntentPurpose = 'care' | 'campaign';
export type CareConversationKind = 'direct' | 'group' | 'topic' | 'email_thread';
export type CareAccountDesiredState = 'active' | 'paused' | 'draining' | 'disconnected';
export type CareAccountHealth = 'healthy' | 'degraded' | 'error';
export type CareWriteOwner = 'legacy' | 'draining' | 'core';
export type CareStage = 'new' | 'consulting' | 'quoted' | 'deposit' | 'won' | 'lost';
export type CareJobStatus = 'pending' | 'claimed' | 'completed' | 'failed';
export type CareJobType = 'inbound_turn' | 'outbox_dispatch' | 'sync_poll' | 'cleanup';

export interface CareAttachmentDescriptor {
  id: string;
  mimeType: string;
  fileName: string;
  sizeBytes?: number;
  url?: string;
  thumbnailUrl?: string;
  isVoice?: boolean;
  expiresAtMs?: number;
}

export interface ChatMention {
  uid: string;
  offset?: number;
  length?: number;
  isAll?: boolean;
}

export interface ChatQuote {
  messageId: string;
  senderId?: string;
  text?: string;
}

export interface ChatMetadata {
  type: 'chat';
  conversationKind?: CareConversationKind;
  topicId?: string;
  quote?: ChatQuote | null;
  mentions?: ChatMention[] | null;
  stickerId?: string | null;
  entities?: unknown[];
  attachments?: CareAttachmentDescriptor[];
  /** Telegram: media present at the source but not exported (protected content / a type that cannot be downloaded). */
  unexportedMedia?: { kind: 'photo' | 'document'; mimeType: string; reason: 'restricted' | 'unsupported' };
  rawEnvelope?: Record<string, unknown>;
}

/**
 * Shared (timeline/participant) email envelope. BCC is deliberately NOT part of this type:
 * it is a private delivery envelope of the outbound account (see connectors/contract.ts) and
 * is stripped case-insensitively from headers/raw envelopes before anything is persisted.
 */
export interface EmailMetadata {
  type: 'email';
  subject: string;
  from: string;
  to: string[];
  cc?: string[];
  replyTo?: string;
  messageIdHeader?: string;
  inReplyToHeader?: string;
  referencesHeaders?: string[];
  isAutomated?: boolean;
  automatedReason?: string;
  category?: string;
  headers?: Record<string, string>;
  attachments?: CareAttachmentDescriptor[];
  /** Display name of the sender (the address lives in `from`). */
  fromName?: string;
  /** Raw HTML as received. Render only through the sandboxed sanitiser; never inject into model context. */
  bodyHtml?: string;
  /** Provider labels (Gmail label IDs). */
  labels?: string[];
  snippet?: string;
}

export type CareMessageMetadata = ChatMetadata | EmailMetadata;

export interface NormalizedMessage {
  accountId: string;
  externalConversationKey: string;
  nativeMessageNamespace: string;
  nativeMessageId: string;
  senderIdentityKey: string | null;
  senderRole: CareSenderRole;
  direction: CareMessageDirection;
  origin: CareOrigin;
  sentAtMs: number;
  nativeVersion: string | null;
  /**
   * Adapter-owned native order token (digits). Required for causal read coverage / reply
   * ordering in namespaces whose IDs are not provider-monotonic (Zalo, Gmail). Telegram message
   * boxes derive it from the native ID. Never derived from timestamps or local IDs.
   */
  nativeOrder?: string | null;
  text: string;
  metadata: CareMessageMetadata;
  isDeleted?: boolean;
}

export interface CareAccountRecord {
  id: string;
  channel: CareChannel;
  connectorKind: string;
  nativeAccountId: string;
  label: string;
  credentialRef: string | null;
  desiredState: CareAccountDesiredState;
  healthStatus: CareAccountHealth;
  /** Decrypted operator-facing health detail; never copied into the event journal. */
  healthNote: string | null;
  syncEnabled: boolean;
  sendEnabled: boolean;
  aiEnabled: boolean;
  writeOwner: CareWriteOwner;
  ownerEpoch: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CareCustomerRecord {
  id: string;
  displayName: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  stage: CareStage;
  tags: string | null;
  owner: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CareIdentityRecord {
  id: string;
  customerId: string;
  accountId: string;
  namespace: string;
  externalIdentityId: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  verified: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CareConversationRecord {
  id: string;
  accountId: string;
  externalKey: string;
  kind: CareConversationKind;
  title: string;
  primaryCustomerId: string | null;
  status: string;
  isPaused: boolean;
  pausedUntilMs: number | null;
  isOptedOut: boolean;
  waitingSinceMs: number | null;
  /** Provider-side unread estimate (live inbound after the remote read watermark). */
  remoteUnreadCount: number;
  /** Dashboard-only seen marker (local message ID). Never written by provider receipts. */
  localSeenMessageId: string | null;
  /** Local message ID up to which the remote account read inbound messages (null when the target is not held yet). */
  remoteReadMessageId: string | null;
  /** Local message ID of our latest outbound message the customer is known to have read. */
  remoteReceiptMessageId: string | null;
  lastMessageId: string | null;
  lastMessageAtMs: number;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CareMessageRecord {
  id: string;
  conversationId: string;
  accountId: string;
  nativeMessageNamespace: string;
  nativeMessageId: string;
  nativeVersion: string | null;
  direction: CareMessageDirection;
  senderIdentityId: string | null;
  senderRole: CareSenderRole;
  text: string;
  metadata: CareMessageMetadata;
  origin: CareOrigin;
  sentAtMs: number;
  /** Native order key (fixed-width digits) or null when the provider gives no order for this message. */
  nativeOrderKey: string | null;
  /** True once a genuine live observation of this message was ingested (provenance stays in `origin`). */
  liveObserved: boolean;
  /** Group/topic only: message explicitly targets this account (exact mention/quote). */
  directedAtAccount: boolean;
  isDeleted: boolean;
  deletedAtMs: number | null;
  tombstone: boolean;
  createdAtMs: number;
}

export interface CareJobRecord {
  id: string;
  accountId: string;
  jobType: CareJobType;
  conversationId: string | null;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  status: CareJobStatus;
  ownerEpoch: number;
  claimToken: string | null;
  leaseOwner: string | null;
  leaseExpiresAtMs: number | null;
  dueAtMs: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CareEventRecord {
  seq: number;
  eventId: string;
  accountId: string;
  conversationId: string | null;
  eventType: string;
  checkpoint: { namespace: string; cursor: string } | null;
  epoch: number;
  /** Scrubbed allowlisted scalars only; never message text, titles or error notes. */
  payload: Record<string, unknown>;
  createdAtMs: number;
}

export interface CareSourceJournalRecord {
  seq: number;
  accountId: string;
  sourceKind: string;
  sourceTable: string;
  sourceId: string;
  operation: 'insert' | 'update' | 'delete';
  sourceVersion: number;
  payloadEnc: string;
  appliedAtMs: number | null;
  createdAtMs: number;
}

// Normalized Event types emitted by connectors
/**
 * Envelope shared by every adapter event. `epoch` is the ownership epoch the emitting runtime
 * believes it holds; when omitted it is treated as epoch 1, so a stale/unfenced writer is
 * rejected as soon as the account epoch moves on (fail closed, never "current by default").
 */
export interface NormalizedEventBase {
  eventId: string;
  accountId: string;
  timestampMs: number;
  epoch?: number;
  /** Adapter-owned typed checkpoint advanced in the same transaction as the effects. */
  checkpoint?: CareCheckpoint;
}

/** Which side a provider read receipt describes. */
export type CareReadDirection = 'inbound' | 'outbound';

export type NormalizedEvent =
  | (NormalizedEventBase & {
      type: 'message.created';
      message: NormalizedMessage;
    })
  | (NormalizedEventBase & {
      type: 'message.edited';
      message: NormalizedMessage;
    })
  | (NormalizedEventBase & {
      type: 'message.deleted';
      nativeMessageNamespace: string;
      nativeMessageId: string;
      /**
       * Optional: Telegram common-box delete updates carry message IDs and no peer. Absent => the
       * peer is resolved from the held message, or the tombstone stays unbound until the message
       * (with its peer) shows up.
       */
      externalConversationKey?: string;
      nativeVersion: string | null;
    })
  | (NormalizedEventBase & {
      type: 'conversation.updated';
      externalConversationKey: string;
      title?: string;
      kind?: CareConversationKind;
    })
  | (NormalizedEventBase & {
      type: 'account.status';
      healthStatus: CareAccountHealth;
      /** Operator-facing detail: stored encrypted on the account, never in the event journal. */
      errorNote?: string;
      /** Short machine code (A-Z0-9_.:-) safe for the journal. */
      errorCode?: string;
    })
  | (NormalizedEventBase & {
      type: 'read.updated';
      externalConversationKey: string;
      /** Native ID of the last message covered by the provider receipt. */
      remoteReadMessageId: string;
      /** Message ID namespace of `remoteReadMessageId`; resolved uniquely by ID when omitted. */
      nativeMessageNamespace?: string;
      /**
       * `inbound` (default): the remote account read customer messages up to the watermark.
       * `outbound`: the customer read our messages up to the watermark.
       */
      direction?: CareReadDirection;
    })
  | (NormalizedEventBase & {
      type: 'delivery.confirmed';
      clientRequestId: string;
      nativeMessageId: string;
      receiptLevel: CareReceiptLevel;
    });

// Assignment and routing types
export type AssignmentScope =
  | 'conversation'
  | 'customer'
  | 'identity'
  | 'domain'
  | 'account'
  | 'channel'
  | 'global';
export type AssignmentMode = 'observe' | 'draft' | 'auto';

export interface CareAssignment {
  id: string;
  accountId: string | null; // Nullable for global and channel defaults
  scope: AssignmentScope;
  scopeTarget?: string | null;
  channel?: CareChannel | null;
  customerId?: string | null;
  priority: number;
  enabled: boolean;
  mode: AssignmentMode;
  agentId: string;
  instructionsRef?: string | null;
  configVersion: number;
  /**
   * Native policy extensions imported from a legacy source (primaryOnly, delays, human pause,
   * quotas, triggers, review keywords, instructions text...). Opaque to routing; the agent
   * policy (CC-10) reads it.
   */
  policyExt?: Record<string, unknown> | null;
}

// Cursors & pagination
export interface InboxCursor {
  lastActivityAtMs: number;
  conversationId: string;
}

export interface TimelineCursor {
  sentAtMs: number;
  messageId: string;
}

const CURSOR_MAX_ID_LENGTH = 512;
const CURSOR_MAX_ENCODED_LENGTH = 2048;
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]+$/;

/** Browser-safe UTF-8 -> base64url (no padding). No Node Buffer. */
function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strict base64url -> UTF-8. Throws on bad alphabet, padding, impossible length or invalid UTF-8. */
function fromBase64Url(str: string): string {
  if (!BASE64URL_ALPHABET.test(str) || str.length % 4 === 1) {
    throw new Error('not canonical base64url');
  }
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * Encodes a cursor as base64url(JSON([timestampMs, id])). The ID is carried in full (colons,
 * unicode, any opaque suffix survive); the timestamp must be a non-negative safe integer.
 */
export function encodeCursor(cursor: { timestampMs: number; id: string }): string {
  if (
    typeof cursor.timestampMs !== 'number' ||
    !Number.isSafeInteger(cursor.timestampMs) ||
    cursor.timestampMs < 0
  ) {
    throw new Error('Cursor timestampMs must be a non-negative safe integer');
  }
  if (typeof cursor.id !== 'string' || cursor.id.length === 0 || cursor.id.length > CURSOR_MAX_ID_LENGTH) {
    throw new Error('Cursor id must be a non-empty string within the length bound');
  }
  const encoded = toBase64Url(JSON.stringify([cursor.timestampMs, cursor.id]));
  // Same byte bound as the decoder: anything the encoder accepts must roundtrip.
  if (encoded.length > CURSOR_MAX_ENCODED_LENGTH) {
    throw new Error('Cursor is too large once encoded');
  }
  return encoded;
}

/**
 * Strict canonical decode. Returns null for anything that is not byte-for-byte what
 * `encodeCursor` would have produced (bad alphabet/padding, extra components, non-canonical
 * JSON such as whitespace or 1e3, fractional/negative timestamps, empty/oversized IDs).
 */
export function decodeCursor(encoded: string): { timestampMs: number; id: string } | null {
  if (!encoded || typeof encoded !== 'string' || encoded.length > CURSOR_MAX_ENCODED_LENGTH) return null;
  try {
    const raw = fromBase64Url(encoded);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [timestampMs, id] = parsed;
    if (typeof timestampMs !== 'number' || !Number.isSafeInteger(timestampMs) || timestampMs < 0) return null;
    if (typeof id !== 'string' || id.length === 0 || id.length > CURSOR_MAX_ID_LENGTH) return null;
    if (toBase64Url(JSON.stringify([timestampMs, id])) !== encoded) return null;
    return { timestampMs, id };
  } catch {
    return null;
  }
}

export function encodeInboxCursor(cursor: InboxCursor): string {
  return encodeCursor({ timestampMs: cursor.lastActivityAtMs, id: cursor.conversationId });
}

export function decodeInboxCursor(encoded: string): InboxCursor | null {
  const decoded = decodeCursor(encoded);
  return decoded ? { lastActivityAtMs: decoded.timestampMs, conversationId: decoded.id } : null;
}

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  return encodeCursor({ timestampMs: cursor.sentAtMs, id: cursor.messageId });
}

export function decodeTimelineCursor(encoded: string): TimelineCursor | null {
  const decoded = decodeCursor(encoded);
  return decoded ? { sentAtMs: decoded.timestampMs, messageId: decoded.id } : null;
}
