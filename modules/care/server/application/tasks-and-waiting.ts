/**
 * CC-19 tasks, owner label and waiting metrics.
 *
 * Tasks (on top of CareTaskStore + the scope/source metadata of the audit store):
 *  - scope is customer-wide, account or conversation; a task may link the source message it came from.
 *    A conversation / source message must belong to THE SAME account and THE SAME person as the task's
 *    customer, otherwise the task is rejected (no cross-account / cross-person source links).
 *  - every update is an optimistic compare-and-set on the task revision (stale -> 409).
 *  - `owner` is a free label on the row. It is a business field, never an authorization identity.
 *  - due / done / overdue are plain instants; overdue = open and due strictly before `nowMs`. The local-day
 *    helpers turn a calendar date in an IANA time zone into the instant a task should be due.
 *
 * Waiting metrics are PURE QUERIES over the server projection `care_conversations.waiting_since`, which the
 * conversation store derives from the message set (see conversation-store.ts): the oldest live-observed,
 * relevant customer inbound with no answering operator / agent / self outbound. So by construction:
 *  - the clock starts at the oldest unanswered inbound of a burst and is not reset by later customer messages;
 *  - a local read (`markLocalSeen`) or a provider receipt does not resolve it, a reply does;
 *  - history / recovery sightings, system messages and echoes of our own sends never start it;
 *  - in groups / topics only messages directed at the account start it. `groupInScope` can narrow that
 *    further to a configured care scope (it can never widen it).
 * Aggregates accept `canReadSource` so a closed source contributes no rows and no counts.
 */

import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { requireNonEmptyString, requireSafeInteger } from '../../../_lib/care-kit/validation.js';
import type { CareStores } from '../persistence/index.js';
import type { OverdueTaskRow, TaskQueryFilter, TaskRow, TaskScope, WaitingRow } from '../persistence/audit-store.js';

export interface TaskView extends TaskRow {
  overdue: boolean;
}

export interface CreateTaskInput {
  customerId: string;
  title: string;
  dueAtMs: number;
  owner?: string | null;
  /** Scope: conversation > account > customer-wide. A source message implies its conversation. */
  conversationId?: string | null;
  accountId?: string | null;
  sourceMessageId?: string | null;
}

export interface TaskPatch {
  title?: string;
  dueAtMs?: number;
  owner?: string | null;
  done?: boolean;
}

export function isOverdue(task: Pick<TaskRow, 'done' | 'dueAtMs'>, nowMs: number): boolean {
  return !task.done && task.dueAtMs < nowMs;
}

function normalizeOwner(owner: unknown): string | null {
  if (owner === undefined || owner === null) return null;
  if (typeof owner !== 'string') throw new CareError('INVALID_COMMAND', 'owner must be a string label', 400);
  const trimmed = owner.trim();
  if (trimmed.length > 128) throw new CareError('INVALID_COMMAND', 'owner label is too long', 400);
  return trimmed === '' ? null : trimmed;
}

export class CareTaskService {
  constructor(
    private readonly db: Database.Database,
    private readonly stores: CareStores,
  ) {}

  createTask(input: CreateTaskInput): TaskView {
    const run = this.db.transaction((): TaskView => {
      const customer = this.stores.customers.getCustomer(input.customerId);
      if (!customer) throw new CareError('INVALID_TARGET', `Customer not found: ${input.customerId}`, 404);
      const title = requireNonEmptyString(input.title, 'title', 2000);
      const dueAtMs = requireSafeInteger(input.dueAtMs, 'dueAtMs', 0);
      const owner = normalizeOwner(input.owner);

      const audit = this.stores.audit;
      let conversationId = input.conversationId ?? null;
      let accountId = input.accountId ?? null;
      const sourceMessageId = input.sourceMessageId ?? null;

      const message = sourceMessageId ? this.stores.messages.getMessage(sourceMessageId) : null;
      if (sourceMessageId) {
        if (!message || message.isDeleted) throw new CareError('INVALID_TARGET', 'Source message not found', 404);
        if (conversationId && message.conversationId !== conversationId) {
          throw new CareError('INVALID_TARGET', 'Source message belongs to another conversation', 400);
        }
        if (accountId && message.accountId !== accountId) {
          throw new CareError('INVALID_TARGET', 'Cross-account source message', 400);
        }
        conversationId = message.conversationId;
      }

      if (conversationId) {
        const conversation = this.stores.conversations.getConversation(conversationId);
        if (!conversation) throw new CareError('INVALID_TARGET', `Conversation not found: ${conversationId}`, 404);
        if (accountId && conversation.accountId !== accountId) {
          throw new CareError('INVALID_TARGET', 'Cross-account conversation mismatch', 400);
        }
        accountId = conversation.accountId;
        if (!audit.conversationBelongsToCustomer(conversation.id, customer.id)) {
          throw new CareError('INVALID_TARGET', 'Conversation does not belong to this customer', 400);
        }
        if (message && conversation.kind !== 'direct' && conversation.kind !== 'email_thread') {
          // In a group the source must be one of the customer's own messages.
          const sender = message.senderIdentityId ? this.stores.identities.getIdentity(message.senderIdentityId) : null;
          if (!sender || sender.customerId !== customer.id) {
            throw new CareError('INVALID_TARGET', 'Source message was written by another person', 400);
          }
        }
      } else if (accountId) {
        if (!this.stores.accounts.getAccount(accountId)) {
          throw new CareError('INVALID_TARGET', `Account not found: ${accountId}`, 404);
        }
        if (!audit.customerHasIdentityOnAccount(customer.id, accountId)) {
          throw new CareError('INVALID_TARGET', 'Customer has no identity on that account', 400);
        }
      }

      const scope: TaskScope = conversationId ? 'conversation' : accountId ? 'account' : 'customer';
      const task = this.stores.tasks.createTask({ customerId: customer.id, conversationId, title, dueAtMs, owner });
      audit.upsertTaskMeta({ taskId: task.id, scope, accountId, sourceMessageId });
      return this.requireView(task.id, Date.now());
    });
    return run.immediate();
  }

  /** Optimistic update: `expectedRevision` is required and must match, else 409 with the current revision. */
  updateTask(id: string, patch: TaskPatch, expectedRevision: number): TaskView {
    const run = this.db.transaction((): TaskView => {
      const current = this.stores.tasks.getTask(id);
      if (!current) throw new CareError('NOT_FOUND', `Task not found: ${id}`, 404);
      if (!Number.isSafeInteger(expectedRevision)) {
        throw new CareError('INVALID_COMMAND', 'expectedRevision is required', 400);
      }
      if (current.revision !== expectedRevision) {
        throw new CareError(
          'STALE_REVISION',
          `Task revision mismatch. Expected ${expectedRevision}, but found ${current.revision}`,
          409,
          { currentRevision: current.revision },
        );
      }
      // The store's idempotent upsert compares the plaintext fields and bumps the revision exactly once on change.
      this.stores.tasks.upsertBridged({
        id,
        customerId: current.customerId,
        title: patch.title !== undefined ? requireNonEmptyString(patch.title, 'title', 2000) : current.title,
        dueAtMs: patch.dueAtMs !== undefined ? requireSafeInteger(patch.dueAtMs, 'dueAtMs', 0) : current.dueAtMs,
        done: patch.done !== undefined ? Boolean(patch.done) : current.done,
        owner: patch.owner !== undefined ? normalizeOwner(patch.owner) : current.owner,
      });
      return this.requireView(id, Date.now());
    });
    return run.immediate();
  }

  setDone(id: string, done: boolean, expectedRevision: number): TaskView {
    return this.updateTask(id, { done }, expectedRevision);
  }

  setOwner(id: string, owner: string | null, expectedRevision: number): TaskView {
    return this.updateTask(id, { owner }, expectedRevision);
  }

  getTask(id: string, nowMs: number = Date.now()): TaskView | null {
    const row = this.stores.audit.queryTasks({ taskId: id, limit: 1 })[0];
    return row ? { ...row, overdue: isOverdue(row, nowMs) } : null;
  }

  /**
   * Tasks matching the filter, due ascending. A task scoped to a source whose read gate is closed is left out
   * (a page can therefore hold fewer than `limit` rows).
   */
  listTasks(filter: TaskQueryFilter = {}, opts: { nowMs?: number; canReadSource?: (accountId: string) => boolean } = {}): TaskView[] {
    const nowMs = opts.nowMs ?? Date.now();
    return this.stores.audit
      .queryTasks(filter)
      .filter((t) => !(t.accountId && opts.canReadSource && !safeGate(opts.canReadSource, t.accountId)))
      .map((t) => ({ ...t, overdue: isOverdue(t, nowMs) }));
  }

  private requireView(id: string, nowMs: number): TaskView {
    const view = this.getTask(id, nowMs);
    if (!view) throw new CareError('NOT_FOUND', `Task not found: ${id}`, 404);
    return view;
  }
}

function safeGate(gate: (accountId: string) => boolean, accountId: string): boolean {
  try {
    return gate(accountId) === true;
  } catch {
    return false; // a broken gate is a closed gate
  }
}

// ── time zone helpers ────────────────────────────────────────────────────────────────────────

function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** First instant of the given local calendar day (`YYYY-MM-DD`) in an IANA time zone. */
export function startOfLocalDayMs(date: string, timeZone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new CareError('INVALID_COMMAND', 'date must be YYYY-MM-DD', 400);
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let instant = guess - zoneOffsetMs(guess, timeZone);
  instant = guess - zoneOffsetMs(instant, timeZone); // re-evaluate at the candidate (DST edges)
  return instant;
}

/** Last millisecond of the given local day: the natural `dueAtMs` for "due on this date". */
export function endOfLocalDayMs(date: string, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
  return startOfLocalDayMs(next, timeZone) - 1;
}

/** `[startMs, endMs]` of the local day containing `nowMs`. */
export function localDayBoundsMs(nowMs: number, timeZone: string): { startMs: number; endMs: number } {
  const date = new Date(nowMs + zoneOffsetMs(nowMs, timeZone)).toISOString().slice(0, 10);
  return { startMs: startOfLocalDayMs(date, timeZone), endMs: endOfLocalDayMs(date, timeZone) };
}

// ── waiting metrics ──────────────────────────────────────────────────────────────────────────

export interface WaitingMetricsOptions {
  nowMs: number;
  /** A conversation breaches the SLA once it has waited at least this long. */
  slaMs: number;
  accountId?: string;
  canReadSource?: (accountId: string) => boolean;
  /** Narrows group / topic rows to a configured care scope. Never adds rows the projection did not mark waiting. */
  groupInScope?: (row: WaitingRow) => boolean;
}

export interface WaitingItem extends WaitingRow {
  waitedMs: number;
  breached: boolean;
}

export interface OwnerWaiting {
  owner: string | null;
  waiting: number;
  breached: number;
  oldestWaitingSinceMs: number;
}

export interface AccountWaiting {
  accountId: string;
  waiting: number;
  breached: number;
  oldestWaitingSinceMs: number;
}

export function listWaiting(stores: CareStores, opts: WaitingMetricsOptions): WaitingItem[] {
  if (!Number.isFinite(opts.slaMs) || opts.slaMs < 0) throw new CareError('INVALID_COMMAND', 'slaMs must be >= 0', 400);
  return stores.audit
    .listWaiting({ accountId: opts.accountId })
    .filter((row) => !opts.canReadSource || safeGate(opts.canReadSource, row.accountId))
    .filter((row) => (row.kind === 'group' || row.kind === 'topic') && opts.groupInScope ? opts.groupInScope(row) : true)
    .map((row) => {
      const waitedMs = Math.max(0, opts.nowMs - row.waitingSinceMs);
      return { ...row, waitedMs, breached: waitedMs >= opts.slaMs };
    });
}

export function waitingByOwner(stores: CareStores, opts: WaitingMetricsOptions): OwnerWaiting[] {
  const buckets = new Map<string, OwnerWaiting>();
  for (const item of listWaiting(stores, opts)) {
    const key = item.owner ?? '';
    const b = buckets.get(key) ?? { owner: item.owner, waiting: 0, breached: 0, oldestWaitingSinceMs: item.waitingSinceMs };
    b.waiting += 1;
    if (item.breached) b.breached += 1;
    b.oldestWaitingSinceMs = Math.min(b.oldestWaitingSinceMs, item.waitingSinceMs);
    buckets.set(key, b);
  }
  return sortBuckets([...buckets.values()], (b) => b.owner ?? '');
}

export function waitingByAccount(stores: CareStores, opts: WaitingMetricsOptions): AccountWaiting[] {
  const buckets = new Map<string, AccountWaiting>();
  for (const item of listWaiting(stores, opts)) {
    const b = buckets.get(item.accountId) ?? { accountId: item.accountId, waiting: 0, breached: 0, oldestWaitingSinceMs: item.waitingSinceMs };
    b.waiting += 1;
    if (item.breached) b.breached += 1;
    b.oldestWaitingSinceMs = Math.min(b.oldestWaitingSinceMs, item.waitingSinceMs);
    buckets.set(item.accountId, b);
  }
  return sortBuckets([...buckets.values()], (b) => b.accountId);
}

export interface OverdueByOwner {
  owner: string | null;
  overdue: number;
  oldestDueAtMs: number;
}

export interface OverdueByAccount {
  /** Null = customer-wide tasks with no account scope. */
  accountId: string | null;
  overdue: number;
  oldestDueAtMs: number;
}

function overdueRows(stores: CareStores, nowMs: number, canReadSource?: (accountId: string) => boolean): OverdueTaskRow[] {
  return stores.audit
    .listOverdueTaskRows(nowMs)
    .filter((r) => !(r.accountId && canReadSource && !safeGate(canReadSource, r.accountId)));
}

export function overdueTasksByOwner(
  stores: CareStores,
  opts: { nowMs: number; canReadSource?: (accountId: string) => boolean },
): OverdueByOwner[] {
  const buckets = new Map<string, OverdueByOwner>();
  for (const r of overdueRows(stores, opts.nowMs, opts.canReadSource)) {
    const key = r.owner ?? '';
    const b = buckets.get(key) ?? { owner: r.owner, overdue: 0, oldestDueAtMs: r.dueAtMs };
    b.overdue += 1;
    b.oldestDueAtMs = Math.min(b.oldestDueAtMs, r.dueAtMs);
    buckets.set(key, b);
  }
  return sortBuckets([...buckets.values()], (b) => b.owner ?? '');
}

export function overdueTasksByAccount(
  stores: CareStores,
  opts: { nowMs: number; canReadSource?: (accountId: string) => boolean },
): OverdueByAccount[] {
  const buckets = new Map<string, OverdueByAccount>();
  for (const r of overdueRows(stores, opts.nowMs, opts.canReadSource)) {
    const key = r.accountId ?? '';
    const b = buckets.get(key) ?? { accountId: r.accountId, overdue: 0, oldestDueAtMs: r.dueAtMs };
    b.overdue += 1;
    b.oldestDueAtMs = Math.min(b.oldestDueAtMs, r.dueAtMs);
    buckets.set(key, b);
  }
  return sortBuckets([...buckets.values()], (b) => b.accountId ?? '');
}

function sortBuckets<T>(rows: T[], key: (row: T) => string): T[] {
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
