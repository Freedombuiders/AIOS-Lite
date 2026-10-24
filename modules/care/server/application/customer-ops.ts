/**
 * CC-18 customer operations: identity link / unlink with preview, and the merged customer timeline.
 *
 * Principles (AC-017, AC-033):
 *  - A link is an IDENTITY MEMBERSHIP operation. No message is ever moved, copied or rewritten, and no two
 *    customers are merged automatically: the caller names the identities (or customers) and the target.
 *  - Same native IDs on two accounts are two different identities (the key is account + namespace + ID);
 *    nothing here ever matches by name or native ID.
 *  - Every link / unlink runs in ONE immediate transaction with explicit expected customer revisions
 *    (stale -> 409) and writes an audit row plus a care event per involved account.
 *  - Profiles keep their per-source origin scope (`account_id`) and simply follow the identity. Customer
 *    attributes are single slots, so a conflicting field needs an EXPLICIT customer-wide choice and a source
 *    customer's own value is never overwritten.
 *  - Unlink replays the membership history: identities go back to their previous customers, together with the
 *    profiles / tasks / conversation pointers recorded as moved from them. Customer-wide items that have no
 *    recorded source (created after the link) need an explicit decision; without one the unlink is rejected
 *    with the typed `UndecidedItemsError` and nothing is written. Nothing is deleted or duplicated.
 *  - The timeline is derived from memberships at read time and every source is filtered through the injected
 *    read gate per account, so unlink can never widen what is visible and a closed gate stays closed.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import {
  decodeTimelineCursor,
  encodeTimelineCursor,
  type CareChannel,
  type CareCustomerRecord,
  type CareIdentityRecord,
  type CareMessageRecord,
} from '../../../_lib/care-kit/types.js';
import type { CareStores } from '../persistence/index.js';
import type { CareProfileRecord, CareTaskRecord } from '../persistence/misc-stores.js';
import type { MoveEntityType } from '../persistence/audit-store.js';

export const CUSTOMER_FIELDS = ['displayName', 'company', 'phone', 'email', 'stage', 'tags', 'owner'] as const;
export type CustomerField = (typeof CUSTOMER_FIELDS)[number];

/** The customer-wide value to keep for one attribute. Never applied to a source customer. */
export type FieldResolution = { keep: 'target' } | { fromCustomerId: string } | { value: string | null };

export interface LinkSelection {
  identityIds?: string[];
  customerIds?: string[];
  /** Required to link; for a preview it defaults to the oldest involved customer (reported as suggested). */
  targetCustomerId?: string;
}

export interface LinkRequest extends LinkSelection {
  targetCustomerId: string;
  /** Required for the target and for every source customer that loses an identity. */
  expectedRevisions: Record<string, number>;
  resolutions?: Partial<Record<CustomerField, FieldResolution>>;
  /**
   * Caller's explicit statement that every conflicting field without its own resolution keeps the target's
   * value. Without it, an unresolved conflict rejects the link (the UI default is a visible choice, not a guess).
   */
  keepTargetForUnresolved?: boolean;
  /** Idempotency key: the same request replays the stored result; a different payload is a 409. */
  requestId?: string;
  /** Free-text label of who acted. Not an authorization identity. */
  actor?: string;
}

export interface FieldConflict {
  field: CustomerField;
  values: Array<{ customerId: string; value: string }>;
}

export interface ProfileConflict {
  /** Origin scope: an account ID, or null for the customer-wide profile. */
  scope: string | null;
  kind: 'note' | 'need';
  key?: string;
  profileIds: string[];
  /** Informational: every row survives with its origin scope; nothing is overwritten. */
  resolution: 'kept_separate';
}

export interface LinkPreview {
  targetCustomerId: string;
  suggestedTarget: boolean;
  /** Nothing would move (every selected identity already belongs to the target). */
  noop: boolean;
  people: Array<{
    customerId: string;
    role: 'target' | 'source';
    displayName: string;
    revision: number;
    movingIdentityIds: string[];
  }>;
  identities: Array<{
    identityId: string;
    customerId: string;
    accountId: string;
    channel: CareChannel;
    namespace: string;
    displayName: string | null;
    moving: boolean;
  }>;
  accounts: Array<{ accountId: string; channel: CareChannel; label: string }>;
  channels: CareChannel[];
  conflicts: FieldConflict[];
  profileConflicts: ProfileConflict[];
  moves: { profiles: number; tasks: number; conversations: number };
  /** The revisions a link request has to send back. */
  expectedRevisions: Record<string, number>;
}

export interface LinkResult {
  applied: boolean;
  linkEventId: string | null;
  targetCustomerId: string;
  movedIdentityIds: string[];
  moved: { profiles: number; tasks: number; conversations: number };
  /** True when a stored result was returned for a repeated requestId. */
  replayed?: boolean;
}

export interface UnlinkRequest {
  identityIds: string[];
  expectedRevisions: Record<string, number>;
  /** itemKey ("task:<id>" / "profile:<id>") -> customer that keeps it. Needed for items with no recorded source. */
  decisions?: Record<string, string>;
  requestId?: string;
  actor?: string;
}

export interface UndecidedItem {
  itemKey: string;
  type: 'task' | 'profile' | 'field';
  id: string;
  accountId: string | null;
  /** Customers that may keep it. */
  candidateCustomerIds: string[];
}

export interface UnlinkResult {
  applied: boolean;
  linkEventId: string | null;
  fromCustomerId: string | null;
  restored: Array<{ identityId: string; customerId: string }>;
  returned: { profiles: number; tasks: number; conversations: number };
  decided: number;
  replayed?: boolean;
}

export interface TimelineItem {
  messageId: string;
  conversationId: string;
  accountId: string;
  channel: CareChannel;
  direction: CareMessageRecord['direction'];
  senderRole: CareMessageRecord['senderRole'];
  senderIdentityId: string | null;
  text: string;
  origin: CareMessageRecord['origin'];
  sentAtMs: number;
  /** A reply to this item opens exactly this conversation (never another online channel). */
  replyTarget: { conversationId: string; accountId: string };
}

export interface TimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
}

/** A link / unlink the caller must complete with explicit choices. Nothing was written. */
export class UndecidedItemsError extends CareError {
  public readonly items: UndecidedItem[];
  constructor(message: string, items: UndecidedItem[]) {
    super('CONFIGURATION_CONFLICT', message, 409, { reason: 'UNDECIDED_ITEMS', items });
    this.name = 'UndecidedItemsError';
    this.items = items;
    Object.setPrototypeOf(this, UndecidedItemsError.prototype);
  }
}

export interface CustomerOpsOptions {
  /** Read gate per source account. Fail-closed: there is no default. */
  canReadSource: (accountId: string) => boolean;
}

interface LinkContext {
  target: CareCustomerRecord;
  suggested: boolean;
  /** Source customers (those that lose at least one identity), in a stable order. */
  sources: CareCustomerRecord[];
  moving: CareIdentityRecord[];
  /** Every selected identity (moving or already on the target). */
  selected: CareIdentityRecord[];
}

interface MovePlan {
  profiles: CareProfileRecord[];
  tasks: CareTaskRecord[];
  conversations: Array<{ id: string; accountId: string }>;
}

type EntityRef = { type: MoveEntityType; id: string; accountId: string | null };

interface UnlinkPlan {
  pending: Array<{ identity: CareIdentityRecord; previousCustomerId: string; linkEventId: string }>;
  target: CareCustomerRecord;
  previous: CareCustomerRecord[];
  involved: CareCustomerRecord[];
  previousIds: string[];
  unlinkIds: Set<string>;
  linkEventIds: string[];
  returns: Array<EntityRef & { to: string }>;
  undecided: UndecidedItem[];
  decided: number;
}

export interface UnlinkPreviewAnalysis {
  noop: boolean;
  undecided: UndecidedItem[];
  returned: { profiles: number; tasks: number; conversations: number };
  decided: number;
}

function countReturned(returns: ReadonlyArray<{ type: MoveEntityType }>): UnlinkPreviewAnalysis['returned'] {
  const returned = { profiles: 0, tasks: 0, conversations: 0 };
  for (const r of returns) {
    if (r.type === 'profile') returned.profiles += 1;
    else if (r.type === 'task') returned.tasks += 1;
    else returned.conversations += 1;
  }
  return returned;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hashPayload(kind: string, payload: unknown): string {
  return crypto.createHash('sha256').update(kind).update('\0').update(canonicalJson(payload)).digest('hex');
}

function fieldValue(customer: CareCustomerRecord, field: CustomerField): string | null {
  const v = customer[field];
  return v === undefined || v === null || v === '' ? null : String(v);
}

function normalizedValue(field: CustomerField, value: string): string {
  return field === 'stage' ? value : value.trim().toLowerCase();
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export class CareCustomerOps {
  private readonly canReadSource: (accountId: string) => boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly stores: CareStores,
    opts: CustomerOpsOptions,
  ) {
    if (typeof opts?.canReadSource !== 'function') {
      throw new CareError('INVALID_COMMAND', 'canReadSource gate is required', 500);
    }
    this.canReadSource = opts.canReadSource;
  }

  // ── preview ────────────────────────────────────────────────────────────────────────────

  /** Pure read: who / which channels and accounts are involved and which fields conflict. Writes nothing. */
  previewLink(selection: LinkSelection): LinkPreview {
    const run = this.db.transaction(() => {
      const ctx = this.resolveSelection(selection);
      const plans = this.planAllMoves(ctx);
      const involved = [ctx.target, ...ctx.sources];

      const people = involved.map((c) => ({
        customerId: c.id,
        role: c.id === ctx.target.id ? ('target' as const) : ('source' as const),
        displayName: c.displayName,
        revision: c.revision,
        movingIdentityIds: ctx.moving.filter((i) => i.customerId === c.id).map((i) => i.id),
      }));
      const accountIds = uniqueSorted(ctx.selected.map((i) => i.accountId));
      const accounts = accountIds.map((id) => {
        const a = this.stores.accounts.getAccount(id)!;
        return { accountId: id, channel: a.channel, label: a.label };
      });
      const revisions: Record<string, number> = {};
      for (const c of involved) revisions[c.id] = c.revision;

      return {
        targetCustomerId: ctx.target.id,
        suggestedTarget: ctx.suggested,
        noop: ctx.moving.length === 0,
        people,
        identities: ctx.selected.map((i) => ({
          identityId: i.id,
          customerId: i.customerId,
          accountId: i.accountId,
          channel: accounts.find((a) => a.accountId === i.accountId)!.channel,
          namespace: i.namespace,
          displayName: i.displayName,
          moving: i.customerId !== ctx.target.id,
        })),
        accounts,
        channels: uniqueSorted(accounts.map((a) => a.channel)) as CareChannel[],
        conflicts: this.fieldConflicts(involved),
        profileConflicts: this.profileConflicts(involved),
        moves: {
          profiles: plans.reduce((n, p) => n + p.profiles.length, 0),
          tasks: plans.reduce((n, p) => n + p.tasks.length, 0),
          conversations: plans.reduce((n, p) => n + p.conversations.length, 0),
        },
        expectedRevisions: revisions,
      } satisfies LinkPreview;
    });
    return run.deferred();
  }

  // ── link ───────────────────────────────────────────────────────────────────────────────

  link(req: LinkRequest): LinkResult {
    const payload = {
      identityIds: uniqueSorted(req.identityIds ?? []),
      customerIds: uniqueSorted(req.customerIds ?? []),
      targetCustomerId: req.targetCustomerId,
      expectedRevisions: req.expectedRevisions,
      resolutions: req.resolutions ?? {},
      keepTargetForUnresolved: req.keepTargetForUnresolved === true,
    };
    const payloadHash = hashPayload('link', payload);
    const run = this.db.transaction((): LinkResult => {
      const replay = this.replay<LinkResult>(req.requestId, 'link', payloadHash);
      if (replay) return { ...replay, replayed: true };

      if (!req.targetCustomerId) {
        throw new CareError('INVALID_COMMAND', 'targetCustomerId is required to link', 400);
      }
      const ctx = this.resolveSelection(req);

      // Idempotent re-link: everything selected is already on the target. Checked before revisions so a
      // retried request does not fail on the revision bump its first run produced.
      if (ctx.moving.length === 0) {
        return {
          applied: false,
          linkEventId: null,
          targetCustomerId: ctx.target.id,
          movedIdentityIds: [],
          moved: { profiles: 0, tasks: 0, conversations: 0 },
        };
      }

      const involved = [ctx.target, ...ctx.sources];
      for (const c of involved) this.requireExpected(req.expectedRevisions, c);

      const conflicts = this.fieldConflicts(involved);
      const resolutions = req.resolutions ?? {};
      const undecided = conflicts
        .filter((c) => resolutions[c.field] === undefined && req.keepTargetForUnresolved !== true)
        .map<UndecidedItem>((c) => ({
          itemKey: `field:${c.field}`,
          type: 'field',
          id: c.field,
          accountId: null,
          candidateCustomerIds: c.values.map((v) => v.customerId),
        }));
      if (undecided.length > 0) {
        throw new UndecidedItemsError('Conflicting customer fields need an explicit customer-wide choice', undecided);
      }
      const { patch, changes } = this.buildFieldPatch(ctx, resolutions);

      const plans = this.planAllMoves(ctx);
      const linkEventId = crypto.randomUUID();
      const audit = this.stores.audit;
      const revisions: Record<string, [number, number]> = {};

      // Customers first: the revision compare-and-set fails the whole transaction early.
      for (const c of involved) {
        const next = this.stores.customers.updateCustomer(c.id, c.id === ctx.target.id ? patch : {}, req.expectedRevisions[c.id]);
        revisions[c.id] = [c.revision, next.revision];
      }

      // Baseline: what the target already owned, so an unlink can tell it apart from later additions.
      for (const p of this.stores.profiles.getProfilesByCustomer(ctx.target.id)) {
        audit.addMove({ linkEventId, entityType: 'profile', entityId: p.id, kind: 'baseline', fromCustomerId: ctx.target.id, toCustomerId: ctx.target.id });
      }
      for (const t of this.stores.tasks.listTasksByCustomer(ctx.target.id)) {
        audit.addMove({ linkEventId, entityType: 'task', entityId: t.id, kind: 'baseline', fromCustomerId: ctx.target.id, toCustomerId: ctx.target.id });
      }

      // The audit row first: history rows reference it.
      const moved = { profiles: 0, tasks: 0, conversations: 0 };
      for (const plan of plans) {
        moved.profiles += plan.profiles.length;
        moved.tasks += plan.tasks.length;
        moved.conversations += plan.conversations.length;
      }
      const accountIds = uniqueSorted(ctx.selected.map((i) => i.accountId));
      audit.insertLinkEvent({
        id: linkEventId,
        kind: 'link',
        requestId: req.requestId ?? null,
        payloadHash,
        targetCustomerId: ctx.target.id,
        actor: req.actor ?? null,
        refs: {
          identityIds: ctx.moving.map((i) => i.id).sort(),
          sourceCustomerIds: ctx.sources.map((c) => c.id),
          accountIds,
          moved,
          fields: changes.map((c) => c.field),
        },
        revisions,
      });

      for (const c of changes) {
        audit.addFieldChange({
          linkEventId,
          customerId: ctx.target.id,
          field: c.field,
          sourceCustomerId: c.sourceCustomerId,
          previousValue: c.previous,
          appliedValue: c.applied,
        });
      }

      for (const identity of ctx.moving) {
        this.stores.identities.linkIdentity(identity.id, ctx.target.id);
        audit.addMembership({
          linkEventId,
          identityId: identity.id,
          fromCustomerId: identity.customerId,
          toCustomerId: ctx.target.id,
          kind: 'link',
        });
      }
      ctx.sources.forEach((source, idx) => {
        this.applyMoves(linkEventId, plans[idx], source.id, ctx.target.id);
      });

      this.appendEvents(linkEventId, 'customer.linked', accountIds);
      return {
        applied: true,
        linkEventId,
        targetCustomerId: ctx.target.id,
        movedIdentityIds: ctx.moving.map((i) => i.id).sort(),
        moved,
      };
    });
    return run.immediate();
  }

  // ── unlink ─────────────────────────────────────────────────────────────────────────────

  /**
   * The READ-ONLY decision of an unlink: which customer every identity returns to and where every item
   * currently on the target goes. Shared by `unlink` (which then applies it) and `previewUnlink` (which only
   * reports it), so the preview cannot drift from the operation. Writes nothing. `null` = nothing to undo.
   * Must run inside the caller's transaction so the snapshot it reads is the one that is applied.
   */
  private planUnlink(
    req: Pick<UnlinkRequest, 'identityIds' | 'expectedRevisions' | 'decisions'>,
    requireRevisions: boolean,
  ): UnlinkPlan | null {
    if (!Array.isArray(req.identityIds) || req.identityIds.length === 0) {
      throw new CareError('INVALID_COMMAND', 'identityIds is required to unlink', 400);
    }
    const audit = this.stores.audit;
    const identities: CareIdentityRecord[] = [];
    for (const id of uniqueSorted(req.identityIds)) {
      const identity = this.stores.identities.getIdentity(id);
      if (!identity) throw new CareError('NOT_FOUND', `Identity not found: ${id}`, 404);
      identities.push(identity);
    }

    // Only identities whose latest membership change is a link into their current customer are undone.
    const pending: Array<{ identity: CareIdentityRecord; previousCustomerId: string; linkEventId: string }> = [];
    for (const identity of identities) {
      const last = audit.latestMembership(identity.id);
      if (!last) throw new CareError('INVALID_TARGET', `Identity was never linked: ${identity.id}`, 409);
      if (last.kind === 'unlink' || last.toCustomerId !== identity.customerId) continue; // already restored: idempotent
      pending.push({ identity, previousCustomerId: last.fromCustomerId, linkEventId: last.linkEventId });
    }
    if (pending.length === 0) {
      return null;
    }
    const targetIds = uniqueSorted(pending.map((p) => p.identity.customerId));
    if (targetIds.length !== 1) {
      throw new CareError('INVALID_TARGET', 'Unlink identities of one linked customer at a time', 400);
    }
    const targetId = targetIds[0];
    const target = this.stores.customers.getCustomer(targetId)!;

    const previousIds = uniqueSorted(pending.map((p) => p.previousCustomerId));
    const previous: CareCustomerRecord[] = [];
    for (const id of previousIds) {
      const c = this.stores.customers.getCustomer(id);
      if (!c) throw new CareError('INVALID_TARGET', `Source customer no longer exists: ${id}`, 409);
      if (c.id === targetId) throw new CareError('INVALID_TARGET', 'Identity cannot be unlinked into the customer it is on', 409);
      previous.push(c);
    }
    const involved = [target, ...previous];
    if (requireRevisions) for (const c of involved) this.requireExpected(req.expectedRevisions, c);

    const unlinkIds = new Set(pending.map((p) => p.identity.id));
    const linkEventIds = uniqueSorted(pending.map((p) => p.linkEventId));

    // Identities each customer holds once the unlink is done.
    const accountsAfter = new Map<string, Set<string>>();
    const remainingFrom = new Map<string, number>(); // source customer -> identities still on the target that came from it
    const targetAfter = this.stores.identities.listIdentitiesByCustomer(targetId).filter((i) => !unlinkIds.has(i.id));
    for (const i of targetAfter) {
      const m = audit.latestMembership(i.id);
      if (m && m.kind === 'link' && m.toCustomerId === targetId) {
        remainingFrom.set(m.fromCustomerId, (remainingFrom.get(m.fromCustomerId) ?? 0) + 1);
      }
    }
    for (const c of previous) {
      const set = new Set(this.stores.identities.listIdentitiesByCustomer(c.id).map((i) => i.accountId));
      for (const p of pending) if (p.previousCustomerId === c.id) set.add(p.identity.accountId);
      accountsAfter.set(c.id, set);
    }
    const targetAccountsAfter = new Set(targetAfter.map((i) => i.accountId));
    const previousSet = new Set(previousIds);
    const fullyRestored = (customerId: string) => (remainingFrom.get(customerId) ?? 0) === 0;

    // Decide where every item currently on the target goes.
    const returns: Array<EntityRef & { to: string }> = [];
    const undecided: UndecidedItem[] = [];
    const candidates = [targetId, ...previousIds];
    const classify = (ref: EntityRef): { to: string } | { undecided: true } | null => {
      const mv = audit.latestMove(ref.type, ref.id);
      if (mv && mv.toCustomerId === targetId) {
        if (previousSet.has(mv.fromCustomerId)) {
          const s = mv.fromCustomerId;
          const comes = ref.accountId === null ? fullyRestored(s) : accountsAfter.get(s)!.has(ref.accountId) || fullyRestored(s);
          return comes ? { to: s } : null;
        }
        return null; // came from a customer that stays linked
      }
      if (ref.type !== 'conversation' && linkEventIds.some((l) => audit.hasBaseline(l, ref.type, ref.id))) return null; // the target's own
      // Created after the link, no recorded source.
      if (ref.accountId === null) return ref.type === 'conversation' ? null : { undecided: true };
      const holders = previousIds.filter((s) => accountsAfter.get(s)!.has(ref.accountId!));
      if (holders.length === 0) return null;
      if (holders.length === 1 && !targetAccountsAfter.has(ref.accountId)) return { to: holders[0] };
      return ref.type === 'conversation' ? null : { undecided: true };
    };

    const refs: EntityRef[] = [
      ...this.stores.profiles.getProfilesByCustomer(targetId).map((p) => ({ type: 'profile' as const, id: p.id, accountId: p.accountId })),
      ...this.stores.tasks.listTasksByCustomer(targetId).map((t) => ({ type: 'task' as const, id: t.id, accountId: audit.taskAccountId(t.id) })),
      ...audit.listPrimaryConversations(targetId).map((c) => ({ type: 'conversation' as const, id: c.id, accountId: c.accountId })),
    ];
    const decisions = req.decisions ?? {};
    let decided = 0;
    const undecidedKeys = new Set<string>();
    for (const ref of refs) {
      const outcome = classify(ref);
      if (!outcome) continue;
      if ('undecided' in outcome) {
        const itemKey = `${ref.type}:${ref.id}`;
        const choice = decisions[itemKey];
        if (choice === undefined) {
          undecided.push({ itemKey, type: ref.type as 'task' | 'profile', id: ref.id, accountId: ref.accountId, candidateCustomerIds: candidates });
        } else {
          if (!candidates.includes(choice)) {
            throw new CareError('INVALID_COMMAND', `Decision for ${itemKey} must name the target or a restored customer`, 400);
          }
          undecidedKeys.add(itemKey);
          decided += 1;
          if (choice !== targetId) returns.push({ ...ref, to: choice });
        }
      } else {
        returns.push({ ...ref, to: outcome.to });
      }
    }
    for (const key of Object.keys(decisions)) {
      if (!undecidedKeys.has(key) && !undecided.some((u) => u.itemKey === key)) {
        throw new CareError('INVALID_COMMAND', `Decision names an item that needs no decision: ${key}`, 400);
      }
    }
    return { pending, target, previous, involved, previousIds, unlinkIds, linkEventIds, returns, undecided, decided };
  }

  /**
   * Read-only analysis of an unlink for the confirmation dialog: the undecided customer-wide items (with the
   * candidates a decision may name), what would be returned, and how many `decisions` entries were accepted.
   * Does not check revisions, writes nothing, audits nothing and announces nothing.
   */
  previewUnlink(req: { identityIds: string[]; decisions?: Record<string, string> }): UnlinkPreviewAnalysis {
    const run = this.db.transaction((): UnlinkPreviewAnalysis => {
      const plan = this.planUnlink({ identityIds: req.identityIds, expectedRevisions: {}, decisions: req.decisions }, false);
      if (!plan) return { noop: true, undecided: [], returned: { profiles: 0, tasks: 0, conversations: 0 }, decided: 0 };
      return { noop: false, undecided: plan.undecided, returned: countReturned(plan.returns), decided: plan.decided };
    });
    return run.deferred();
  }

  unlink(req: UnlinkRequest): UnlinkResult {
    const payload = {
      identityIds: uniqueSorted(req.identityIds ?? []),
      expectedRevisions: req.expectedRevisions,
      decisions: req.decisions ?? {},
    };
    const payloadHash = hashPayload('unlink', payload);
    const run = this.db.transaction((): UnlinkResult => {
      const replay = this.replay<UnlinkResult>(req.requestId, 'unlink', payloadHash);
      if (replay) return { ...replay, replayed: true };

      const plan = this.planUnlink(req, true);
      if (!plan) {
        return { applied: false, linkEventId: null, fromCustomerId: null, restored: [], returned: { profiles: 0, tasks: 0, conversations: 0 }, decided: 0 };
      }
      if (plan.undecided.length > 0) {
        throw new UndecidedItemsError('Customer-wide notes/tasks without a source need an explicit choice before unlinking', plan.undecided);
      }
      const { pending, target, involved, previousIds, unlinkIds, linkEventIds, returns, decided } = plan;
      const targetId = target.id;
      const audit = this.stores.audit;

      // Apply. Customers first (revision compare-and-set).
      const settle = this.planFieldRestores(target, linkEventIds, unlinkIds);
      const linkEventId = crypto.randomUUID();
      const revisions: Record<string, [number, number]> = {};
      for (const c of involved) {
        const next = this.stores.customers.updateCustomer(c.id, c.id === targetId ? settle.patch : {}, req.expectedRevisions[c.id]);
        revisions[c.id] = [c.revision, next.revision];
      }
      const accountIds = uniqueSorted(pending.map((p) => p.identity.accountId));
      const returned = countReturned(returns);
      audit.insertLinkEvent({
        id: linkEventId,
        kind: 'unlink',
        requestId: req.requestId ?? null,
        payloadHash,
        targetCustomerId: targetId,
        actor: req.actor ?? null,
        refs: {
          identityIds: pending.map((p) => p.identity.id).sort(),
          restoredTo: previousIds,
          accountIds,
          returned,
          decided,
          unlinkedLinkEvents: linkEventIds,
        },
        revisions,
      });

      const restored: UnlinkResult['restored'] = [];
      for (const p of pending) {
        this.stores.identities.linkIdentity(p.identity.id, p.previousCustomerId);
        audit.addMembership({ linkEventId, identityId: p.identity.id, fromCustomerId: targetId, toCustomerId: p.previousCustomerId, kind: 'unlink' });
        restored.push({ identityId: p.identity.id, customerId: p.previousCustomerId });
      }
      for (const r of returns) this.moveOne(linkEventId, r, targetId, r.to);
      for (const s of settle.settled) audit.settleFieldChange(s.seq, s.outcome);

      this.appendEvents(linkEventId, 'customer.unlinked', accountIds);
      return { applied: true, linkEventId, fromCustomerId: targetId, restored, returned, decided };
    });
    return run.immediate();
  }

  // ── timeline ───────────────────────────────────────────────────────────────────────────

  /**
   * Merged, cursor-paginated timeline of the customer across every linked conversation, newest first.
   * Sources whose read gate is closed contribute nothing (no rows, no counts). Groups / topics contribute
   * only the customer's own messages; direct / email threads contribute the whole conversation.
   */
  customerTimeline(customerId: string, opts: { limit?: number; cursor?: string | null } = {}): TimelinePage {
    if (!this.stores.customers.getCustomer(customerId)) {
      throw new CareError('NOT_FOUND', `Customer not found: ${customerId}`, 404);
    }
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 1, 1), 200);
    let before: { sentAtMs: number; id: string } | undefined;
    if (opts.cursor) {
      const decoded = decodeTimelineCursor(opts.cursor);
      if (!decoded) throw new CareError('INVALID_CURSOR', 'Invalid timeline cursor', 400);
      before = { sentAtMs: decoded.sentAtMs, id: decoded.messageId };
    }
    const accountIds = this.stores.audit.customerSourceAccounts(customerId).filter((a) => this.safeCanRead(a));
    const rows = this.stores.audit.timelineMessageIds({ customerId, accountIds, limit: limit + 1, before });
    const page = rows.slice(0, limit);
    const channelOf = new Map<string, CareChannel>();
    const items: TimelineItem[] = [];
    for (const row of page) {
      const m = this.stores.messages.getMessage(row.id);
      if (!m) continue;
      let channel = channelOf.get(m.accountId);
      if (!channel) {
        channel = this.stores.accounts.getAccount(m.accountId)!.channel;
        channelOf.set(m.accountId, channel);
      }
      items.push({
        messageId: m.id,
        conversationId: m.conversationId,
        accountId: m.accountId,
        channel,
        direction: m.direction,
        senderRole: m.senderRole,
        senderIdentityId: m.senderIdentityId,
        text: m.text,
        origin: m.origin,
        sentAtMs: m.sentAtMs,
        replyTarget: { conversationId: m.conversationId, accountId: m.accountId },
      });
    }
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? encodeTimelineCursor({ sentAtMs: last.sentAtMs, messageId: last.id }) : null;
    return { items, nextCursor };
  }

  /**
   * Where a reply started from the customer timeline goes: the ORIGINAL conversation of the message (or the
   * named conversation), never another channel that happens to be online. Unreadable sources and
   * conversations that are not part of the customer's timeline look like "not found".
   */
  resolveReplyTarget(customerId: string, ref: { messageId?: string; conversationId?: string }): { conversationId: string; accountId: string; channel: CareChannel } {
    let conversationId = ref.conversationId;
    if (ref.messageId) {
      const m = this.stores.messages.getMessage(ref.messageId);
      if (!m) throw new CareError('NOT_FOUND', 'Message not found', 404);
      if (conversationId && conversationId !== m.conversationId) {
        throw new CareError('INVALID_TARGET', 'Message does not belong to that conversation', 400);
      }
      conversationId = m.conversationId;
    }
    if (!conversationId) throw new CareError('INVALID_COMMAND', 'messageId or conversationId is required', 400);
    const conv = this.stores.conversations.getConversation(conversationId);
    if (
      !conv ||
      !this.safeCanRead(conv.accountId) ||
      !this.stores.audit.conversationBelongsToCustomer(conv.id, customerId) ||
      (ref.messageId && !this.messageInTimeline(customerId, ref.messageId))
    ) {
      throw new CareError('NOT_FOUND', 'Conversation not found', 404);
    }
    return { conversationId: conv.id, accountId: conv.accountId, channel: this.stores.accounts.getAccount(conv.accountId)!.channel };
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────

  private safeCanRead(accountId: string): boolean {
    try {
      return this.canReadSource(accountId) === true;
    } catch {
      return false; // a broken gate is a closed gate
    }
  }

  private messageInTimeline(customerId: string, messageId: string): boolean {
    const m = this.stores.messages.getMessage(messageId);
    if (!m || m.isDeleted || !this.safeCanRead(m.accountId)) return false;
    return this.stores.audit.timelineMessageIds({ customerId, accountIds: [m.accountId], limit: 1, messageId }).length > 0;
  }

  private replay<T>(requestId: string | undefined, kind: 'link' | 'unlink', payloadHash: string): T | null {
    if (!requestId) return null;
    const prior = this.stores.audit.findLinkEventByRequest(requestId);
    if (!prior) return null;
    if (prior.kind !== kind || prior.payloadHash !== payloadHash) {
      throw new CareError('DUPLICATE_REQUEST_PAYLOAD_MISMATCH', 'requestId was already used for a different request', 409);
    }
    const refs = prior.refs as any;
    if (kind === 'link') {
      return {
        applied: true,
        linkEventId: prior.id,
        targetCustomerId: prior.targetCustomerId,
        movedIdentityIds: refs.identityIds ?? [],
        moved: refs.moved ?? { profiles: 0, tasks: 0, conversations: 0 },
      } as T;
    }
    const restoredTo = new Map<string, string>();
    for (const m of this.stores.audit.listMembershipsForEvent(prior.id)) restoredTo.set(m.identityId, m.toCustomerId);
    return {
      applied: true,
      linkEventId: prior.id,
      fromCustomerId: prior.targetCustomerId,
      restored: [...restoredTo].map(([identityId, customerId]) => ({ identityId, customerId })),
      returned: refs.returned ?? { profiles: 0, tasks: 0, conversations: 0 },
      decided: refs.decided ?? 0,
    } as T;
  }

  private requireExpected(expected: Record<string, number> | undefined, customer: CareCustomerRecord): void {
    const value = expected?.[customer.id];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new CareError('INVALID_COMMAND', `expectedRevisions is required for customer ${customer.id}`, 400);
    }
    if (value !== customer.revision) {
      throw new CareError(
        'STALE_REVISION',
        `Customer revision mismatch for ${customer.id}. Expected ${value}, but found ${customer.revision}`,
        409,
        { customerId: customer.id, currentRevision: customer.revision },
      );
    }
  }

  private resolveSelection(selection: LinkSelection): LinkContext {
    const selected = new Map<string, CareIdentityRecord>();
    for (const id of selection.identityIds ?? []) {
      const identity = this.stores.identities.getIdentity(id);
      if (!identity) throw new CareError('NOT_FOUND', `Identity not found: ${id}`, 404);
      selected.set(identity.id, identity);
    }
    for (const id of selection.customerIds ?? []) {
      if (!this.stores.customers.getCustomer(id)) throw new CareError('NOT_FOUND', `Customer not found: ${id}`, 404);
      for (const identity of this.stores.identities.listIdentitiesByCustomer(id)) selected.set(identity.id, identity);
    }
    let target: CareCustomerRecord | null = null;
    let suggested = false;
    if (selection.targetCustomerId) {
      target = this.stores.customers.getCustomer(selection.targetCustomerId);
      if (!target) throw new CareError('NOT_FOUND', `Customer not found: ${selection.targetCustomerId}`, 404);
    }
    if (selected.size === 0) {
      throw new CareError('INVALID_COMMAND', 'Select at least one identity or customer that has identities', 400);
    }
    if (!target) {
      const owners = uniqueSorted([...selected.values()].map((i) => i.customerId)).map((id) => this.stores.customers.getCustomer(id)!);
      owners.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1));
      target = owners[0];
      suggested = true;
    }
    const all = [...selected.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const moving = all.filter((i) => i.customerId !== target!.id);
    const sources = uniqueSorted(moving.map((i) => i.customerId)).map((id) => this.stores.customers.getCustomer(id)!);
    return { target, suggested, sources, moving, selected: all };
  }

  private fieldConflicts(customers: CareCustomerRecord[]): FieldConflict[] {
    const out: FieldConflict[] = [];
    for (const field of CUSTOMER_FIELDS) {
      const values = customers.flatMap((c) => {
        const v = fieldValue(c, field);
        return v === null ? [] : [{ customerId: c.id, value: v }];
      });
      if (new Set(values.map((v) => normalizedValue(field, v.value))).size > 1) out.push({ field, values });
    }
    return out;
  }

  /** Informational: same-scope care profiles of different customers that disagree. Nothing is overwritten. */
  private profileConflicts(customers: CareCustomerRecord[]): ProfileConflict[] {
    const byScope = new Map<string, CareProfileRecord[]>();
    for (const c of customers) {
      for (const p of this.stores.profiles.getProfilesByCustomer(c.id)) {
        const key = p.accountId ?? '';
        byScope.set(key, [...(byScope.get(key) ?? []), p]);
      }
    }
    const out: ProfileConflict[] = [];
    for (const [scopeKey, rows] of [...byScope].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (new Set(rows.map((r) => r.customerId)).size < 2) continue;
      const scope = scopeKey === '' ? null : scopeKey;
      const notes = rows.filter((r) => r.note && r.note.trim());
      if (new Set(notes.map((r) => r.note!.trim())).size > 1) {
        out.push({ scope, kind: 'note', profileIds: notes.map((r) => r.id).sort(), resolution: 'kept_separate' });
      }
      const keys = uniqueSorted(rows.flatMap((r) => Object.keys(r.need ?? {})));
      for (const key of keys) {
        const withKey = rows.filter((r) => r.need && key in r.need);
        if (new Set(withKey.map((r) => JSON.stringify(r.need![key]))).size > 1) {
          out.push({ scope, kind: 'need', key, profileIds: withKey.map((r) => r.id).sort(), resolution: 'kept_separate' });
        }
      }
    }
    return out;
  }

  private buildFieldPatch(
    ctx: LinkContext,
    resolutions: Partial<Record<CustomerField, FieldResolution>>,
  ): {
    patch: Partial<Omit<CareCustomerRecord, 'id' | 'createdAtMs' | 'updatedAtMs' | 'revision'>>;
    changes: Array<{ field: CustomerField; sourceCustomerId: string | null; previous: string | null; applied: string | null }>;
  } {
    const patch: Record<string, unknown> = {};
    const changes: Array<{ field: CustomerField; sourceCustomerId: string | null; previous: string | null; applied: string | null }> = [];
    const involved = new Map([ctx.target, ...ctx.sources].map((c) => [c.id, c]));
    for (const [field, resolution] of Object.entries(resolutions) as Array<[CustomerField, FieldResolution]>) {
      if (!(CUSTOMER_FIELDS as readonly string[]).includes(field)) {
        throw new CareError('INVALID_COMMAND', `Unknown customer field: ${field}`, 400);
      }
      if (!resolution || typeof resolution !== 'object') {
        throw new CareError('INVALID_COMMAND', `Invalid resolution for ${field}`, 400);
      }
      if ('keep' in resolution) {
        if (resolution.keep !== 'target') throw new CareError('INVALID_COMMAND', `Invalid resolution for ${field}`, 400);
        continue;
      }
      let applied: string | null;
      let sourceCustomerId: string | null = null;
      if ('fromCustomerId' in resolution) {
        const from = involved.get(resolution.fromCustomerId);
        if (!from) throw new CareError('INVALID_COMMAND', `Resolution for ${field} must name an involved customer`, 400);
        applied = fieldValue(from, field);
        if (applied === null) throw new CareError('INVALID_COMMAND', `Customer ${from.id} has no ${field} to choose`, 400);
        sourceCustomerId = from.id;
      } else {
        applied = resolution.value === undefined || resolution.value === '' ? null : resolution.value;
      }
      const previous = fieldValue(ctx.target, field);
      if (previous === applied) continue;
      if (applied === null && (field === 'displayName' || field === 'stage')) {
        throw new CareError('INVALID_COMMAND', `${field} cannot be cleared`, 400);
      }
      patch[field] = applied;
      changes.push({ field, sourceCustomerId, previous, applied });
    }
    return { patch: patch as any, changes };
  }

  /** What each source gives up for this link (one plan per source, aligned with `ctx.sources`). */
  private planAllMoves(ctx: LinkContext): MovePlan[] {
    return ctx.sources.map((source) => {
      const moving = ctx.moving.filter((i) => i.customerId === source.id);
      const movingIds = new Set(moving.map((i) => i.id));
      const remaining = this.stores.identities.listIdentitiesByCustomer(source.id).filter((i) => !movingIds.has(i.id));
      const movedAccounts = new Set(moving.map((i) => i.accountId));
      const remainingAccounts = new Set(remaining.map((i) => i.accountId));
      const emptied = remaining.length === 0;
      const goes = (accountId: string | null) =>
        emptied || (accountId !== null && movedAccounts.has(accountId) && !remainingAccounts.has(accountId));
      return {
        profiles: this.stores.profiles.getProfilesByCustomer(source.id).filter((p) => goes(p.accountId)),
        tasks: this.stores.tasks.listTasksByCustomer(source.id).filter((t) => goes(this.stores.audit.taskAccountId(t.id))),
        conversations: this.stores.audit.listPrimaryConversations(source.id).filter((c) => goes(c.accountId)),
      };
    });
  }

  private applyMoves(linkEventId: string, plan: MovePlan, fromId: string, toId: string): void {
    for (const p of plan.profiles) this.moveOne(linkEventId, { type: 'profile', id: p.id, accountId: p.accountId }, fromId, toId);
    for (const t of plan.tasks) this.moveOne(linkEventId, { type: 'task', id: t.id, accountId: null }, fromId, toId);
    for (const c of plan.conversations) this.moveOne(linkEventId, { type: 'conversation', id: c.id, accountId: c.accountId }, fromId, toId);
  }

  private moveOne(linkEventId: string, ref: EntityRef, fromId: string, toId: string): void {
    if (fromId === toId) return;
    const audit = this.stores.audit;
    if (ref.type === 'profile') audit.reassignProfile(ref.id, toId);
    else if (ref.type === 'task') audit.reassignTask(ref.id, toId);
    else this.stores.conversations.setPrimaryCustomer(ref.id, toId);
    audit.addMove({ linkEventId, entityType: ref.type, entityId: ref.id, kind: 'move', fromCustomerId: fromId, toCustomerId: toId });
  }

  /**
   * An explicit customer-wide choice is undone once no identity of the link event that made it stays on the
   * target. The previous value comes back only if nobody edited the field since (otherwise the edit wins).
   */
  private planFieldRestores(
    target: CareCustomerRecord,
    linkEventIds: string[],
    unlinkIds: Set<string>,
  ): {
    patch: Partial<Omit<CareCustomerRecord, 'id' | 'createdAtMs' | 'updatedAtMs' | 'revision'>>;
    settled: Array<{ seq: number; outcome: 'restored' | 'kept_edited' }>;
  } {
    const audit = this.stores.audit;
    const patch: Record<string, unknown> = {};
    const settled: Array<{ seq: number; outcome: 'restored' | 'kept_edited' }> = [];
    for (const linkEventId of linkEventIds) {
      const stillLinked = audit
        .listMembershipsForEvent(linkEventId)
        .some((m) => m.kind === 'link' && audit.latestMembership(m.identityId)?.seq === m.seq && !unlinkIds.has(m.identityId));
      if (stillLinked) continue;
      for (const change of audit.listOpenFieldChanges(linkEventId)) {
        const field = change.field as CustomerField;
        if (fieldValue(target, field) === change.appliedValue) {
          patch[field] = change.previousValue;
          settled.push({ seq: change.seq, outcome: 'restored' });
        } else {
          settled.push({ seq: change.seq, outcome: 'kept_edited' });
        }
      }
    }
    return { patch: patch as any, settled };
  }

  private appendEvents(linkEventId: string, eventType: string, accountIds: string[]): void {
    for (const accountId of accountIds) {
      this.stores.events.appendEvent({
        eventId: `care-link:${linkEventId}:${accountId}`,
        accountId,
        eventType,
        payload: { kind: eventType === 'customer.linked' ? 'link' : 'unlink' },
      });
    }
  }
}
