/**
 * Assignment rules: CRUD with optimistic `configVersion`, tie/priority validation before a write is accepted, and the
 * effective-rule preview per conversation (the same walk the ingest pipeline and agent turn use, but reporting
 * conflicts instead of throwing).
 *
 * A rule that would tie with an existing one at the same tier and priority for an overlapping pool is refused
 * with 409 CONFIGURATION_CONFLICT / PRIORITY_CONFLICT: the resolver never picks between equals implicitly.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { AssignmentScope, CareAssignment, CareChannel } from '../../../_lib/care-kit/types.js';
import { CARE_ASSIGNMENT_MODES, CARE_ASSIGNMENT_SCOPES } from '../../../_lib/care-kit/validation.js';
import { previewEffectiveRule, resolvePolicy, ruleConversationKinds, type EffectiveRulePreview, type RuleResolveContext } from '../policy/index.js';
import type { CareAssignmentDto, CareEffectiveRuleDto } from './dto-ops.js';
import { ApiError, invalid, notFound } from './errors.js';
import { parseBody, parseChannel, type CareApiContext } from './context.js';
import { idParam } from './util.js';

const MAX_POLICY_BYTES = 32_000;
const text = (max: number) => z.string().min(1).max(max);

const ruleBase = {
  scope: z.enum(CARE_ASSIGNMENT_SCOPES as unknown as [AssignmentScope, ...AssignmentScope[]]),
  accountId: text(256).nullish(),
  customerId: text(256).nullish(),
  channel: z.string().max(32).nullish(),
  scopeTarget: text(1024).nullish(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(CARE_ASSIGNMENT_MODES as unknown as [string, ...string[]]),
  agentId: z.string().max(128).optional(),
  instructionsRef: z.string().max(2000).nullish(),
  policyExt: z.record(z.string(), z.unknown()).nullish(),
  /** Validate and report conflicts without writing. */
  dryRun: z.boolean().optional(),
};
const createSchema = z.object(ruleBase).strict();
const updateSchema = z.object({ ...ruleBase, expectedConfigVersion: z.number().int().min(1) }).strict();

const toDto = (a: CareAssignment): CareAssignmentDto => ({
  id: a.id,
  scope: a.scope,
  accountId: a.accountId,
  customerId: a.customerId ?? null,
  channel: a.channel ?? null,
  scopeTarget: a.scopeTarget ?? null,
  priority: a.priority,
  enabled: a.enabled,
  mode: a.mode,
  agentId: a.agentId,
  instructionsRef: a.instructionsRef ?? null,
  policyExt: a.policyExt ?? null,
  configVersion: a.configVersion,
});

const TARGETLESS: readonly AssignmentScope[] = ['global', 'channel', 'customer', 'account'];

/** The fields that decide which conversations a rule can match, normalised the way the store normalises them. */
interface RuleShape {
  id?: string;
  scope: AssignmentScope;
  accountId: string | null;
  customerId: string | null;
  channel: CareChannel | null;
  scopeTarget: string | null;
  priority: number;
  policyExt: Record<string, unknown> | null;
}

function normalizeTarget(shape: RuleShape): string | null {
  if (TARGETLESS.includes(shape.scope)) return null;
  const t = shape.scopeTarget?.trim() ?? null;
  return t && (shape.scope === 'identity' || shape.scope === 'domain') ? t.toLowerCase() : t;
}

const overlaps = (a: string | null, b: string | null): boolean => a === null || b === null || a === b;

/** Two rules tie when one conversation can match both at the same tier and priority and neither is more specific. */
export function tiesWith(candidate: RuleShape, other: CareAssignment): boolean {
  if (other.id === candidate.id) return false;
  if (other.scope !== candidate.scope) return false;
  if (other.priority !== candidate.priority) return false;
  if (!overlaps(candidate.accountId, other.accountId) || !overlaps(candidate.channel, other.channel ?? null)) return false;
  if ((candidate.customerId ?? null) !== (other.customerId ?? null)) return false;
  const otherShape: RuleShape = { ...candidate, scopeTarget: other.scopeTarget ?? null };
  if (normalizeTarget(candidate) !== normalizeTarget(otherShape)) return false;
  const mine = ruleConversationKinds(candidate.policyExt);
  const theirs = ruleConversationKinds(other.policyExt);
  // A kind-restricted rule is more specific than an unrestricted one and decides first: no tie.
  if ((mine === null) !== (theirs === null)) return false;
  if (mine && theirs) return mine.some((k) => theirs.includes(k));
  return true;
}

export function registerRuleRoutes(sub: Hono, ctx: CareApiContext): void {
  const visible = (a: CareAssignment): boolean => !a.accountId || ctx.canReadSource(a.accountId);

  sub.get('/assignments', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const scope = q.scope ? (CARE_ASSIGNMENT_SCOPES.includes(q.scope as AssignmentScope) ? (q.scope as AssignmentScope) : null) : undefined;
    if (scope === null) throw invalid('Query parameter \'scope\' has an unsupported value.');
    if (q.account && !m.accountExists(q.account)) throw notFound();
    const items = m.stores.assignments
      .listAssignments({ accountId: q.account || undefined, channel: parseChannel(q.channel), customerId: q.customer || undefined, scope })
      .filter(visible)
      .map(toDto);
    return c.json({ items });
  });

  sub.get('/assignments/:id', (c) => {
    const a = ctx.model().stores.assignments.getAssignment(idParam(c.req.param('id')));
    if (!a || !visible(a)) throw notFound();
    return c.json(toDto(a));
  });

  const write = (id: string | null, body: z.infer<typeof createSchema>, expectedConfigVersion: number | undefined) => {
    const m = ctx.model();
    const channel = parseChannel(body.channel ?? undefined) ?? null;
    if (body.accountId && !ctx.canReadSource(body.accountId)) throw notFound();
    const account = body.accountId ? m.stores.accounts.getAccount(body.accountId) : null;
    if (body.accountId && !account) throw notFound();
    if (body.policyExt && Buffer.byteLength(JSON.stringify(body.policyExt)) > MAX_POLICY_BYTES) throw invalid('The policy extension is too large.');
    if (body.policyExt) {
      const { warnings } = resolvePolicy({ policyExt: body.policyExt }, account?.channel ?? channel ?? 'zalo');
      if (warnings.length > 0) {
        throw new ApiError('INVALID_COMMAND', 400, 'The policy extension is invalid.', { details: { reason: 'INVALID_POLICY_EXT', warnings } });
      }
    }
    const shape: RuleShape = {
      id: id ?? undefined,
      scope: body.scope,
      accountId: body.accountId ?? null,
      customerId: body.customerId ?? null,
      channel,
      scopeTarget: body.scopeTarget ?? null,
      priority: body.priority ?? 100,
      policyExt: body.policyExt ?? null,
    };

    return m.db
      .transaction(() => {
        const existing = id ? m.stores.assignments.getAssignment(id) : null;
        if (id) {
          if (!existing || !visible(existing)) throw notFound();
          if (existing.configVersion !== expectedConfigVersion) {
            throw new ApiError('STALE_REVISION', 409, undefined, { currentRevision: existing.configVersion });
          }
        }
        const ties = m.stores.assignments.listAssignments().filter((o) => tiesWith(shape, o)).map((o) => o.id).sort();
        if (ties.length > 0) {
          throw new ApiError('CONFIGURATION_CONFLICT', 409, 'Another rule has the same priority for the same conversations. Change the priority.', {
            details: { reason: 'PRIORITY_CONFLICT', tier: body.scope, priority: shape.priority, assignmentIds: ties },
          });
        }
        if (body.dryRun) return { saved: null, dryRun: true as const };
        const saved = m.stores.assignments.upsertAssignment({
          id: id ?? undefined,
          scope: body.scope,
          accountId: shape.accountId,
          customerId: shape.customerId,
          channel,
          scopeTarget: shape.scopeTarget,
          priority: shape.priority,
          enabled: body.enabled !== false,
          mode: body.mode as CareAssignment['mode'],
          agentId: body.agentId,
          instructionsRef: body.instructionsRef ?? null,
          policyExt: body.policyExt ?? null,
          ...(expectedConfigVersion !== undefined ? { expectedConfigVersion } : {}),
        });
        return { saved, dryRun: false as const };
      })
      .immediate();
  };

  sub.post('/assignments', async (c) => {
    const body = await parseBody(c, createSchema);
    const res = write(null, body, undefined);
    return res.dryRun ? c.json({ ok: true, dryRun: true, conflicts: [] }) : c.json(toDto(res.saved!), 201);
  });

  sub.put('/assignments/:id', async (c) => {
    const id = idParam(c.req.param('id'));
    const { expectedConfigVersion, ...body } = await parseBody(c, updateSchema);
    const res = write(id, body, expectedConfigVersion);
    return res.dryRun ? c.json({ ok: true, dryRun: true, conflicts: [] }) : c.json(toDto(res.saved!));
  });

  sub.delete('/assignments/:id', (c) => {
    const m = ctx.model();
    const id = idParam(c.req.param('id'));
    const raw = c.req.query('expectedConfigVersion');
    if (!raw || !/^\d{1,9}$/.test(raw)) throw invalid("Query parameter 'expectedConfigVersion' is required.");
    m.db
      .transaction(() => {
        const existing = m.stores.assignments.getAssignment(id);
        if (!existing || !visible(existing)) throw notFound();
        if (existing.configVersion !== Number(raw)) throw new ApiError('STALE_REVISION', 409, undefined, { currentRevision: existing.configVersion });
        m.stores.assignments.deleteAssignment(id);
      })
      .immediate();
    return c.json({ ok: true });
  });

  // ── effective rule per conversation ─────────────────────────────────────────────────────────
  sub.get('/conversations/:id/effective-rule', (c) => {
    const m = ctx.model();
    const conv = m.stores.conversations.getConversation(idParam(c.req.param('id')));
    if (!conv || !ctx.canReadSource(conv.accountId)) throw notFound();
    const account = m.stores.accounts.getAccount(conv.accountId);
    if (!account) throw notFound();

    const lastCustomer = m.stores.messages.listMessages(conv.id, { limit: 20 }).find((x) => x.direction === 'in' && x.senderRole === 'customer');
    const sender = lastCustomer?.senderIdentityId ? m.stores.identities.getIdentity(lastCustomer.senderIdentityId) : null;
    const emailFrom = lastCustomer?.metadata.type === 'email' ? lastCustomer.metadata.from : null;
    const rctx: RuleResolveContext = {
      accountId: account.id,
      channel: account.channel,
      conversationKey: conv.externalKey,
      conversationKind: conv.kind,
      customerId: sender?.customerId ?? conv.primaryCustomerId,
      identityKey: sender?.externalIdentityId ?? null,
      emailSender: account.channel === 'email' ? emailFrom ?? sender?.externalIdentityId ?? null : null,
    };
    const preview: EffectiveRulePreview = previewEffectiveRule(m.stores.assignments.listAssignments(account.id), rctx);
    const dto: CareEffectiveRuleDto = {
      outcome: preview.outcome,
      ...(preview.rule
        ? {
            rule: {
              assignmentId: preview.rule.assignmentId,
              tier: preview.rule.tier,
              viaKindPredicate: preview.rule.viaKindPredicate,
              enabled: preview.rule.enabled,
              mode: preview.rule.mode,
              agentId: preview.rule.agentId,
              priority: preview.rule.priority,
              configVersion: preview.rule.configVersion,
              policyRevision: preview.rule.policyRevision,
              policy: preview.rule.policy as unknown as Record<string, unknown>,
            },
          }
        : {}),
      ...(preview.conflict ? { conflict: preview.conflict } : {}),
      trace: preview.trace,
      warnings: preview.warnings,
    };
    return c.json(dto);
  });
}
