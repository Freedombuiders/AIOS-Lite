/**
 * Inbox v2 routes: status / assignee / AI mode / take-over per conversation, internal
 * notes and canned replies. Thin over `CareWorkflowService` (workflow/index.ts), which owns every rule.
 *
 * Every conversation route answers 404 for a missing or unreadable conversation (the existence check and the read gate
 * go through the read model).
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import { noteConversationId } from '../workflow/store.js';
import type { CareConversationDto } from './dto.js';
import { invalid, notFound } from './errors.js';
import { parseBody, type CareApiContext } from './context.js';
import { idParam } from './util.js';

const workflowSchema = z
  .object({
    action: z.enum(['done', 'reopen', 'snooze']),
    snoozeUntilMs: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
    expectedStateRevision: z.number().int().min(0).optional(),
  })
  .strict();
const assigneeSchema = z
  .object({ kind: z.enum(['owner', 'agent', 'none', 'default']), agentId: z.string().trim().min(1).max(64).optional() })
  .strict();
const aiSchema = z.object({ mode: z.enum(['off', 'draft', 'auto']) }).strict();
const takeoverSchema = z.object({ on: z.boolean() }).strict();
const noteSchema = z
  .object({ body: z.string().trim().min(1).max(4000), clientRequestId: z.string().min(1).max(128) })
  .strict();
const cannedSchema = z
  .object({
    shortcut: z.string().trim().min(1).max(33),
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(4000),
    emailBody: z.string().max(20_000).nullish(),
    sort: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export function registerWorkflowRoutes(sub: Hono, ctx: CareApiContext): void {
  // Registered before the read/reply groups, so this also gives THEIR conversation DTOs the workflow (clock).
  sub.use('*', async (_c, next) => {
    try {
      ctx.model().useWorkflowEnv({ now: () => ctx.now() });
    } catch {
      /* the handler answers the typed 503 */
    }
    await next();
  });

  /** Readable conversation; anything else is a 404. */
  function writable(id: string): void {
    if (!ctx.model().getConversationDto(id)) throw notFound();
  }

  const withSignature = (dto: CareConversationDto): CareConversationDto & { signature: string | null } => ({
    ...dto,
    signature: ctx.signatureOf(ctx.model().stores.accounts.getAccount(dto.accountId)),
  });

  sub.put('/conversations/:id/workflow', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = await parseBody(c, workflowSchema);
    if (body.action === 'snooze' && body.snoozeUntilMs === undefined) throw invalid('snoozeUntilMs is required to snooze.');
    writable(id);
    return c.json(withSignature(ctx.workflow().setStatus(id, body)));
  });

  sub.put('/conversations/:id/assignee', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = await parseBody(c, assigneeSchema);
    if (body.kind === 'agent' && !body.agentId) throw invalid('agentId is required for an agent assignment.');
    writable(id);
    return c.json(withSignature(ctx.workflow().setAssignee(id, body)));
  });

  sub.put('/conversations/:id/ai', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = await parseBody(c, aiSchema);
    writable(id);
    return c.json(withSignature(ctx.workflow().setAiMode(id, body.mode)));
  });

  sub.put('/conversations/:id/takeover', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = await parseBody(c, takeoverSchema);
    writable(id);
    return c.json(withSignature(ctx.workflow().setTakeover(id, body.on)));
  });

  // ── internal notes ──────────────────────────────────────────────────────────────────────────
  sub.get('/conversations/:id/notes', (c) => {
    const id = idParam(c.req.param('id'));
    if (!ctx.model().getConversationDto(id)) throw notFound();
    return c.json({ items: ctx.workflow().notes(id) });
  });

  sub.post('/conversations/:id/notes', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = await parseBody(c, noteSchema);
    writable(id);
    return c.json(ctx.workflow().addNote(id, body.body, body.clientRequestId), 201);
  });

  sub.delete('/notes/:id', (c) => {
    const noteId = idParam(c.req.param('id'));
    const conversationId = noteConversationId(ctx.model().db, noteId);
    if (!conversationId) throw notFound();
    writable(conversationId);
    ctx.workflow().deleteNote(noteId);
    return c.json({ ok: true });
  });

  // ── canned replies ──────────────────────────────────────────────────────────────────────────
  sub.get('/canned', (c) => c.json({ items: ctx.workflow().canned() }));

  sub.post('/canned', async (c) => {
    const body = await parseBody(c, cannedSchema);
    return c.json(ctx.workflow().saveCanned(body), 201);
  });

  sub.put('/canned/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const body = await parseBody(c, cannedSchema);
    return c.json(ctx.workflow().saveCanned({ ...body, id }));
  });

  sub.delete('/canned/:id', (c) => {
    ctx.workflow().deleteCanned(idParam(c.req.param('id')));
    return c.json({ ok: true });
  });
}
