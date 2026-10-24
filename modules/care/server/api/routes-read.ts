/**
 * Read routes + the simple local writes (seen marker) of /api/m/care (CC-07).
 * Reply/outbox: routes-reply.ts. Event stream: routes-events.ts.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { CareAccountDto, CareStatusDto } from './dto.js';
import type { CareAccountDeliveryDto } from './dto-inbox.js';
import { CARE_STAGES } from '../../../_lib/care-kit/validation.js';
import { capability, invalid, notFound } from './errors.js';
import { parseBody, parseChannel, type CareApiContext } from './context.js';
import { LIMITS } from './read-model.js';
import { boolParam, decodeCursor, idParam, intParam, optionalMsParam } from './util.js';

const KINDS = ['direct', 'group', 'topic', 'email_thread'] as const;
const STAGES = ['new', 'consulting', 'quoted', 'deposit', 'won', 'lost'] as const;
const WF_STATUSES = ['open', 'pending', 'snoozed', 'done'] as const;
const VIEWS = ['me', 'ai', 'none', 'all'] as const;

function enumParam<T extends string>(raw: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!(allowed as readonly string[]).includes(raw)) throw invalid(`Query parameter '${name}' has an unsupported value.`);
  return raw as T;
}

function textParam(raw: string | undefined, name: string, max = 200): string | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t.length === 0) return undefined;
  if (t.length > max) throw invalid(`Query parameter '${name}' is too long.`);
  return t;
}

const readSchema = z.object({ messageId: z.string().min(1).max(256).optional(), account: z.string().min(1).max(256).optional() }).strict();

export function registerReadRoutes(sub: Hono, ctx: CareApiContext): void {
  /** How a reply typed in the inbox is delivered for this account: the core port, or not at all. */
  function deliveryOf(a: CareAccountDto): CareAccountDeliveryDto {
    return { replyVia: ctx.replyPort && a.writeOwner === 'core' ? 'core' : 'none', attachments: false, sendQuota: null };
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────────────────────
  sub.get('/status', (c) => {
    const m = ctx.model();
    const body = m.read((): CareStatusDto => {
      const counts = m.conversationCounts({});
      return {
        ok: true,
        eventSeq: m.latestEventSeq(),
        accounts: m.accountCounts(),
        conversations: counts,
        replyEnabled: Boolean(ctx.replyPort),
        conversationStatuses: m.conversationStatuses(),
        customerStages: [...CARE_STAGES],
      };
    });
    return c.json(body);
  });

  sub.get('/accounts', (c) => {
    const m = ctx.model();
    return c.json({
      items: m.read(() =>
        m.listAccounts().map((a) => ({ ...a, signature: ctx.signatureOf(m.stores.accounts.getAccount(a.id)), delivery: deliveryOf(a) })),
      ),
    });
  });

  // ── inbox ───────────────────────────────────────────────────────────────────────────────────
  sub.get('/conversations', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const accountId = textParam(q.account, 'account', 256);
    if (accountId && !m.accountExists(accountId)) throw notFound();
    const customerId = textParam(q.customer, 'customer', 256);
    const result = m.listConversations(
      {
        channel: parseChannel(q.channel),
        accountId,
        kind: enumParam(q.kind, KINDS, 'kind'),
        waiting: boolParam(q.waiting),
        unread: boolParam(q.unread),
        careStatus: textParam(q.status, 'status', 64),
        wf: enumParam(q.wf, WF_STATUSES, 'wf'),
        view: enumParam(q.view, VIEWS, 'view'),
        stage: enumParam(q.stage, STAGES, 'stage'),
        customerId,
        q: textParam(q.q, 'q'),
      },
      q.cursor,
      intParam(q.limit, 'limit', { min: 1, max: LIMITS.pageMax, fallback: 50 }),
    );
    return c.json(result);
  });

  sub.get('/conversations/:id', (c) => {
    const m = ctx.model();
    const dto = m.read(() => m.getConversationDto(idParam(c.req.param('id'))));
    const account = textParam(c.req.query('account'), 'account', 256);
    // Asking for a conversation through the wrong account reads exactly like a missing one.
    if (!dto || (account && dto.accountId !== account)) throw notFound();
    return c.json({ ...dto, signature: ctx.signatureOf(m.stores.accounts.getAccount(dto.accountId)) });
  });

  sub.get('/conversations/:id/messages', (c) => {
    const m = ctx.model();
    const id = idParam(c.req.param('id'));
    const q = c.req.query();
    const conv = m.getConversationDto(id);
    const account = textParam(q.account, 'account', 256);
    if (!conv || (account && conv.accountId !== account)) throw notFound();
    if (q.before) decodeCursor(q.before);
    if (q.after) decodeCursor(q.after);
    const page = m.messagePage(id, {
      limit: intParam(q.limit, 'limit', { min: 1, max: LIMITS.pageMax, fallback: 50 }),
      before: q.before || undefined,
      after: q.after || undefined,
      around: q.around ? idParam(q.around, 'around') : undefined,
    });
    return c.json(page);
  });

  /** Dashboard-only "seen". Never touches waiting_since, care status or the provider read marker. */
  sub.post('/conversations/:id/read', async (c) => {
    const m = ctx.model();
    const id = idParam(c.req.param('id'));
    const body = await parseBody(c, readSchema);
    const conv = m.getConversationDto(id);
    if (!conv || (body.account && conv.accountId !== body.account)) throw notFound();
    const target = body.messageId ?? conv.lastMessageId;
    if (target) {
      m.messageInConversation(id, target); // 404 unless it belongs to THIS conversation
      m.stores.conversations.markLocalSeen(id, target);
    }
    return c.json(m.getConversationDto(id));
  });

  // ── search ──────────────────────────────────────────────────────────────────────────────────
  sub.get('/search', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const text = textParam(q.q, 'q');
    if (!text || text.length < 2) throw invalid("Query parameter 'q' needs at least 2 characters.");
    const field = enumParam(q.field, ['body', 'metadata', 'all'] as const, 'field') ?? 'all';
    const result = m.search({
      q: text,
      field,
      accountId: textParam(q.account, 'account', 256),
      conversationId: textParam(q.conversation, 'conversation', 256),
      fromMs: optionalMsParam(q.from, 'from'),
      toMs: optionalMsParam(q.to, 'to'),
      limit: intParam(q.limit, 'limit', { min: 1, max: 100, fallback: 20 }),
      budget: intParam(q.budget, 'budget', { min: 50, max: LIMITS.searchCandidatesMax, fallback: LIMITS.searchCandidatesDefault }),
      cursor: decodeCursor(q.cursor),
    });
    return c.json(result);
  });

  // ── customers ───────────────────────────────────────────────────────────────────────────────
  sub.get('/customers', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const result = m.listCustomers(
      { stage: enumParam(q.stage, STAGES, 'stage'), q: textParam(q.q, 'q') },
      q.cursor,
      intParam(q.limit, 'limit', { min: 1, max: LIMITS.pageMax, fallback: 50 }),
    );
    return c.json(result);
  });

  sub.get('/customers/:id', (c) => {
    const m = ctx.model();
    const dto = m.getCustomerDetail(idParam(c.req.param('id')));
    if (!dto) throw notFound();
    return c.json(dto);
  });
}
