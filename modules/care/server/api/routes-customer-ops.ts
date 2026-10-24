/**
 * Customer operations (CC-18 backend): merged timeline, identity link / unlink with preview, and the
 * per-conversation Customer 360 form (`customer-care`).
 *
 * Link / unlink are identity MEMBERSHIP operations: messages never move. Every request names the revisions the
 * operator saw (`expectedRevisions`), and the service rejects stale ones. Every source account is checked against
 * the explicit per-account read gate, so a closed source reads like a missing one. Undecided items answer
 * 409 CONFIGURATION_CONFLICT with `details.reason = UNDECIDED_ITEMS` and the IDs that need a decision.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import { CUSTOMER_FIELDS, type LinkPreview, type UnlinkResult } from '../application/customer-ops.js';
import { CareError } from '../../../_lib/care-kit/errors.js';
import type { CareCustomerRecord, CareIdentityRecord } from '../../../_lib/care-kit/types.js';
import { CARE_STAGES } from '../../../_lib/care-kit/validation.js';
import type { CareCustomerCareDto, CareCustomerCareProfileDto, CareLinkPreviewDto, CareLinkResultDto, CareTimelinePageDto, CareUnlinkPreviewDto, CareUnlinkResultDto } from './dto-ops.js';
import { ApiError, invalid, notFound } from './errors.js';
import { parseBody, type CareApiContext } from './context.js';
import { idParam, intParam } from './util.js';

const id = z.string().min(1).max(256);
const idList = z.array(id).max(200);
const revisions = z.record(id, z.number().int().min(1));
const requestId = z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/);

const resolution = z.union([
  z.object({ keep: z.literal('target') }).strict(),
  z.object({ fromCustomerId: id }).strict(),
  z.object({ value: z.string().max(2000).nullable() }).strict(),
]);

const previewSchema = z
  .object({ identityIds: idList.optional(), customerIds: idList.optional(), targetCustomerId: id.optional() })
  .strict();

const linkSchema = z
  .object({
    identityIds: idList.optional(),
    customerIds: idList.optional(),
    targetCustomerId: id,
    expectedRevisions: revisions,
    resolutions: z.partialRecord(z.enum(CUSTOMER_FIELDS), resolution).optional(),
    keepTargetForUnresolved: z.boolean().optional(),
    requestId: requestId.optional(),
  })
  .strict();

const previewUnlinkSchema = z
  .object({ identityIds: idList.min(1), decisions: z.record(z.string().min(1).max(300), id).optional() })
  .strict();

const unlinkSchema = z
  .object({
    identityIds: idList.min(1),
    expectedRevisions: revisions,
    decisions: z.record(z.string().min(1).max(300), id).optional(),
    requestId: requestId.optional(),
  })
  .strict();

const nullableText = (max: number) => z.string().max(max).nullable();
const careSchema = z
  .object({
    expectedCustomerRevision: z.number().int().min(1).optional(),
    customer: z
      .object({
        displayName: z.string().trim().min(1).max(512).optional(),
        company: nullableText(512).optional(),
        phone: nullableText(64).optional(),
        email: nullableText(320).optional(),
        stage: z.enum(CARE_STAGES as unknown as [string, ...string[]]).optional(),
        tags: nullableText(2000).optional(),
        owner: nullableText(128).optional(),
      })
      .strict()
      .optional(),
    /** 0 = "there is no profile yet"; anything else must equal the stored revision. */
    expectedProfileRevision: z.number().int().min(0).optional(),
    profile: z
      .object({ need: z.record(z.string(), z.unknown()).nullable().optional(), note: nullableText(20_000).optional() })
      .strict()
      .optional(),
  })
  .strict();

/** Provenance of the profile this API owns for a core-owned account. */
export const CANONICAL_PROFILE_PROVENANCE = 'care:customer_care';
const MAX_NEED_BYTES = 16_000;

export function registerCustomerOpsRoutes(sub: Hono, ctx: CareApiContext): void {
  /** A source behind a closed gate reads like a missing one for every identity / customer in the request. */
  const assertReadable = (identityIds: string[] = [], customerIds: string[] = []): void => {
    const m = ctx.model();
    for (const identityId of identityIds) {
      const identity = m.stores.identities.getIdentity(identityId);
      if (identity && !ctx.canReadSource(identity.accountId)) throw notFound();
    }
    for (const customerId of customerIds) {
      for (const identity of m.stores.identities.listIdentitiesByCustomer(customerId)) {
        if (!ctx.canReadSource(identity.accountId)) throw notFound();
      }
    }
  };

  sub.get('/customers/:id/timeline', (c) => {
    const ops = ctx.customerOps();
    const q = c.req.query();
    const page = ops.customerTimeline(idParam(c.req.param('id')), {
      limit: intParam(q.limit, 'limit', { min: 1, max: 200, fallback: 50 }),
      cursor: q.cursor || null,
    });
    return c.json(page satisfies CareTimelinePageDto);
  });

  sub.post('/identities/preview-link', async (c) => {
    const body = await parseBody(c, previewSchema);
    assertReadable(body.identityIds, body.customerIds);
    const preview: LinkPreview = ctx.customerOps().previewLink(body);
    return c.json(preview satisfies CareLinkPreviewDto);
  });

  sub.post('/identities/link', async (c) => {
    const body = await parseBody(c, linkSchema);
    assertReadable(body.identityIds, [...(body.customerIds ?? []), body.targetCustomerId]);
    const result = ctx.customerOps().link({ ...body, actor: ctx.actor });
    return c.json(result satisfies CareLinkResultDto);
  });

  /**
   * Read-only analysis of an unlink, mirroring what `CareCustomerOps.unlink` will decide: which customer each identity returns
   * to, the CURRENT revision of every customer involved, and the undecided customer-wide items. The undecided items and the
   * counts come from `CareCustomerOps.previewUnlink`, which shares its planning code with `unlink`, so the answer cannot
   * drift from the operation (and nothing is written, audited or announced).
   */
  interface UnlinkPlan {
    pending: Array<{ identity: CareIdentityRecord; previousCustomerId: string }>;
    linked: CareCustomerRecord | null;
    restored: CareCustomerRecord[];
    revisions: Record<string, number>;
  }
  const planUnlink = (identityIds: string[]): UnlinkPlan => {
    const m = ctx.model();
    const pending: UnlinkPlan['pending'] = [];
    for (const id of [...new Set(identityIds)].sort()) {
      const identity = m.stores.identities.getIdentity(id);
      if (!identity) throw notFound();
      const last = m.stores.audit.latestMembership(id);
      if (!last) throw new ApiError('INVALID_TARGET', 409, 'This identity was never linked.');
      if (last.kind === 'unlink' || last.toCustomerId !== identity.customerId) continue; // already restored
      pending.push({ identity, previousCustomerId: last.fromCustomerId });
    }
    const linkedIds = [...new Set(pending.map((p) => p.identity.customerId))];
    if (linkedIds.length > 1) throw new ApiError('INVALID_TARGET', 400, 'Unlink identities of one linked customer at a time.');
    const customer = (cid: string): CareCustomerRecord => {
      const c = m.stores.customers.getCustomer(cid);
      if (!c) throw new ApiError('INVALID_TARGET', 409, 'A customer this unlink restores no longer exists.');
      return c;
    };
    const linked = linkedIds.length ? customer(linkedIds[0]) : null;
    const restored = [...new Set(pending.map((p) => p.previousCustomerId))].sort().map(customer);
    const revisions: Record<string, number> = {};
    for (const c of [...(linked ? [linked] : []), ...restored]) revisions[c.id] = c.revision;
    return { pending, linked, restored, revisions };
  };

  sub.post('/identities/preview-unlink', async (c) => {
    const body = await parseBody(c, previewUnlinkSchema);
    const m = ctx.model();
    assertReadable(body.identityIds);
    const ops = ctx.customerOps();
    // One read-only snapshot for the plan and the analysis; nothing is written, audited or announced.
    const read = m.db.transaction((): CareUnlinkPreviewDto => {
      const plan = planUnlink(body.identityIds);
      assertReadable([], plan.restored.map((r) => r.id));
      const names = new Map([...(plan.linked ? [plan.linked] : []), ...plan.restored].map((cu) => [cu.id, cu.displayName]));
      const preview: CareUnlinkPreviewDto = {
        noop: plan.pending.length === 0,
        linkedCustomerId: plan.linked?.id ?? null,
        restores: plan.pending.map((p) => ({
          identityId: p.identity.id,
          accountId: p.identity.accountId,
          channel: m.stores.accounts.getAccount(p.identity.accountId)!.channel,
          namespace: p.identity.namespace,
          displayName: p.identity.displayName,
          fromCustomerId: p.identity.customerId,
          restoreToCustomerId: p.previousCustomerId,
          restoreToDisplayName: names.get(p.previousCustomerId) ?? '',
        })),
        customers: [
          ...(plan.linked ? [{ customerId: plan.linked.id, displayName: plan.linked.displayName, role: 'linked' as const, revision: plan.linked.revision }] : []),
          ...plan.restored.map((r) => ({ customerId: r.id, displayName: r.displayName, role: 'restored' as const, revision: r.revision })),
        ],
        expectedRevisions: plan.revisions,
        undecided: [],
        returned: null,
      };
      if (!preview.noop) {
        const analysis = ops.previewUnlink({ identityIds: body.identityIds, decisions: body.decisions });
        preview.undecided = analysis.undecided.map((i) => ({
          itemKey: i.itemKey,
          type: i.type,
          id: i.id,
          accountId: i.accountId,
          candidateCustomerIds: [...i.candidateCustomerIds],
        }));
        // Counts are only meaningful once every customer-wide item has a decision.
        preview.returned = analysis.undecided.length === 0 ? analysis.returned : null;
      }
      return preview;
    });
    return c.json(read.deferred());
  });

  sub.post('/identities/unlink', async (c) => {
    const body = await parseBody(c, unlinkSchema);
    assertReadable(body.identityIds);
    try {
      const result = ctx.customerOps().unlink({ ...body, actor: ctx.actor });
      return c.json(result satisfies CareUnlinkResultDto);
    } catch (err) {
      // A stale or missing revision names ALL customers this unlink needs and their current revisions, not just the first.
      const missing = err instanceof CareError && err.code === 'INVALID_COMMAND' && /^expectedRevisions is required for customer /.test(err.message);
      if (err instanceof CareError && (err.code === 'STALE_REVISION' || missing)) {
        let revisions: Record<string, number> | null = null;
        try {
          revisions = planUnlink(body.identityIds).revisions;
        } catch {
          revisions = null;
        }
        if (revisions) {
          throw new ApiError(missing ? 'INVALID_COMMAND' : 'STALE_REVISION', missing ? 400 : 409, undefined, {
            ...(typeof (err.details as { currentRevision?: unknown } | undefined)?.currentRevision === 'number'
              ? { currentRevision: (err.details as { currentRevision: number }).currentRevision }
              : {}),
            details: { reason: missing ? 'REVISIONS_REQUIRED' : 'STALE_REVISIONS', expectedRevisions: revisions },
          });
        }
      }
      throw err;
    }
  });

  // ── Customer 360 form of a conversation ─────────────────────────────────────────────────────
  const resolvePerson = (conversationId: string, participant: string | undefined) => {
    const m = ctx.model();
    const conv = m.stores.conversations.getConversation(conversationId);
    if (!conv || !ctx.canReadSource(conv.accountId)) throw notFound();
    const account = m.stores.accounts.getAccount(conv.accountId);
    if (!account) throw notFound();

    let customerId = conv.primaryCustomerId;
    let identityId: string | null = null;
    if (participant) {
      const identity = m.stores.identities.getIdentity(participant);
      // The participant must be an identity of THIS account who really belongs to THIS conversation.
      const belongs =
        identity &&
        identity.accountId === conv.accountId &&
        (conv.kind === 'group' || conv.kind === 'topic'
          ? m.stores.audit.identitySpeaksIn(identity.id, conv.id)
          : m.stores.audit.conversationBelongsToCustomer(conv.id, identity.customerId));
      if (!identity || !belongs) throw notFound();
      customerId = identity.customerId;
      identityId = identity.id;
    }
    if (!customerId) throw notFound();
    return { m, conv, account, customerId, identityId };
  };

  const careView = (conversationId: string, participant: string | undefined): CareCustomerCareDto => {
    const { m, conv, account, customerId, identityId } = resolvePerson(conversationId, participant);
    return m.read(() => {
      const customer = m.stores.customers.getCustomer(customerId);
      if (!customer) throw notFound();
      const toDto = (p: ReturnType<typeof m.stores.profiles.getProfile> & object): CareCustomerCareProfileDto => ({
        id: p.id,
        accountId: p.accountId,
        provenance: p.provenance,
        need: p.need,
        note: p.note,
        revision: p.revision,
        updatedAtMs: p.updatedAtMs,
      });
      const profiles = m.stores.profiles
        .getProfilesByCustomer(customerId)
        .filter((p) => p.accountId === null || (p.accountId === conv.accountId && ctx.canReadSource(p.accountId)));
      const editable = profiles.find((p) => p.accountId === conv.accountId && p.provenance === CANONICAL_PROFILE_PROVENANCE) ?? null;
      const tasks = m.stores.audit
        .queryTasks({ customerId })
        .filter((t) => !t.accountId || ctx.canReadSource(t.accountId))
        .map((t) => ({ id: t.id, title: t.title, dueAtMs: t.dueAtMs, done: t.done, owner: t.owner, revision: t.revision, conversationId: t.conversationId }));
      return {
        conversationId: conv.id,
        accountId: conv.accountId,
        participantIdentityId: identityId,
        customer: {
          id: customer.id,
          displayName: customer.displayName,
          company: customer.company,
          phone: customer.phone,
          email: customer.email,
          stage: customer.stage,
          tags: customer.tags,
          owner: customer.owner,
          revision: customer.revision,
        },
        profile: editable ? toDto(editable) : null,
        otherProfiles: profiles.filter((p) => p !== editable).map(toDto),
        tasks,
        writeOwner: account.writeOwner,
        writable: account.writeOwner === 'core',
      };
    });
  };

  sub.get('/conversations/:id/customer-care', (c) => {
    return c.json(careView(idParam(c.req.param('id')), c.req.query('participant') || undefined));
  });

  sub.put('/conversations/:id/customer-care', async (c) => {
    const conversationId = idParam(c.req.param('id'));
    const participant = c.req.query('participant') || undefined;
    const body = await parseBody(c, careSchema);
    if (!body.customer && !body.profile) throw invalid('Nothing to update.');
    if (body.customer && body.expectedCustomerRevision === undefined) throw invalid('expectedCustomerRevision is required with customer.');
    if (body.profile && body.expectedProfileRevision === undefined) throw invalid('expectedProfileRevision is required with profile.');
    if (body.profile?.need && Buffer.byteLength(JSON.stringify(body.profile.need)) > MAX_NEED_BYTES) throw invalid('The profile need is too large.');

    const { m, conv, account, customerId } = resolvePerson(conversationId, participant);

    m.db
      .transaction(() => {
        const customer = m.stores.customers.getCustomer(customerId);
        if (!customer) throw notFound();
        const staleCustomer = (): never => {
          throw new ApiError('STALE_REVISION', 409, undefined, { currentRevision: customer.revision, details: { reason: 'CUSTOMER_REVISION' } });
        };
        const existing = m.stores.profiles
          .getProfilesByCustomer(customerId)
          .find((p) => p.accountId === conv.accountId && p.provenance === CANONICAL_PROFILE_PROVENANCE);
        if (body.customer && body.expectedCustomerRevision !== customer.revision) staleCustomer();
        if (body.profile && body.expectedProfileRevision !== (existing?.revision ?? 0)) {
          throw new ApiError('STALE_REVISION', 409, undefined, { currentRevision: existing?.revision ?? 0, details: { reason: 'PROFILE_REVISION' } });
        }

        let touched = false;
        if (body.customer && Object.keys(body.customer).length > 0) {
          m.stores.customers.updateCustomer(customerId, body.customer as Parameters<typeof m.stores.customers.updateCustomer>[1], customer.revision);
          touched = true;
        }
        let profileRevision: number | null = null;
        if (body.profile) {
          if (!existing) {
            profileRevision = m.stores.profiles.saveProfile(
              customerId,
              { need: body.profile.need ?? null, note: body.profile.note ?? null },
              conv.accountId,
              CANONICAL_PROFILE_PROVENANCE,
            ).revision;
          } else {
            // Compare-and-set against the revision read at the top of this transaction.
            profileRevision = m.stores.profiles.updateProfile(
              existing.id,
              {
                ...(body.profile.need === undefined ? {} : { need: body.profile.need }),
                ...(body.profile.note === undefined ? {} : { note: body.profile.note }),
                provenance: CANONICAL_PROFILE_PROVENANCE,
              },
              existing.revision,
              ctx.now(),
            ).revision;
          }
          touched = true;
        }
        if (touched) {
          // Invalidate other open tabs; IDs and versions only.
          m.stores.events.appendEvent({
            eventId: `customer-care:${customerId}:${conv.accountId}:${profileRevision ?? 'c'}:${m.stores.customers.getCustomer(customerId)!.revision}`,
            accountId: conv.accountId,
            conversationId: conv.id,
            eventType: 'customer_care.updated',
            payload: { conversationId: conv.id, kind: 'customer_care' },
          });
        }
      })
      .immediate();

    return c.json(careView(conversationId, participant));
  });
}
