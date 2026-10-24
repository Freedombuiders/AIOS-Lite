/**
 * History backfill and the periodic group safety-net sync.
 *
 * Ported from ZaloCRM's zalo-history-backfill.ts and zalo-message-sync.ts.
 * What Zalo actually allows:
 *   - groups: getGroupChatHistory(groupId, count) returns recent messages;
 *   - 1-1 chats: no REST history. listener.requestOldMessages() makes the
 *     server push `old_messages` batches over the websocket; the listener in
 *     session.ts stores them, this module only drives the paging. How far
 *     back it reaches is up to Zalo.
 * Everything else is captured live from login onwards.
 */

import { ThreadType } from 'zca-js';

import { listZaloThreads, upsertZaloThread } from './store.js';
import { logger } from './compat.js';
import { ingestMessage, type IngestContext } from './ingest.js';

const GROUP_INFO_CHUNK = 50;
const BACKFILL_MAX_GROUPS = 100;
const BACKFILL_MESSAGES_PER_GROUP = 50;
const GROUP_FAILS_TO_STOP = 5;
const DM_MAX_PAGES = 50;
const DM_IDLE_MS = 15_000;
// Zalo watches for bots polling groups; a gentle cadence on groups that are
// actually active, and never at the expense of the nick's group_read budget.
const SYNC_INTERVAL_MS = 10 * 60_000;
const SYNC_MAX_GROUPS = 10;
const SYNC_ACTIVE_WINDOW_MS = 72 * 3600_000;
const SYNC_MIN_BUDGET_SHARE = 0.3;

type Obj = Record<string, unknown>;

/** The nick's group_read budget ran out: stop reading, don't treat it as a failure. */
class BudgetExhausted extends Error {}

const BURST_WAITS = 6;
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** @internal tests only */
export function _setHistorySleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleep = fn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/**
 * Spend one group_read; without a limiter (tests) reads are unmetered.
 * A full burst window (e.g. 20 reads / 30 s right after the group list sync) is waited out with a little
 * jitter; only the DAILY budget stops the backfill. Before this, the first login stopped after the group list.
 */
async function spendGroupRead(ctx: IngestContext): Promise<void> {
  if (!ctx.limiter) return;
  for (let attempt = 0; ; attempt++) {
    const res = ctx.limiter.consume(ctx.accountId, 'group_read');
    if (res.ok) return;
    if (res.reason !== 'burst' || attempt >= BURST_WAITS) throw new BudgetExhausted('Đã dùng hết hạn mức đọc thông tin nhóm trong ngày của nick');
    await sleep((res.retryAfterMs ?? 30_000) + 1_000 + Math.floor(Math.random() * 2_000));
  }
}

export interface BackfillStats {
  groups: number;
  groupMessages: number;
  dmPages: number;
  dmMessages: number;
  errors: number;
}

/**
 * Fetch every group this nick belongs to and upsert it as a thread, so the
 * Agent page can assign agents to groups that have not spoken yet.
 * getAllGroups() only returns ids; names come from getGroupInfo in chunks.
 */
export async function syncGroupList(ctx: IngestContext): Promise<string[]> {
  await spendGroupRead(ctx);
  const res = await ctx.api.getAllGroups();
  const ids = Object.keys(res?.gridVerMap ?? {});
  for (let i = 0; i < ids.length; i += GROUP_INFO_CHUNK) {
    const chunk = ids.slice(i, i + GROUP_INFO_CHUNK);
    let infoMap: Record<string, Obj> = {};
    try {
      await spendGroupRead(ctx);
      const info = await ctx.api.getGroupInfo(chunk);
      infoMap = (info?.gridInfoMap ?? {}) as Record<string, Obj>;
    } catch (err) {
      // Out of budget: still list the groups, just without names this time.
      if (!(err instanceof BudgetExhausted)) logger.warn({ accountId: ctx.accountId, err: String(err) }, 'zalo getGroupInfo chunk failed');
    }
    for (const id of chunk) {
      const g = infoMap[id] ?? {};
      const members = g.memVerList;
      upsertZaloThread({
        accountId: ctx.accountId,
        threadType: 'group',
        externalId: id,
        name: String(g.name || ''),
        avatarUrl: String(g.avt || g.fullAvt || ''),
        membersCount: Array.isArray(members) ? members.length : (typeof g.totalMember === 'number' ? g.totalMember : null),
      });
    }
  }
  return ids;
}

async function backfillGroup(ctx: IngestContext, groupId: string, count: number): Promise<number> {
  await spendGroupRead(ctx);
  const history = await ctx.api.getGroupChatHistory(groupId, count);
  let inserted = 0;
  for (const m of history?.groupMsgs ?? []) {
    const res = await ingestMessage(ctx, { ...(m as unknown as Obj), threadId: groupId, type: ThreadType.Group } as never, 'backfill');
    if (res) inserted++;
  }
  return inserted;
}

/**
 * Drive requestOldMessages paging for 1-1 chats. Each `old_messages` batch
 * is persisted by the session listener; here we only pick the next cursor
 * (oldest / last / first — different cursors unlock different slices, a
 * trick from openzca) and stop after DM_IDLE_MS of silence.
 */
function pumpDirectMessages(ctx: IngestContext): Promise<{ pages: number; messages: number }> {
  const listener = ctx.api.listener;
  return new Promise((resolve) => {
    let pages = 0;
    let messages = 0;
    let timer: NodeJS.Timeout | null = null;
    let finished = false;
    const requested = new Set<string>();

    const finish = () => {
      if (finished) return;
      finished = true;
      listener.off('old_messages', onPage);
      if (timer) clearTimeout(timer);
      resolve({ pages, messages });
    };
    const armIdle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, DM_IDLE_MS);
    };
    const request = (cursor: string | null): boolean => {
      const c = (cursor ?? '').trim();
      if (c && requested.has(c)) return false;
      if (c) requested.add(c);
      try {
        listener.requestOldMessages(ThreadType.User, c || null);
        pages++;
        armIdle();
        return true;
      } catch (err) {
        logger.warn({ accountId: ctx.accountId, err: String(err) }, 'zalo requestOldMessages failed');
        return false;
      }
    };
    const cursorOf = (m: { data?: Obj }): string => String(m?.data?.msgId || m?.data?.actionId || m?.data?.cliMsgId || '');
    const onPage = (batch: unknown[], type: ThreadType) => {
      if (finished || type !== ThreadType.User) return;
      if (!Array.isArray(batch) || batch.length === 0) { finish(); return; }
      messages += batch.length;
      if (pages >= DM_MAX_PAGES) { finish(); return; }
      const list = batch as Array<{ data?: Obj }>;
      let oldest = list[0];
      for (const m of list) {
        if (parseInt(String(m?.data?.ts ?? '0'), 10) < parseInt(String(oldest?.data?.ts ?? '0'), 10)) oldest = m;
      }
      const candidates = [cursorOf(oldest), cursorOf(list[list.length - 1]), cursorOf(list[0])];
      if (!candidates.some((c) => request(c))) finish();
    };
    listener.on('old_messages', onPage);
    if (!request(null)) finish();
  });
}

/** Full first-login backfill: group list, recent group history, DM paging. */
export async function backfillAccount(ctx: IngestContext): Promise<BackfillStats> {
  const stats: BackfillStats = { groups: 0, groupMessages: 0, dmPages: 0, dmMessages: 0, errors: 0 };
  let groupIds: string[] = [];
  try {
    groupIds = await syncGroupList(ctx);
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) stats.errors++;
    logger.warn({ accountId: ctx.accountId, err: String(err) }, 'zalo getAllGroups failed');
  }
  let failedInARow = 0;
  for (const id of groupIds.slice(0, BACKFILL_MAX_GROUPS)) {
    try {
      stats.groupMessages += await backfillGroup(ctx, id, BACKFILL_MESSAGES_PER_GROUP);
      stats.groups++;
      failedInARow = 0;
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        logger.info({ accountId: ctx.accountId }, 'zalo history backfill stopped: group_read budget exhausted');
        break;
      }
      stats.errors++;
      logger.warn({ accountId: ctx.accountId, groupId: id, err: String(err) }, 'zalo group history failed');
      // Zalo refusing group history outright (e.g. 404 for every group): stop spending the nick's read budget
      if (++failedInARow >= GROUP_FAILS_TO_STOP) {
        logger.info({ accountId: ctx.accountId, failedInARow }, 'zalo history backfill stopped: Zalo keeps refusing group history');
        break;
      }
    }
  }
  try {
    const dm = await pumpDirectMessages(ctx);
    stats.dmPages = dm.pages;
    stats.dmMessages = dm.messages;
  } catch (err) {
    stats.errors++;
    logger.warn({ accountId: ctx.accountId, err: String(err) }, 'zalo DM backfill failed');
  }
  logger.info({ accountId: ctx.accountId, ...stats }, 'zalo history backfill done');
  return stats;
}

/**
 * Safety net: every 10 minutes re-read the latest messages of groups that
 * were active in the last 72 h and store whatever the websocket missed. At
 * most 10 groups per tick, and it stops early once the nick has used up
 * 70 % of its daily group_read budget (the rest is kept for live lookups).
 */
export class GroupSyncLoop {
  private timers = new Map<string, NodeJS.Timeout>();

  start(ctx: IngestContext): void {
    this.stop(ctx.accountId);
    const timer = setInterval(() => void this.tick(ctx), SYNC_INTERVAL_MS);
    timer.unref?.();
    this.timers.set(ctx.accountId, timer);
  }

  stop(accountId: string): void {
    const t = this.timers.get(accountId);
    if (t) clearInterval(t);
    this.timers.delete(accountId);
  }

  stopAll(): void {
    for (const id of [...this.timers.keys()]) this.stop(id);
  }

  async tick(ctx: IngestContext): Promise<void> {
    const { threads } = listZaloThreads({ accountId: ctx.accountId, threadType: 'group', limit: 100 });
    const cutoff = Date.now() - SYNC_ACTIVE_WINDOW_MS;
    const active = threads.filter((t) => t.last_message_at >= cutoff).slice(0, SYNC_MAX_GROUPS);
    let inserted = 0;
    for (const t of active) {
      if (ctx.limiter) {
        const daily = ctx.limiter.limitFor(ctx.accountId, 'group_read').daily;
        if (ctx.limiter.remaining(ctx.accountId, 'group_read') < daily * SYNC_MIN_BUDGET_SHARE) break;
      }
      try {
        inserted += await backfillGroup(ctx, t.external_id, BACKFILL_MESSAGES_PER_GROUP);
      } catch (err) {
        if (err instanceof BudgetExhausted) break;
        logger.debug({ accountId: ctx.accountId, groupId: t.external_id, err: String(err) }, 'zalo group sync failed');
      }
    }
    if (inserted > 0) logger.info({ accountId: ctx.accountId, inserted }, 'zalo group sync stored missed messages');
  }
}
