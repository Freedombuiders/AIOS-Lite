/**
 * Zalo payload -> Care canonical message. Pure: no I/O, no DB, no zca-js. Reuses the legacy pure
 * helpers (src/zalo/content.ts) for content type, mention/quote extraction and rendering so Care and
 * the legacy dashboard read a payload the same way.
 *
 * Identity rules (CC-13):
 *  - conversation = account + thread id (peer uid for a DM, group id for a group);
 *  - message      = account + namespace `zalo_chat` + Zalo `msgId`, kept as a STRING (ids exceed 2^53);
 *    a payload without `msgId` falls back to `cli:<cliMsgId>` (stable, and what the legacy bridge
 *    called a provisional key), a payload with neither is not ingestable;
 *  - order        = the numeric `msgId` (what the legacy table calls msg_id_num); never the timestamp;
 *  - echo of own send = `isSelf` => direction out, role `self`, same native id as the send ack, so
 *    Care's (account, namespace, id) uniqueness folds the echo into the delivered message;
 *  - group sender = `senderIdentityKey` is the member uid; mentions/quote carry uids so the
 *    "directed at this account" rule (mention of own uid / quote of own message) can be evaluated.
 */

import type { CareAttachmentDescriptor, ChatMention, ChatMetadata, NormalizedMessage } from '../../../../_lib/care-kit/index.js';
import { detectContentType, extractMentions, mediaUrl, renderText, serializeContent } from '../../content.js';
import type { ZaloRawData, ZaloRawMessage, ZaloRawUndo } from './transport.js';

export const ZALO_NAMESPACE = 'zalo_chat';

const DIGITS = /^\d{1,40}$/;

function idString(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s === '' || s === '0' ? null : s;
}

/** Native id of a payload: `msgId`, else `cli:<cliMsgId>`, else null (not ingestable). */
export function nativeIdOf(data: ZaloRawData): string | null {
  const msgId = idString(data.msgId);
  if (msgId) return msgId;
  const cli = idString(data.cliMsgId);
  return cli ? `cli:${cli}` : null;
}

export function threadIdOf(raw: Pick<ZaloRawMessage, 'threadId' | 'isSelf' | 'data'>): string | null {
  // Self-sent DMs from old-message batches may lack threadId: the peer is idTo.
  const id = raw.threadId || (raw.isSelf ? raw.data.idTo : raw.data.uidFrom) || '';
  return id ? String(id) : null;
}

const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/*',
  video: 'video/*',
  voice: 'audio/*',
  gif: 'image/gif',
  file: 'application/octet-stream',
};

export interface NormalizeContext {
  accountId: string;
  /** The nick's own uid; used to recognise own messages whose `isSelf` flag is missing. */
  ownUid: string | null;
  origin: NormalizedMessage['origin'];
  nowMs: number;
}

export interface NormalizedZalo {
  message: NormalizedMessage;
  contentType: string;
  threadKind: ZaloRawMessage['threadKind'];
}

export function normalizeZaloMessage(raw: ZaloRawMessage, ctx: NormalizeContext): NormalizedZalo | null {
  const data = raw.data ?? {};
  const nativeId = nativeIdOf(data);
  const threadId = threadIdOf(raw);
  if (!nativeId || !threadId) return null;

  const senderUid = idString(data.uidFrom);
  const isSelf = Boolean(raw.isSelf) || (ctx.ownUid !== null && senderUid === ctx.ownUid);
  const isGroup = raw.threadKind === 'group';

  const content = data.content;
  const body = serializeContent(content);
  const contentType = detectContentType(typeof data.msgType === 'string' ? data.msgType : undefined, content);
  const text = contentType === 'text' ? body : renderText(contentType, body);

  const ts = parseInt(String(data.ts ?? ''), 10);
  const sentAtMs = Number.isSafeInteger(ts) && ts > 0 ? ts : ctx.nowMs;

  const mentions: ChatMention[] | undefined = extractMentions(data)?.map((m) => ({
    uid: m.uid,
    offset: m.pos,
    length: m.len,
    isAll: m.type === 1,
  }));

  let quote: ChatMetadata['quote'] = null;
  if (data.quote && typeof data.quote === 'object') {
    const q = data.quote;
    const quotedId = idString(q.globalMsgId);
    quote = {
      // The quoted message's native id when Zalo gave it, '' otherwise (kept honest, never guessed).
      messageId: quotedId && DIGITS.test(quotedId) ? quotedId : '',
      senderId: idString(q.ownerId) ?? undefined,
      text: typeof q.msg === 'string' ? q.msg : undefined,
    };
  }

  const attachments: CareAttachmentDescriptor[] | undefined =
    contentType in MIME_BY_TYPE
      ? [
          {
            id: `zalo:${nativeId}`,
            mimeType: MIME_BY_TYPE[contentType],
            fileName: titleOf(body),
            ...(mediaUrl(body) ? { url: mediaUrl(body)! } : {}),
            ...(contentType === 'voice' ? { isVoice: true } : {}),
          },
        ]
      : undefined;

  const metadata: ChatMetadata = {
    type: 'chat',
    conversationKind: isGroup ? 'group' : 'direct',
    quote,
    mentions: mentions && mentions.length ? mentions : null,
    ...(attachments ? { attachments } : {}),
    rawEnvelope: {
      connector: 'zalo',
      contentType,
      senderName: typeof data.dName === 'string' ? data.dName : '',
      senderUid: senderUid ?? '',
      zaloMsgId: idString(data.msgId),
      cliMsgId: idString(data.cliMsgId),
      ...wireEnvelope(data),
    },
  };

  const message: NormalizedMessage = {
    accountId: ctx.accountId,
    externalConversationKey: threadId,
    nativeMessageNamespace: ZALO_NAMESPACE,
    nativeMessageId: nativeId,
    nativeVersion: null,
    nativeOrder: DIGITS.test(nativeId) ? nativeId : null,
    senderIdentityKey: isSelf ? null : senderUid,
    senderRole: isSelf ? 'self' : 'customer',
    direction: isSelf ? 'out' : 'in',
    origin: ctx.origin,
    sentAtMs,
    text,
    metadata,
  };
  return { message, contentType, threadKind: raw.threadKind };
}

/**
 * The wire fields a later quoted reply / seen marker needs (zca-js `SendMessageQuote`, `SendSeenEventMessageParams`):
 * msgType, ts, ttl, st, at, cmd, idTo, uidFrom, propertyExt. Scalars only; absent fields stay absent (never guessed), and
 * a `propertyExt` that is not small JSON is dropped, which makes the message unquotable rather than wrongly quoted.
 */
function wireEnvelope(data: ZaloRawData): { wire?: Record<string, unknown> } {
  const wire: Record<string, unknown> = {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const set = (k: string, v: unknown): void => {
    if (v !== null && v !== undefined) wire[k] = v;
  };
  set('msgType', typeof data.msgType === 'string' && data.msgType !== '' ? data.msgType : null);
  set('ts', str(data.ts));
  set('ttl', num(data.ttl));
  set('st', num(data.st));
  set('at', num(data.at));
  set('cmd', num(data.cmd));
  set('idTo', str(data.idTo));
  set('uidFrom', str(data.uidFrom));
  if (data.propertyExt !== undefined && data.propertyExt !== null) {
    try {
      const json = JSON.stringify(data.propertyExt);
      if (json.length <= 2000) wire.propertyExt = JSON.parse(json);
    } catch {
      /* not serialisable: the message cannot be quoted faithfully */
    }
  }
  return Object.keys(wire).length > 0 ? { wire } : {};
}

function titleOf(body: string): string {
  if (!body.startsWith('{')) return '';
  try {
    const obj = JSON.parse(body) as { title?: unknown };
    return typeof obj.title === 'string' ? obj.title.slice(0, 256) : '';
  } catch {
    return '';
  }
}

export interface NormalizedRecall {
  nativeMessageId: string;
  externalConversationKey?: string;
  tsMs: number;
}

/** A recall references the original by content.globalMsgId (preferred) or cliMsgId; its own msgId is NOT the target. */
export function normalizeZaloUndo(undo: ZaloRawUndo, nowMs: number): NormalizedRecall | null {
  const content = undo.data?.content ?? {};
  const global = idString(content.globalMsgId);
  const cli = idString(content.cliMsgId);
  const nativeMessageId = global ?? (cli ? `cli:${cli}` : null);
  if (!nativeMessageId) return null;
  const ts = parseInt(String(undo.data?.ts ?? ''), 10);
  return {
    nativeMessageId,
    ...(undo.threadId ? { externalConversationKey: String(undo.threadId) } : {}),
    tsMs: Number.isSafeInteger(ts) && ts > 0 ? ts : nowMs,
  };
}
