/**
 * Tasks and waiting/overdue metrics, on top of `CareTaskService` (CC-19).
 *
 * Writes go through the service, so its rules apply: a conversation / source message must belong to the same account
 * AND the same person as the task's customer (no cross-account or cross-person source links), the scope is derived
 * (conversation > account > customer-wide), every update is a compare-and-set on the task revision (stale => 409 with
 * `currentRevision`), and `owner` stays a free label rather than an authorization identity.
 * Reads page `queryTasks` (the same query the service wraps) so a source behind a closed read gate never costs a page slot
 * or a cursor step. Metrics are pure queries over the server projection and honour the same gate.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import {
  CareTaskService,
  isOverdue,
  overdueTasksByAccount,
  overdueTasksByOwner,
  waitingByAccount,
  waitingByOwner,
  type TaskView,
} from '../application/tasks-and-waiting.js';
import type { TaskRow } from '../persistence/audit-store.js';
import type { CareTaskDto } from './dto.js';
import { invalid, notFound } from './errors.js';
import { parseBody, type CareApiContext } from './context.js';
import { boolParam, decodeCursor, encodeCursor, idParam, intParam, optionalMsParam } from './util.js';

const id = z.string().min(1).max(256);
const createSchema = z
  .object({
    customerId: id,
    conversationId: id.nullish(),
    accountId: id.nullish(),
    sourceMessageId: id.nullish(),
    title: z.string().trim().min(1).max(2000),
    dueAtMs: z.number().int().min(0).max(8_640_000_000_000_000),
    owner: z.string().trim().max(128).nullish(),
  })
  .strict();

const patchSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    title: z.string().trim().min(1).max(2000).optional(),
    dueAtMs: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
    owner: z.string().trim().max(128).nullable().optional(),
    done: z.boolean().optional(),
  })
  .strict();

const SCOPES = ['customer', 'account', 'conversation'] as const;
const BATCH = 200;
const MAX_BATCHES = 20;
const DEFAULT_SLA_MS = 15 * 60_000;

export function toTaskViewDto(t: Pick<TaskRow, 'id' | 'customerId' | 'conversationId' | 'title' | 'dueAtMs' | 'done' | 'owner' | 'revision' | 'updatedAtMs' | 'scope' | 'accountId' | 'sourceMessageId'>, nowMs: number): CareTaskDto {
  return {
    id: t.id,
    customerId: t.customerId,
    conversationId: t.conversationId,
    title: t.title,
    dueAtMs: t.dueAtMs,
    done: t.done,
    owner: t.owner,
    revision: t.revision,
    updatedAtMs: t.updatedAtMs,
    scope: t.scope,
    accountId: t.accountId,
    sourceMessageId: t.sourceMessageId,
    overdue: isOverdue(t, nowMs),
  };
}

export function registerTaskRoutes(sub: Hono, ctx: CareApiContext): void {
  const service = (): CareTaskService => {
    const m = ctx.model();
    return new CareTaskService(m.db, m.stores);
  };
  /** A task scoped to a source behind a closed gate reads like a missing task. */
  const assertReadable = (accountId: string | null | undefined): void => {
    if (accountId && !ctx.canReadSource(accountId)) throw notFound();
  };

  /** An `account` query parameter: unknown and gate-closed ids answer identically (404), like the conversation / search reads. */
  const assertQueryAccount = (accountId: string): void => {
    if (!ctx.model().accountExists(accountId)) throw notFound();
    assertReadable(accountId);
  };

  sub.get('/tasks', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const cap = intParam(q.limit, 'limit', { min: 1, max: 200, fallback: 50 });
    const scope = q.scope ? ((SCOPES as readonly string[]).includes(q.scope) ? (q.scope as (typeof SCOPES)[number]) : null) : undefined;
    if (scope === null) throw invalid("Query parameter 'scope' has an unsupported value.");
    const dueBefore = optionalMsParam(q.dueBefore, 'dueBefore');
    const overdue = boolParam(q.overdue);
    const done = boolParam(q.done);
    const nowMs = ctx.now();
    const cursor = decodeCursor(q.cursor);
    if (q.account) assertQueryAccount(q.account);
    const filter = {
      customerId: q.customer || undefined,
      conversationId: q.conversation || undefined,
      accountId: q.account || undefined,
      owner: q.owner || undefined,
      scope,
      done: overdue === true ? false : done,
      ...(overdue === true ? { overdueBeforeMs: nowMs } : {}),
    };

    return c.json(
      m.read(() => {
        const visible: TaskRow[] = [];
        let after = cursor ? { dueAtMs: cursor.ms, id: cursor.id } : undefined;
        let more = false;
        for (let batch = 0; batch < MAX_BATCHES && visible.length <= cap; batch += 1) {
          const raw = m.stores.audit.queryTasks({ ...filter, limit: BATCH, after });
          if (raw.length === 0) break;
          for (const row of raw) {
            // Ascending by due date: past the bound nothing else can match.
            if (dueBefore !== null && row.dueAtMs > dueBefore) return page(visible, cap, false);
            after = { dueAtMs: row.dueAtMs, id: row.id };
            if (row.accountId && !ctx.canReadSource(row.accountId)) continue;
            if (overdue === false && isOverdue(row, nowMs)) continue;
            visible.push(row);
            if (visible.length > cap) break;
          }
          if (visible.length > cap) break;
          if (raw.length < BATCH) return page(visible, cap, false);
          more = true;
        }
        return page(visible, cap, more);
      }),
    );

    function page(rows: TaskRow[], limit: number, scanBudgetHit: boolean): { items: CareTaskDto[]; nextCursor: string | null } {
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      const hasMore = rows.length > limit || (scanBudgetHit && Boolean(last));
      return { items: items.map((r) => toTaskViewDto(r, nowMs)), nextCursor: hasMore && last ? encodeCursor(last.dueAtMs, last.id) : null };
    }
  });

  sub.post('/tasks', async (c) => {
    const m = ctx.model();
    const body = await parseBody(c, createSchema);
    // Resolve the source account up front so a closed gate answers 404, never a leaking validation error.
    const viaMessage = body.sourceMessageId ? m.stores.messages.getMessage(body.sourceMessageId)?.accountId : undefined;
    const viaConversation = body.conversationId ? m.stores.conversations.getConversation(body.conversationId)?.accountId : undefined;
    assertReadable(viaMessage ?? viaConversation ?? body.accountId);
    const created = service().createTask({
      customerId: body.customerId,
      conversationId: body.conversationId ?? null,
      accountId: body.accountId ?? null,
      sourceMessageId: body.sourceMessageId ?? null,
      title: body.title,
      dueAtMs: body.dueAtMs,
      owner: body.owner ?? null,
    });
    return c.json(toTaskViewDto(created, ctx.now()), 201);
  });

  sub.patch('/tasks/:id', async (c) => {
    const m = ctx.model();
    const taskId = idParam(c.req.param('id'));
    const { expectedRevision, ...patch } = await parseBody(c, patchSchema);
    if (Object.keys(patch).length === 0) throw invalid('Nothing to update.');
    assertReadable(m.stores.audit.taskAccountId(taskId));
    // One transaction, one revision bump; a stale revision is a 409 carrying currentRevision.
    const updated: TaskView = service().updateTask(taskId, patch, expectedRevision);
    return c.json(toTaskViewDto(updated, ctx.now()));
  });

  // ── metrics ─────────────────────────────────────────────────────────────────────────────────
  const by = (raw: string | undefined): 'owner' | 'account' => {
    if (raw === undefined || raw === '' || raw === 'owner') return 'owner';
    if (raw === 'account') return 'account';
    throw invalid("Query parameter 'by' must be owner or account.");
  };

  sub.get('/metrics/waiting', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const grouping = by(q.by);
    const slaMs = intParam(q.slaMs, 'slaMs', { min: 0, max: 31 * 86_400_000, fallback: DEFAULT_SLA_MS });
    if (q.account) assertQueryAccount(q.account);
    const opts = { nowMs: ctx.now(), slaMs, accountId: q.account || undefined, canReadSource: (a: string) => ctx.canReadSource(a) };
    const items = m.read(() => (grouping === 'owner' ? waitingByOwner(m.stores, opts) : waitingByAccount(m.stores, opts)));
    return c.json({ by: grouping, slaMs, nowMs: opts.nowMs, items });
  });

  sub.get('/metrics/overdue', (c) => {
    const m = ctx.model();
    const grouping = by(c.req.query('by'));
    const opts = { nowMs: ctx.now(), canReadSource: (a: string) => ctx.canReadSource(a) };
    const items = m.read(() => (grouping === 'owner' ? overdueTasksByOwner(m.stores, opts) : overdueTasksByAccount(m.stores, opts)));
    return c.json({ by: grouping, nowMs: opts.nowMs, items });
  });
}
