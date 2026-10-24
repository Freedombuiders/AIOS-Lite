/**
 * Inbox v2 delivery reads:
 *  - `GET /conversations/:id/drafts`  AI drafts of one conversation.
 *  - `GET /inline-drafts`             every pending draft across conversations, newest first.
 * Writes (reply, approve, discard, draft request, cancel) live next to their core twins in routes-reply / routes-drafts.
 * Every read honours the per-account read gate: a closed source reads exactly like "not found".
 */

import type { Hono } from 'hono';
import type { OutboxIntentRecord } from '../persistence/outbox-store.js';
import type { CareApiChannel } from './dto.js';
import type { CareInlineDraftDto } from './dto-inbox.js';
import { notFound } from './errors.js';
import type { CareApiContext } from './context.js';
import { idParam, intParam } from './util.js';

/** Core intents that wait for a person: agent drafts, and drafts held back for review. */
const CORE_PENDING = ['draft', 'needs_review'] as const;

function coreDraftDto(i: OutboxIntentRecord): CareInlineDraftDto | null {
  if (!i.conversationId) return null;
  const p = i.payload;
  return {
    id: i.id,
    conversationId: i.conversationId,
    accountId: i.accountId,
    channel: i.channel as CareApiChannel,
    source: 'core',
    agentId: i.createdBy?.startsWith('agent:') ? i.createdBy.slice('agent:'.length) : null,
    text: p.text,
    email: p.kind === 'email' ? { to: [...p.target.to], cc: [...(p.target.cc ?? [])], subject: p.target.subject } : null,
    reviewReason: i.status === 'needs_review' ? i.statusReason : null,
    status: i.status === 'needs_review' ? 'needs_review' : 'draft',
    createdAtMs: i.createdAtMs,
  };
}

const newestFirst = (a: CareInlineDraftDto, b: CareInlineDraftDto): number =>
  b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function registerInboxDeliveryRoutes(sub: Hono, ctx: CareApiContext): void {
  sub.get('/conversations/:id/drafts', (c) => {
    const m = ctx.model();
    const id = idParam(c.req.param('id'));
    const conv = m.stores.conversations.getConversation(id);
    if (!conv || !ctx.canReadSource(conv.accountId)) throw notFound();

    const items: CareInlineDraftDto[] = [];
    for (const i of m.stores.outbox.listIntents({ conversationId: id, statuses: [...CORE_PENDING], limit: 50 })) {
      const d = coreDraftDto(i);
      if (d) items.push(d);
    }
    return c.json({ items: items.sort(newestFirst) });
  });

  sub.get('/inline-drafts', (c) => {
    const m = ctx.model();
    const limit = intParam(c.req.query('limit'), 'limit', { min: 1, max: 200, fallback: 100 });
    const items: CareInlineDraftDto[] = [];
    for (const i of m.stores.outbox.listIntents({ statuses: [...CORE_PENDING], limit })) {
      const d = coreDraftDto(i);
      if (d) items.push(d);
    }
    return c.json({ items: items.filter((d) => ctx.canReadSource(d.accountId)).sort(newestFirst).slice(0, limit) });
  });
}
