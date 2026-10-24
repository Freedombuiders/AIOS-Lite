/**
 * Turn zca-js listener payloads into zalo_threads / zalo_messages rows.
 *
 * Ported from ZaloCRM's zalo-listener-factory.ts + chat/message-handler.ts,
 * minus the CRM side effects (contacts, scoring, webhooks, bridges). What
 * stays is the part that keeps the history correct:
 *   - thread type and peer resolution (self-sent DMs carry the peer in idTo),
 *   - name/avatar lookups behind a short cache (getGroupInfo used to be called
 *     on every group message),
 *   - dedupe on (thread, Zalo message id),
 *   - recognising the echo of our own sends so an agent/dashboard message is
 *     not stored a second time as if it had been typed on the phone.
 */

import { ThreadType, type API } from 'zca-js';

import {
  insertZaloMessage,
  markZaloMessagesRecalled,
  recordZaloThreadActivity,
  setZaloMessageRemoteIds,
  setZaloThreadOptedOut,
  upsertZaloThread,
  type ZaloSenderType,
  type ZaloThreadRow,
} from './store.js';
import { logger } from './compat.js';
import { noteBirthDateFromProfile } from './birthday.js';
import { detectContentType, extractMentions, extractQuote, renderText, serializeContent } from './content.js';
import { matchesOptOut, type ZaloLimiter } from './limits.js';

export interface IngestContext {
  accountId: string;
  api: API;
  ownUid: string;
  /** Budgets for the lookups below; without one (tests) lookups are unmetered. */
  limiter?: ZaloLimiter;
}

export interface IngestResult {
  thread: ZaloThreadRow;
  messageId: number;
  senderType: ZaloSenderType;
  origin: 'live' | 'backfill';
}

type Obj = Record<string, unknown>;

const USER_TTL_MS = 5 * 60_000;
const GROUP_TTL_MS = 10 * 60_000;

interface UserInfo { name: string; avatar: string; globalId: string; at: number }
/** What resolveUser returns; `profile` is set only on the call that really hit Zalo. */
interface ResolvedUser extends UserInfo { profile?: Obj }
interface GroupInfo { name: string; avatar: string; members: number | null; at: number }

const userCache = new Map<string, UserInfo>();
const groupCache = new Map<string, GroupInfo>();

export async function resolveUser(ctx: IngestContext, uid: string): Promise<ResolvedUser> {
  const key = `${ctx.accountId}:${uid}`;
  const hit = userCache.get(key);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit;
  let info: UserInfo = { name: '', avatar: '', globalId: '', at: Date.now() };
  let profile: Obj | undefined;
  // Out of query budget: store the message with whatever name it carries and
  // try again on a later one (nothing cached, so the next call re-checks).
  if (ctx.limiter && !ctx.limiter.consume(ctx.accountId, 'query').ok) return info;
  try {
    const res = await ctx.api.getUserInfo(uid);
    const profiles = (res?.changed_profiles ?? {}) as Record<string, Obj>;
    const p = profiles[uid] ?? profiles[`${uid}_0`];
    if (p) {
      profile = p;
      info = {
        name: String(p.zaloName || p.zalo_name || p.displayName || p.display_name || ''),
        avatar: String(p.avatar || ''),
        globalId: String(p.globalId || ''),
        at: Date.now(),
      };
    }
  } catch (err) {
    logger.warn({ accountId: ctx.accountId, uid, err: String(err) }, 'zalo getUserInfo failed');
  }
  userCache.set(key, info);
  return profile ? { ...info, profile } : info;
}

export async function resolveGroup(ctx: IngestContext, groupId: string): Promise<GroupInfo> {
  const key = `${ctx.accountId}:${groupId}`;
  const hit = groupCache.get(key);
  if (hit && Date.now() - hit.at < GROUP_TTL_MS) return hit;
  let info: GroupInfo = { name: '', avatar: '', members: null, at: Date.now() };
  if (ctx.limiter && !ctx.limiter.consume(ctx.accountId, 'group_read').ok) return info;
  try {
    const res = await ctx.api.getGroupInfo(groupId);
    const g = res?.gridInfoMap?.[groupId] as Obj | undefined;
    if (g) {
      const members = g.memVerList ?? g.memList ?? g.members;
      info = {
        name: String(g.name || ''),
        avatar: String(g.avt || g.fullAvt || ''),
        members: Array.isArray(members) ? members.length : (typeof g.totalMember === 'number' ? g.totalMember : null),
        at: Date.now(),
      };
    }
  } catch (err) {
    logger.warn({ accountId: ctx.accountId, groupId, err: String(err) }, 'zalo getGroupInfo failed');
  }
  groupCache.set(key, info);
  return info;
}

export function forgetGroupInfo(accountId: string, groupId: string): void {
  groupCache.delete(`${accountId}:${groupId}`);
}

// ── Echoes of our own sends ─────────────────────────────────────────
//
// With selfListen on, Zalo echoes every message this nick sends — including
// the ones the daemon itself just sent for an agent or the dashboard. The
// sender registers each outbound row here before calling the API; the echo
// claims it (same thread, same text, within a minute) instead of becoming a
// new "typed on the phone" row, which would also wrongly pause the agent.

const ECHO_WINDOW_MS = 60_000;
const pendingEchoes = new Map<number, Array<{ messageId: number; text: string; at: number }>>();

export function registerPendingEcho(threadId: number, messageId: number, text: string): void {
  const list = (pendingEchoes.get(threadId) ?? []).filter((e) => Date.now() - e.at < ECHO_WINDOW_MS);
  list.push({ messageId, text: text.trim(), at: Date.now() });
  pendingEchoes.set(threadId, list);
}

function claimPendingEcho(threadId: number, text: string): number | null {
  const list = pendingEchoes.get(threadId);
  if (!list) return null;
  const now = Date.now();
  const idx = list.findIndex((e) => now - e.at < ECHO_WINDOW_MS && e.text === text.trim());
  if (idx < 0) return null;
  const [hit] = list.splice(idx, 1);
  if (list.length === 0) pendingEchoes.delete(threadId);
  return hit.messageId;
}

export function clearPendingEcho(threadId: number, messageId: number): void {
  const list = pendingEchoes.get(threadId);
  if (!list) return;
  const next = list.filter((e) => e.messageId !== messageId);
  if (next.length === 0) pendingEchoes.delete(threadId);
  else pendingEchoes.set(threadId, next);
}

// ── Messages ────────────────────────────────────────────────────────

interface SdkMessageLike {
  type?: number;
  threadId?: string;
  isSelf?: boolean;
  data?: Obj;
}

/**
 * Store one message. `threadTypeHint` covers `old_messages` batches, where
 * the batch carries the type instead of each message. Returns null when the
 * message was a duplicate or the echo of our own send.
 */
export async function ingestMessage(
  ctx: IngestContext,
  message: SdkMessageLike,
  origin: 'live' | 'backfill',
  threadTypeHint?: ThreadType,
): Promise<IngestResult | null> {
  const data = message.data ?? {};
  const isGroup = (message.type ?? threadTypeHint) === ThreadType.Group;
  const isSelf = Boolean(message.isSelf);
  const senderUid = String(data.uidFrom ?? '');
  // Self-sent DMs from requestOldMessages may lack threadId: the peer is idTo.
  const externalId = String(message.threadId || (isSelf ? data.idTo : senderUid) || '');
  if (!externalId) return null;

  let thread: ZaloThreadRow;
  if (isGroup) {
    const g = await resolveGroup(ctx, externalId);
    thread = upsertZaloThread({
      accountId: ctx.accountId, threadType: 'group', externalId,
      name: g.name, avatarUrl: g.avatar, membersCount: g.members,
    });
  } else {
    const peer = await resolveUser(ctx, externalId);
    thread = upsertZaloThread({
      accountId: ctx.accountId, threadType: 'user', externalId,
      name: peer.name || (!isSelf ? String(data.dName ?? '') : ''), avatarUrl: peer.avatar, globalId: peer.globalId,
    });
    // A fresh profile may carry the birthday (birthday greetings read it).
    if (peer.profile) {
      try { noteBirthDateFromProfile(thread.id, peer.profile); } catch { /* best effort */ }
    }
  }

  const raw = data.content;
  const body = serializeContent(raw);
  const contentType = detectContentType(typeof data.msgType === 'string' ? data.msgType : undefined, raw);
  const zaloMsgId = data.msgId !== undefined && data.msgId !== null && String(data.msgId) !== '' ? String(data.msgId) : null;
  const cliMsgId = data.cliMsgId ? String(data.cliMsgId) : null;
  const ts = parseInt(String(data.ts ?? ''), 10);
  const sentAtMs = Number.isFinite(ts) && ts > 0 ? ts : Date.now();

  let senderType: ZaloSenderType = isSelf ? 'self' : 'customer';
  if (isSelf && contentType === 'text' && origin === 'live') {
    const claimed = claimPendingEcho(thread.id, body);
    if (claimed !== null) {
      if (zaloMsgId) setZaloMessageRemoteIds(claimed, zaloMsgId, cliMsgId);
      return null;
    }
  }

  let senderName = String(data.dName ?? '');
  if (senderType === 'customer' && !senderName && senderUid) {
    senderName = isGroup ? (await resolveUser(ctx, senderUid)).name : thread.name;
  }

  const messageId = insertZaloMessage({
    threadId: thread.id,
    zaloMsgId,
    cliMsgId,
    senderType,
    senderUid: isSelf ? ctx.ownUid : senderUid,
    senderName,
    body,
    contentType,
    quote: extractQuote(data),
    mentions: extractMentions(data),
    origin,
    sentAtMs,
  });
  if (messageId === null) return null;

  recordZaloThreadActivity(thread.id, {
    sentAtMs,
    preview: renderText(contentType, body),
    senderType,
    live: origin === 'live',
  });
  // "Đừng nhắn nữa" from a 1-1 customer ends marketing to them, whether or
  // not an agent is assigned to the thread.
  if (!isGroup && origin === 'live' && senderType === 'customer' && contentType === 'text'
    && thread.opted_out !== 1 && matchesOptOut(body)) {
    setZaloThreadOptedOut(thread.id, true);
    logger.info({ accountId: ctx.accountId, threadId: thread.id }, 'zalo customer opted out of marketing');
  }
  return { thread, messageId, senderType, origin };
}

/**
 * Recall ("thu hồi"). The undo packet's own msgId is NOT the recalled
 * message — the original is referenced by content.globalMsgId / cliMsgId.
 */
export function ingestUndo(accountId: string, undo: { data?: Obj }): number {
  const content = (undo.data?.content ?? {}) as Obj;
  const globalMsgId = content.globalMsgId ? String(content.globalMsgId) : undefined;
  const cliMsgId = content.cliMsgId ? String(content.cliMsgId) : undefined;
  if (!globalMsgId && !cliMsgId) return 0;
  return markZaloMessagesRecalled(accountId, { globalMsgId, cliMsgId });
}
