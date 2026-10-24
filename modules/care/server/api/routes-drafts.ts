/**
 * Draft requests, draft review, agent runs and the activity feed.
 *
 *  - `POST /conversations/:id/draft` only ENQUEUES an `inbound_turn` job with `trigger: 'manual'`. The model runs in the
 *    worker, never in the request, and the dispatch gate (work) is asked first.
 *  - `POST /drafts/:id/approve` approves the exact revision the reviewer saw (stale => 409 + currentRevision) and asks the
 *    dispatch gate (send) before the draft becomes pending; `discard` withdraws it.
 *  - Runs and activity expose reason codes and delivery status only: never the encrypted decision, prompts or secrets,
 *    and only for accounts whose read gate is open.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import { toCareOutboxDto, type OutboxContent } from '../application/outbox-service.js';
import { OUTBOX_STATUSES, type OutboxIntentRecord, type OutboxStatus } from '../persistence/outbox-store.js';
import { AGENT_RUN_STATUSES } from '../persistence/agent-run-store.js';
import type { CareActivityItemDto, CareConversationOutboxItemDto, CareDraftDto, CareDraftRequestDto, CareRunDto } from './dto-ops.js';
import { ApiError, invalid, notFound } from './errors.js';
import { requireDispatch } from './gate.js';
import { parseBody, type CareApiContext } from './context.js';
import { decodeCursor, encodeCursor, idParam, intParam } from './util.js';

const requestId = z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const draftRequestSchema = z.object({ clientRequestId: requestId.optional(), triggerMessageId: z.string().min(1).max(256).optional() }).strict();
const address = z.string().min(3).max(320);
const editSchema = z
  .object({
    /** The payload revision the reviewer was looking at. */
    expectedRevision: z.number().int().min(1),
    text: z.string().min(1).max(100_000).optional(),
    // chat
    topicId: z.string().min(1).max(32).optional(),
    // email
    to: z.array(address).min(1).max(100).optional(),
    cc: z.array(address).max(100).optional(),
    bcc: z.array(address).max(100).optional(),
    subject: z.string().min(1).max(998).optional(),
    inReplyToHeader: z.string().min(1).max(998).optional(),
    /** Canonical message this draft answers (must live in the draft's conversation); null clears it. */
    replyToMessageId: z.string().min(1).max(256).nullable().optional(),
    /** Conversation context revision the editor saw; recorded on the draft. */
    currentContextRevision: z.number().int().min(0).optional(),
  })
  .strict();
const approveSchema = z
  .object({ expectedRevision: z.number().int().min(1), currentContextRevision: z.number().int().min(0).optional() })
  .strict();

function toDraftDto(intent: OutboxIntentRecord): CareDraftDto {
  const p = intent.payload;
  return {
    ...toCareOutboxDto(intent),
    payloadRevision: intent.payloadRevision,
    approvedRevision: intent.approvedRevision,
    contextRevision: intent.contextRevision,
    policyRevision: intent.policyRevision,
    actor: intent.actor,
    channel: intent.channel,
    text: p.text,
    email:
      p.kind === 'email'
        ? { to: [...p.target.to], cc: [...(p.target.cc ?? [])], subject: p.target.subject, hasBcc: Boolean(p.bcc?.length) }
        : null,
  };
}

interface RunRow {
  id: string;
  account_id: string;
  conversation_id: string;
  trigger_message_id: string;
  status: CareRunDto['status'];
  skip_reason: string | null;
  mode: CareRunDto['mode'];
  agent_id: string;
  trigger_kind: CareRunDto['triggerKind'];
  policy_revision: string;
  draft_ref: string | null;
  model_called: number;
  latency_ms: number | null;
  cost_usd: number;
  created_at: number;
  updated_at: number;
}

const RUN_COLUMNS =
  'id, account_id, conversation_id, trigger_message_id, status, skip_reason, mode, agent_id, trigger_kind, policy_revision, draft_ref, model_called, latency_ms, cost_usd, created_at, updated_at';

export function registerDraftRoutes(sub: Hono, ctx: CareApiContext): void {
  // ── manual draft request ────────────────────────────────────────────────────────────────────
  sub.post('/conversations/:id/draft', async (c) => {
    const m = ctx.model();
    const conversationId = idParam(c.req.param('id'));
    const body = await parseBody(c, draftRequestSchema);
    const conv = m.stores.conversations.getConversation(conversationId);
    if (!conv || !ctx.canReadSource(conv.accountId)) throw notFound();
    const account = m.stores.accounts.getAccount(conv.accountId);
    if (!account) throw notFound();

    let trigger = body.triggerMessageId ? m.messageInConversation(conv.id, body.triggerMessageId) : null;
    if (!trigger) trigger = m.stores.messages.listMessages(conv.id, { limit: 50 }).find((x) => x.direction === 'in' && x.senderRole === 'customer') ?? null;
    if (!trigger || trigger.isDeleted) throw invalid('There is no customer message to answer.');

    // Work (model turn), not a send: the kill switch and send flag do not apply, module/path/channel/owner/epoch do.
    requireDispatch(m.db, account.id, account.ownerEpoch, { operation: 'work', actorType: 'manual' });

    const dedupeKey = `manual-draft:${conv.id}:${trigger.id}:${body.clientRequestId ?? conv.revision}`;
    const already = m.db.prepare('SELECT id FROM care_jobs WHERE account_id = ? AND dedupe_key = ?').get(account.id, dedupeKey) as { id: string } | undefined;
    const job = m.stores.jobs.enqueueJob({
      accountId: account.id,
      jobType: 'inbound_turn',
      conversationId: conv.id,
      dedupeKey,
      payload: {
        accountId: account.id,
        conversationId: conv.id,
        messageId: trigger.id,
        sentAtMs: trigger.sentAtMs,
        trigger: 'manual',
        requestedBy: ctx.actor,
        contextRevision: conv.revision,
      },
      ownerEpoch: account.ownerEpoch,
    });
    const dto: CareDraftRequestDto = { jobId: job.id, conversationId: conv.id, triggerMessageId: trigger.id, duplicate: Boolean(already) };
    return c.json(dto, 202);
  });

  // ── draft review ────────────────────────────────────────────────────────────────────────────
  const draftOf = (id: string): OutboxIntentRecord => {
    const intent = ctx.model().stores.outbox.getIntent(id);
    if (!intent || !ctx.canReadSource(intent.accountId)) throw notFound();
    return intent;
  };

  sub.get('/drafts', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const statusRaw = q.status ?? 'draft';
    const statuses = statusRaw.split(',').filter(Boolean);
    if (statuses.length === 0 || statuses.some((s) => !(OUTBOX_STATUSES as readonly string[]).includes(s))) {
      throw invalid("Query parameter 'status' has an unsupported value.");
    }
    if (q.account && !m.accountExists(q.account)) throw notFound();
    const items = m.stores.outbox
      .listIntents({
        accountId: q.account || undefined,
        conversationId: q.conversation || undefined,
        statuses: statuses as OutboxStatus[],
        limit: intParam(q.limit, 'limit', { min: 1, max: 200, fallback: 50 }),
      })
      .filter((i) => ctx.canReadSource(i.accountId))
      .map(toDraftDto);
    return c.json({ items });
  });

  /**
   * Every delivery intent of a conversation (drafts, pending, sent, failed...), whoever created it: this tab, another one,
   * the agent. Newest first, no message text: the UI keeps its delivery chips across reloads and can
   * attach one to its message through `messageId` / `replyToMessageId`.
   */
  sub.get('/conversations/:id/outbox', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const conv = m.getConversationDto(idParam(c.req.param('id')));
    if (!conv) throw notFound();
    let statuses: OutboxStatus[] | undefined;
    if (q.status) {
      const list = q.status.split(',').filter(Boolean);
      if (list.length === 0 || list.some((s) => !(OUTBOX_STATUSES as readonly string[]).includes(s))) {
        throw invalid("Query parameter 'status' has an unsupported value.");
      }
      statuses = list as OutboxStatus[];
    }
    const items: CareConversationOutboxItemDto[] = m.stores.outbox
      .listIntents({ conversationId: conv.id, statuses, limit: intParam(q.limit, 'limit', { min: 1, max: 200, fallback: 100 }) })
      .map((i) => ({
        ...toCareOutboxDto(i),
        actor: i.actor,
        purpose: i.purpose,
        channel: i.channel,
        payloadRevision: i.payloadRevision,
        replyToMessageId: i.replyMessageId,
        attemptCount: i.attemptCount,
        sentAtMs: i.sentAtMs,
      }));
    return c.json({ items });
  });

  sub.get('/drafts/:id', (c) => c.json(toDraftDto(draftOf(idParam(c.req.param('id'))))));

  /**
   * Edit text / recipients of a draft. The target (account, conversation, channel) never changes. The result carries the NEW
   * `payloadRevision` and drops any approval: the UI approves exactly that revision. A stale `expectedRevision` is a 409 with
   * `currentRevision`; an edit that changes nothing leaves the revision alone.
   */
  sub.patch('/drafts/:id', async (c) => {
    const m = ctx.model();
    const outbox = ctx.outbox;
    if (!outbox) throw new ApiError('UNSUPPORTED_CAPABILITY', 501, 'Draft editing is not enabled yet.');
    const intent = draftOf(idParam(c.req.param('id')));
    const { expectedRevision, currentContextRevision, replyToMessageId, ...fields } = await parseBody(c, editSchema);
    if (Object.keys(fields).length === 0 && replyToMessageId === undefined) throw invalid('Nothing to update.');
    if (expectedRevision !== intent.payloadRevision) {
      throw new ApiError('STALE_REVISION', 409, undefined, { currentRevision: intent.payloadRevision });
    }

    const p = intent.payload;
    let replyNative: string | undefined = p.target.replyToMessageId;
    if (replyToMessageId === null) replyNative = undefined;
    else if (replyToMessageId !== undefined) {
      if (!intent.conversationId) throw new ApiError('INVALID_TARGET', 400, 'This draft has no conversation to quote from.');
      replyNative = m.messageInConversation(intent.conversationId, replyToMessageId).nativeMessageId;
    }

    let content: OutboxContent;
    let changed = replyNative !== p.target.replyToMessageId;
    const differs = (next: unknown, prev: unknown): boolean => next !== undefined && JSON.stringify(next) !== JSON.stringify(prev);
    if (p.kind === 'chat') {
      if (fields.to || fields.cc || fields.bcc || fields.subject || fields.inReplyToHeader) {
        throw new ApiError('INVALID_TARGET', 400, 'Chat drafts cannot carry email recipients, subject or BCC.');
      }
      if (fields.topicId !== undefined) throw new ApiError('INVALID_TARGET', 400, 'topicId is not valid for this channel.');
      changed ||= differs(fields.text, p.text) || differs(fields.topicId, p.target.topicId);
      content = {
        kind: 'chat',
        text: fields.text ?? p.text,
        ...(fields.topicId ?? p.target.topicId ? { topicId: fields.topicId ?? p.target.topicId } : {}),
        ...(replyNative ? { replyToNativeMessageId: replyNative } : {}),
      };
    } else {
      if (fields.topicId !== undefined) throw new ApiError('INVALID_TARGET', 400, 'topicId is not valid for email.');
      changed ||=
        differs(fields.text, p.text) || differs(fields.to, p.target.to) || differs(fields.cc, p.target.cc ?? []) ||
        differs(fields.bcc, p.bcc ?? []) || differs(fields.subject, p.target.subject) || differs(fields.inReplyToHeader, p.target.inReplyToHeader);
      const cc = fields.cc ?? p.target.cc;
      const bcc = fields.bcc ?? p.bcc;
      content = {
        kind: 'email',
        text: fields.text ?? p.text,
        to: fields.to ?? p.target.to,
        ...(cc?.length ? { cc } : {}),
        ...(bcc?.length ? { bcc } : {}),
        subject: fields.subject ?? p.target.subject,
        ...(replyNative ? { replyToNativeMessageId: replyNative } : {}),
        ...((fields.inReplyToHeader ?? p.target.inReplyToHeader) ? { inReplyToHeader: fields.inReplyToHeader ?? p.target.inReplyToHeader } : {}),
      };
    }
    if (!changed && currentContextRevision === undefined) return c.json(toDraftDto(intent));
    return c.json(toDraftDto(outbox.editDraft(intent.id, { expectedRevision, content, contextRevision: currentContextRevision })));
  });

  sub.post('/drafts/:id/approve', async (c) => {
    const id = idParam(c.req.param('id'));
    const m = ctx.model();
    const intent = draftOf(id);
    const body = await parseBody(c, approveSchema);
    const account = m.stores.accounts.getAccount(intent.accountId);
    if (!account) throw notFound();
    // Approving makes the draft deliverable: ask the dispatch gate exactly as the sender will.
    requireDispatch(m.db, account.id, account.ownerEpoch, { operation: 'send', actorType: 'manual' });
    const approved = m.stores.outbox.approve(intent.id, {
      expectedRevision: body.expectedRevision,
      approvedBy: ctx.actor,
      currentContextRevision: body.currentContextRevision,
      nowMs: ctx.now(),
    });
    return c.json(toDraftDto(approved));
  });

  sub.post('/drafts/:id/discard', async (c) => {
    const id = idParam(c.req.param('id'));
    const m = ctx.model();
    const intent = draftOf(id);
    await parseBody(c, z.object({}).strict());
    return c.json(toDraftDto(m.stores.outbox.discard(intent.id, ctx.now())));
  });

  // ── runs / activity ─────────────────────────────────────────────────────────────────────────
  /** Accounts whose read gate is open: the only ones a run or delivery row may come from. */
  const readableAccountIds = (): string[] => ctx.model().stores.accounts.listAccounts().filter((a) => ctx.canReadSource(a.id)).map((a) => a.id);
  const inList = (ids: string[]): string => `(${ids.map(() => '?').join(',')})`;

  sub.get('/runs', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const status = q.status ?? '';
    if (status && !(AGENT_RUN_STATUSES as readonly string[]).includes(status)) throw invalid("Query parameter 'status' has an unsupported value.");
    const limit = intParam(q.limit, 'limit', { min: 1, max: 200, fallback: 50 });
    const cursor = decodeCursor(q.cursor);
    const accounts = readableAccountIds();
    if (q.account && !accounts.includes(q.account)) throw notFound();
    const scope = q.account ? [q.account] : accounts;
    if (scope.length === 0) return c.json({ items: [], nextCursor: null });

    const conds = [`account_id IN ${inList(scope)}`];
    const params: unknown[] = [...scope];
    if (q.conversation) {
      conds.push('conversation_id = ?');
      params.push(q.conversation);
    }
    if (status) {
      conds.push('status = ?');
      params.push(status);
    }
    if (cursor) {
      conds.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.ms, cursor.ms, cursor.id);
    }
    const rows = m.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM care_agent_runs WHERE ${conds.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit + 1) as RunRow[];
    const page = rows.slice(0, limit);
    const items: CareRunDto[] = page.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      conversationId: r.conversation_id,
      triggerMessageId: r.trigger_message_id,
      status: r.status,
      skipReason: r.skip_reason,
      mode: r.mode,
      agentId: r.agent_id,
      triggerKind: r.trigger_kind,
      policyRevision: r.policy_revision,
      draftRef: r.draft_ref,
      modelCalled: r.model_called === 1,
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      costUsd: Number(r.cost_usd),
      createdAtMs: Number(r.created_at),
      updatedAtMs: Number(r.updated_at),
    }));
    const last = page[page.length - 1];
    return c.json({ items, nextCursor: rows.length > limit && last ? encodeCursor(Number(last.created_at), last.id) : null });
  });

  /** Skip reasons and delivery status in one feed, newest first. Creation time orders both so an item never moves. */
  sub.get('/activity', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const limit = intParam(q.limit, 'limit', { min: 1, max: 200, fallback: 50 });
    const cursor = decodeCursor(q.cursor);
    const accounts = readableAccountIds();
    if (q.account && !accounts.includes(q.account)) throw notFound();
    const scope = q.account ? [q.account] : accounts;
    if (scope.length === 0) return c.json({ items: [], nextCursor: null });

    const build = (extra: string[], extraParams: unknown[]): { where: string; params: unknown[] } => {
      const conds = [`account_id IN ${inList(scope)}`, ...extra];
      const params: unknown[] = [...scope, ...extraParams];
      if (cursor) {
        conds.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(cursor.ms, cursor.ms, cursor.id);
      }
      return { where: conds.join(' AND '), params };
    };
    const convFilter = q.conversation ? ['conversation_id = ?'] : [];
    const convParams = q.conversation ? [q.conversation] : [];

    const runs = build(convFilter, convParams);
    const runRows = m.db
      .prepare(`SELECT id, account_id, conversation_id, status, skip_reason, mode, trigger_kind, draft_ref, created_at FROM care_agent_runs WHERE ${runs.where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...runs.params, limit + 1) as Array<Record<string, any>>;
    const deliveries = build(convFilter, convParams);
    const deliveryRows = m.db
      .prepare(`SELECT id, account_id, conversation_id, status, status_reason, last_error_code, actor, receipt_level, created_at FROM care_delivery_intents WHERE ${deliveries.where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...deliveries.params, limit + 1) as Array<Record<string, any>>;

    const merged: CareActivityItemDto[] = [
      ...runRows.map(
        (r): CareActivityItemDto => ({
          kind: 'run',
          atMs: Number(r.created_at),
          id: r.id,
          accountId: r.account_id,
          conversationId: r.conversation_id,
          status: r.status,
          skipReason: r.skip_reason,
          mode: r.mode,
          triggerKind: r.trigger_kind,
          draftRef: r.draft_ref,
        }),
      ),
      ...deliveryRows.map(
        (r): CareActivityItemDto => ({
          kind: 'delivery',
          atMs: Number(r.created_at),
          id: r.id,
          accountId: r.account_id,
          conversationId: r.conversation_id,
          status: r.status,
          statusReason: r.status_reason ?? r.last_error_code ?? null,
          actor: r.actor,
          receiptLevel: r.receipt_level,
        }),
      ),
    ].sort((a, b) => b.atMs - a.atMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const page = merged.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({ items: page, nextCursor: merged.length > limit && last ? encodeCursor(last.atMs, last.id) : null });
  });
}
