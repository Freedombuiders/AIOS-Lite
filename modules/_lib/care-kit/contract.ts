/**
 * Customer Care Connector Contract
 * Discriminated unions per channel family (chat vs email); commands are validated at the
 * boundary (`validateAuthCommand`, `validateDeliveryCommand`) so channel-incongruent targets,
 * smuggled BCC on chat, or a missing native retry token never reach a provider.
 */

import { CareError } from './errors.js';
import type { CareCheckpoint } from './checkpoint.js';
import type {
  CareActorType,
  CareChannel,
  CareIntentPurpose,
  CareReceiptLevel,
  NormalizedEvent,
} from './types.js';
import { oneOf, requireNonEmptyString, requireSafeInteger } from './validation.js';

const ACTORS: readonly CareActorType[] = ['manual', 'approved', 'auto'];
const PURPOSES: readonly CareIntentPurpose[] = ['care', 'campaign'];
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface ConnectorCapabilities {
  text: boolean;
  reply: boolean;
  replyAll: boolean;
  edit: boolean;
  delete: boolean;
  reaction: boolean;
  typing: boolean;
  remoteRead: boolean;
  backfill: boolean;
  /** Provider honours a stable native retry token (Telegram random_id, idempotency key). */
  sendDedupe: boolean;
  mediaKinds: string[];
  bcc: boolean;
  newMail: boolean;
}

// ── Auth: one discriminated union per channel, then per step ──────────────────────────────
export type ZaloAuthCommand =
  | { channel: 'zalo'; method: 'qr_start'; accountId: string }
  | { channel: 'zalo'; method: 'session_restore'; accountId: string; sessionJson: string };

export type TelegramAuthCommand =
  /** QR login: typed now so the union is complete; the runtime that executes it is CC-16. */
  | { channel: 'telegram'; method: 'qr_start'; accountId: string }
  | { channel: 'telegram'; method: 'qr_poll'; accountId: string; loginToken: string }
  | { channel: 'telegram'; method: 'phone_start'; accountId: string; phoneNumber: string }
  | { channel: 'telegram'; method: 'phone_code'; accountId: string; phoneCodeHash: string; phoneCode: string }
  | { channel: 'telegram'; method: 'password_2fa'; accountId: string; password: string }
  | { channel: 'telegram'; method: 'session_restore'; accountId: string; sessionString: string };

export type EmailAuthCommand = {
  channel: 'email';
  method: 'composio_connection';
  accountId: string;
  composioConnectionId: string;
  accountAddress: string;
};

export type AuthCommand = ZaloAuthCommand | TelegramAuthCommand | EmailAuthCommand;

export interface AuthResult {
  ok: boolean;
  accountId: string;
  nativeAccountId?: string;
  label?: string;
  error?: string;
}

const EMAIL_ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function validateAuthCommand(cmd: AuthCommand): AuthCommand {
  const bad = (msg: string): never => {
    throw new CareError('INVALID_COMMAND', `Invalid auth command: ${msg}`, 400);
  };
  if (!cmd || typeof cmd !== 'object') return bad('missing command');
  requireNonEmptyString(cmd.accountId, 'accountId', 256);
  switch (cmd.channel) {
    case 'zalo':
      if (cmd.method === 'qr_start') return cmd;
      if (cmd.method === 'session_restore') {
        requireNonEmptyString(cmd.sessionJson, 'sessionJson', 200_000);
        return cmd;
      }
      return bad(`unsupported zalo method '${(cmd as { method?: string }).method}'`);
    case 'telegram':
      switch (cmd.method) {
        case 'qr_start':
          return cmd;
        case 'qr_poll':
          requireNonEmptyString(cmd.loginToken, 'loginToken', 512);
          return cmd;
        case 'phone_start':
          if (!/^\+?\d{6,20}$/.test(cmd.phoneNumber ?? '')) return bad('phoneNumber must be 6-20 digits');
          return cmd;
        case 'phone_code':
          requireNonEmptyString(cmd.phoneCodeHash, 'phoneCodeHash', 256);
          requireNonEmptyString(cmd.phoneCode, 'phoneCode', 16);
          return cmd;
        case 'password_2fa':
          requireNonEmptyString(cmd.password, 'password', 512);
          return cmd;
        case 'session_restore':
          requireNonEmptyString(cmd.sessionString, 'sessionString', 200_000);
          return cmd;
        default:
          return bad(`unsupported telegram method '${(cmd as { method?: string }).method}'`);
      }
    case 'email':
      if (cmd.method !== 'composio_connection') return bad('unsupported email method');
      requireNonEmptyString(cmd.composioConnectionId, 'composioConnectionId', 256);
      if (!EMAIL_ADDRESS.test(cmd.accountAddress ?? '')) return bad('accountAddress must be an email address');
      return cmd;
    default:
      return bad(`unknown channel '${(cmd as { channel?: string }).channel}'`);
  }
}

// ── Sync ───────────────────────────────────────────────────────────────────────────────────
export type NativeCheckpointBox =
  | 'zalo_chat'
  | `zalo_thread:${string}`
  | 'telegram_common_box'
  | `telegram_channel_box:${string}`
  | 'gmail_mailbox';

export interface SyncCommand {
  accountId: string;
  /** Box the adapter should resume; the cursor is opaque to core. */
  checkpoint?: { namespace: NativeCheckpointBox; cursor: string };
  limit?: number;
  fullBackfill?: boolean;
}

export interface SyncResult {
  events: NormalizedEvent[];
  /** Adapter-owned next checkpoint (typed, with CAS/position) for the box that was read. */
  nextCheckpoint?: CareCheckpoint;
  hasMore: boolean;
}

// ── Delivery: chat | email union ──────────────────────────────────────────────────────────
interface DeliveryCommandBase {
  clientRequestId: string;
  accountId: string;
  purpose: CareIntentPurpose;
  actor: CareActorType;
  ownerEpoch: number;
  /**
   * Stable native retry token, persisted before the first RPC and reused verbatim on every retry
   * of this request. Mandatory whenever the connector claims `sendDedupe`. Telegram: signed
   * 64-bit random_id as a decimal string.
   */
  adapterRetryToken?: string;
  text: string;
}

export interface ChatDeliveryCommand extends DeliveryCommandBase {
  kind: 'chat';
  channel: 'zalo' | 'telegram';
  target: {
    externalConversationKey: string;
    replyToMessageId?: string;
    topicId?: string;
  };
}

export interface EmailDeliveryCommand extends DeliveryCommandBase {
  kind: 'email';
  channel: 'email';
  target: {
    /** Absent => brand-new mail (requires the newMail capability). */
    externalConversationKey?: string;
    to: string[];
    cc?: string[];
    subject: string;
    replyToMessageId?: string;
    inReplyToHeader?: string;
  };
  /**
   * PRIVATE delivery envelope of the sending account. Never persisted on shared timelines,
   * participants, events or logs, and requires the bcc capability.
   */
  bcc?: string[];
}

export type DeliveryCommand = ChatDeliveryCommand | EmailDeliveryCommand;

export interface DeliveryResult {
  outcome: 'accepted' | 'delivered' | 'read' | 'uncertain' | 'failed';
  nativeMessageId?: string;
  adapterRetryToken?: string;
  remoteTimestampMs?: number;
  receiptLevel?: CareReceiptLevel;
  error?: string;
}

const TOKEN_GENERIC = /^[A-Za-z0-9_.:-]{8,128}$/;
const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

export function isValidRetryToken(channel: CareChannel, token: unknown): token is string {
  if (typeof token !== 'string') return false;
  if (channel === 'telegram') {
    if (!/^-?\d{1,19}$/.test(token)) return false;
    const n = BigInt(token);
    return n >= INT64_MIN && n <= INT64_MAX && n !== 0n;
  }
  return TOKEN_GENERIC.test(token);
}

function headerSafe(value: unknown, label: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new CareError('INVALID_TARGET', `${label} is required`, 400);
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > max || CONTROL_CHARS.test(value)) {
    throw new CareError('INVALID_TARGET', `${label} must be a single-line string (max ${max})`, 400);
  }
  return value;
}

function validAddresses(list: unknown, label: string, required: boolean): string[] {
  if (list === undefined || list === null) {
    if (required) throw new CareError('INVALID_TARGET', `${label} is required`, 400);
    return [];
  }
  if (!Array.isArray(list) || (required && list.length === 0) || list.length > 100) {
    throw new CareError('INVALID_TARGET', `${label} must be a list of email addresses`, 400);
  }
  for (const a of list) {
    if (typeof a !== 'string' || !EMAIL_ADDRESS.test(a)) {
      throw new CareError('INVALID_TARGET', `${label} contains an invalid email address`, 400);
    }
  }
  return list as string[];
}

/**
 * Structural validation, independent of provider capabilities: kind/channel congruence, no
 * chat command carrying email recipients or BCC (and vice versa), well-formed recipients and
 * a well-formed retry token if one is present. Capability checks (e.g. token required for a
 * dedupe-capable connector, bcc/replyAll support) are made by the connector.
 */
export function validateDeliveryCommand(cmd: DeliveryCommand): DeliveryCommand {
  if (!cmd || typeof cmd !== 'object') {
    throw new CareError('INVALID_COMMAND', 'Delivery command is required', 400);
  }
  requireNonEmptyString(cmd.clientRequestId, 'clientRequestId', 256);
  requireNonEmptyString(cmd.accountId, 'accountId', 256);
  requireSafeInteger(cmd.ownerEpoch, 'ownerEpoch', 1);
  oneOf(ACTORS, cmd.actor, 'actor');
  oneOf(PURPOSES, cmd.purpose, 'purpose');
  if (typeof cmd.text !== 'string' || cmd.text.length === 0 || cmd.text.length > 100_000) {
    throw new CareError('INVALID_COMMAND', 'Delivery text must be a non-empty string', 400);
  }
  if (cmd.adapterRetryToken !== undefined && !isValidRetryToken(cmd.channel, cmd.adapterRetryToken)) {
    throw new CareError('INVALID_COMMAND', `adapterRetryToken is not valid for channel '${cmd.channel}'`, 400);
  }

  if (cmd.kind === 'chat') {
    if (cmd.channel !== 'zalo' && cmd.channel !== 'telegram') {
      throw new CareError('INVALID_TARGET', `Chat delivery is not valid for channel '${String(cmd.channel)}'`, 400);
    }
    const loose = cmd as unknown as Record<string, unknown>;
    const target = (cmd.target ?? {}) as Record<string, unknown>;
    if ('bcc' in loose || 'to' in target || 'cc' in target || 'subject' in target) {
      throw new CareError('INVALID_TARGET', 'Chat delivery cannot carry email recipients, subject or BCC', 400);
    }
    headerSafe(cmd.target?.externalConversationKey, 'target.externalConversationKey', 1024, true);
    headerSafe(cmd.target.replyToMessageId, 'target.replyToMessageId', 512);
    if (cmd.target.topicId !== undefined) {
      if (cmd.channel !== 'telegram') throw new CareError('INVALID_TARGET', 'topicId is only valid for telegram', 400);
      if (typeof cmd.target.topicId !== 'string' || !/^\d{1,20}$/.test(cmd.target.topicId)) {
        throw new CareError('INVALID_TARGET', 'topicId must be a numeric string', 400);
      }
    }
    return cmd;
  }

  if (cmd.kind === 'email') {
    const channel = (cmd as { channel: string }).channel;
    if (channel !== 'email') {
      throw new CareError('INVALID_TARGET', `Email delivery is not valid for channel '${channel}'`, 400);
    }
    const target = cmd.target;
    if (!target || typeof target !== 'object') {
      throw new CareError('INVALID_TARGET', 'Email delivery requires a target', 400);
    }
    if ((target as unknown as Record<string, unknown>).topicId !== undefined) {
      throw new CareError('INVALID_TARGET', 'topicId is not valid for email', 400);
    }
    validAddresses(target.to, 'target.to', true);
    validAddresses(target.cc, 'target.cc', false);
    validAddresses(cmd.bcc, 'bcc', false);
    headerSafe(target.subject, 'target.subject', 998, true);
    headerSafe(target.externalConversationKey, 'target.externalConversationKey', 1024);
    headerSafe(target.replyToMessageId, 'target.replyToMessageId', 512);
    headerSafe(target.inReplyToHeader, 'target.inReplyToHeader', 998);
    return cmd;
  }

  throw new CareError('INVALID_TARGET', `Unknown delivery kind '${String((cmd as { kind?: string }).kind)}'`, 400);
}

export interface ReconcileCommand {
  clientRequestId: string;
  adapterRetryToken?: string;
  accountId: string;
  nativeMessageId?: string;
  externalConversationKey?: string;
  ownerEpoch: number;
}

export function validateReconcileCommand(cmd: ReconcileCommand): ReconcileCommand {
  if (!cmd || typeof cmd !== 'object') throw new CareError('INVALID_COMMAND', 'Reconcile command is required', 400);
  requireNonEmptyString(cmd.clientRequestId, 'clientRequestId', 256);
  requireNonEmptyString(cmd.accountId, 'accountId', 256);
  requireSafeInteger(cmd.ownerEpoch, 'ownerEpoch', 1);
  headerSafe(cmd.adapterRetryToken, 'adapterRetryToken', 128);
  headerSafe(cmd.nativeMessageId, 'nativeMessageId', 512);
  headerSafe(cmd.externalConversationKey, 'externalConversationKey', 1024);
  return cmd;
}

export interface ReadCommand {
  accountId: string;
  externalConversationKey: string;
  nativeMessageId: string;
}

export interface ReadResult {
  ok: boolean;
  error?: string;
}

export interface MediaCommand {
  accountId: string;
  attachmentId: string;
  mediaUrl?: string;
}

export interface MediaResult {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export interface CareConnector {
  readonly kind: string;
  readonly channel: CareChannel;
  capabilities(accountId: string, conversationKey?: string): Promise<ConnectorCapabilities>;
  connect(command: AuthCommand): Promise<AuthResult>;
  sync(command: SyncCommand): Promise<SyncResult>;
  dispatch(command: DeliveryCommand): Promise<DeliveryResult>;
  reconcile(command: ReconcileCommand): Promise<DeliveryResult>;
  markRead(command: ReadCommand): Promise<ReadResult>;
  fetchAttachment(command: MediaCommand): Promise<MediaResult>;
}
