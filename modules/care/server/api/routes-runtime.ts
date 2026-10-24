/**
 * Runtime control: switches and parked backlog.
 *
 *  - `PUT /runtime/switches` goes through `setRuntimeSwitch`, so turning a switch back ON parks the older backlog in the same
 *    transaction (re-enable never auto-sends it).
 *  - Releasing a held item re-enters the queue, so it asks the dispatch gate first; discarding never sends and does not.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import { CARE_CHANNELS } from '../../../_lib/care-kit/validation.js';
import { CareOwnershipStore, validateSwitchKey, type BacklogHoldStatus } from '../persistence/ownership-store.js';
import { discardHeldJob, JOB_BACKLOG_KIND, releaseHeldJob } from '../runtime/backlog.js';
import { DISPATCH_SOURCES } from '../runtime/gates.js';
import { setRuntimeSwitch } from '../runtime/switches.js';
import type { CareHoldDto, CareSwitchDto } from './dto-ops.js';
import { invalid, notFound } from './errors.js';
import { requireDispatch } from './gate.js';
import { parseBody, type CareApiContext } from './context.js';
import { idParam } from './util.js';

const switchSchema = z.object({ key: z.string().min(1).max(64), enabled: z.boolean(), reason: z.string().trim().min(1).max(500).optional() }).strict();
const HOLD_KIND = /^[a-z][a-z0-9_]{0,63}$/;
const HOLD_STATUSES: readonly BacklogHoldStatus[] = ['held', 'released', 'discarded'];

function knownSwitchKeys(): Array<{ key: string; defaultOn: boolean }> {
  return [
    { key: 'module', defaultOn: false },
    { key: 'dispatch', defaultOn: true },
    { key: 'auto_send', defaultOn: true },
    ...CARE_CHANNELS.map((c) => ({ key: `channel:${c}`, defaultOn: true })),
    ...DISPATCH_SOURCES.map((s) => ({ key: `path:${s}`, defaultOn: true })),
  ];
}

export function registerRuntimeRoutes(sub: Hono, ctx: CareApiContext): void {
  sub.get('/runtime/switches', (c) => {
    const store = new CareOwnershipStore(ctx.model().db);
    const rows = new Map(store.listSwitches().map((r) => [r.key, r]));
    const known = knownSwitchKeys();
    const keys = [...known.map((k) => k.key), ...[...rows.keys()].filter((k) => !known.some((x) => x.key === k)).sort()];
    const items: CareSwitchDto[] = keys.map((key) => {
      const row = rows.get(key);
      const defaultOn = known.find((k) => k.key === key)?.defaultOn ?? true;
      return {
        key,
        enabled: row ? row.enabled : defaultOn,
        explicit: Boolean(row),
        changedAtMs: row ? row.changedAtMs : null,
        changedBy: row ? row.changedBy : null,
        reason: row ? row.reason : null,
      };
    });
    return c.json({ items });
  });

  sub.put('/runtime/switches', async (c) => {
    const m = ctx.model();
    const body = await parseBody(c, switchSchema);
    validateSwitchKey(body.key);
    const res = setRuntimeSwitch(m.db, body.key, body.enabled, {
      actor: ctx.actor,
      reason: body.reason,
      nowMs: ctx.now(),
      extraSources: ctx.backlogSources,
    });
    return c.json({ key: res.key, previous: res.previous, enabled: res.enabled, reenabled: res.reenabled, held: res.held, atMs: res.atMs });
  });

  // ── backlog holds ───────────────────────────────────────────────────────────────────────────
  sub.get('/runtime/holds', (c) => {
    const m = ctx.model();
    const q = c.req.query();
    const status = (q.status ?? 'held') as BacklogHoldStatus;
    if (!HOLD_STATUSES.includes(status)) throw invalid("Query parameter 'status' has an unsupported value.");
    if (q.account && !m.accountExists(q.account)) throw notFound();
    const items: CareHoldDto[] = new CareOwnershipStore(m.db)
      .listHolds({ accountId: q.account || undefined, status })
      .filter((h) => ctx.canReadSource(h.accountId))
      .map((h) => ({
        itemKind: h.itemKind,
        itemId: h.itemId,
        accountId: h.accountId,
        status: h.status,
        heldAtMs: h.heldAtMs,
        reason: h.reason,
        resolvedAtMs: h.resolvedAtMs,
      }));
    return c.json({ items });
  });

  const heldItem = (kind: string, id: string) => {
    const m = ctx.model();
    if (!HOLD_KIND.test(kind)) throw invalid('Invalid hold kind.');
    const hold = new CareOwnershipStore(m.db).listHolds({ status: 'held' }).find((h) => h.itemKind === kind && h.itemId === id);
    // A resolved, unknown or closed-source hold all read as "not found".
    if (!hold || !ctx.canReadSource(hold.accountId)) throw notFound();
    return { m, hold };
  };

  sub.post('/runtime/holds/:kind/:id/release', async (c) => {
    const kind = c.req.param('kind');
    const id = idParam(c.req.param('id'));
    await parseBody(c, z.object({}).strict());
    const { m, hold } = heldItem(kind, id);
    const account = m.stores.accounts.getAccount(hold.accountId);
    if (!account) throw notFound();
    // Release puts the item back in the queue: ask the gate for the kind of action it will perform.
    const job = kind === JOB_BACKLOG_KIND ? m.stores.jobs.getJob(id) : null;
    requireDispatch(m.db, account.id, account.ownerEpoch, {
      operation: kind === JOB_BACKLOG_KIND && job?.jobType !== 'outbox_dispatch' ? 'work' : 'send',
      actorType: 'manual',
    });
    if (kind === JOB_BACKLOG_KIND) {
      const res = releaseHeldJob(m.stores, m.db, id, ctx.actor, ctx.now());
      return c.json({ released: res.released, requeuedJobId: res.requeuedJobId });
    }
    const released = new CareOwnershipStore(m.db).resolveHold(kind, id, 'released', { actor: ctx.actor, nowMs: ctx.now() });
    return c.json({ released, requeuedJobId: null });
  });

  sub.post('/runtime/holds/:kind/:id/discard', async (c) => {
    const kind = c.req.param('kind');
    const id = idParam(c.req.param('id'));
    await parseBody(c, z.object({}).strict());
    const { m } = heldItem(kind, id);
    const discarded =
      kind === JOB_BACKLOG_KIND
        ? discardHeldJob(m.db, id, ctx.actor, ctx.now())
        : new CareOwnershipStore(m.db).resolveHold(kind, id, 'discarded', { actor: ctx.actor, nowMs: ctx.now() });
    return c.json({ discarded });
  });
}
