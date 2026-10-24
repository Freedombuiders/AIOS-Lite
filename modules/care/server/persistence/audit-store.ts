/**
 * CC-18/19 link/unlink audit, identity membership history, task metadata and task/waiting metric queries.
 *
 *  - `ensureAuditSchema(db)` is called from createCareSchema inside its IMMEDIATE transaction on every boot, so
 *    it is additive and idempotent (CREATE ... IF NOT EXISTS only).
 *  - `CareAuditStore` is exposed as a field of CareStores (see index.ts).
 *
 * What is stored, and what deliberately is not:
 *  - audit rows hold IDs, counts and revisions only. Message bodies are never copied here.
 *  - the only content kept is the previous/applied value of an explicitly chosen customer-wide
 *    attribute (encrypted), because an unlink must be able to put the target customer back. Both
 *    ciphertexts are cleared as soon as the change is settled by an unlink.
 *  - no foreign keys point at customers/identities/conversations: history must survive their deletion
 *    and must never block it. Only task metadata cascades with its task.
 */
import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { decryptNullable, encryptNullable, type CareKeyInput } from './crypto.js';

export function ensureAuditSchema(db: Database.Database): void {
  db.exec(`
    -- One row per link / unlink operation. request_id makes a retried request idempotent.
    CREATE TABLE IF NOT EXISTS care_link_events (
      id                  TEXT PRIMARY KEY,
      kind                TEXT NOT NULL CHECK (kind IN ('link','unlink')),
      request_id          TEXT,
      payload_hash        TEXT NOT NULL,
      target_customer_id  TEXT NOT NULL,
      actor               TEXT,
      refs_json           TEXT NOT NULL,
      revisions_json      TEXT NOT NULL,
      created_at          INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_care_link_events_request
      ON care_link_events(request_id) WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_care_link_events_target
      ON care_link_events(target_customer_id, created_at);

    -- Identity membership history: lets an unlink restore the previous source customer.
    CREATE TABLE IF NOT EXISTS care_identity_membership_history (
      seq                INTEGER PRIMARY KEY AUTOINCREMENT,
      link_event_id      TEXT NOT NULL,
      identity_id        TEXT NOT NULL,
      from_customer_id   TEXT NOT NULL,
      to_customer_id     TEXT NOT NULL,
      kind               TEXT NOT NULL CHECK (kind IN ('link','unlink')),
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_care_membership_identity
      ON care_identity_membership_history(identity_id, seq);
    CREATE INDEX IF NOT EXISTS idx_care_membership_event
      ON care_identity_membership_history(link_event_id);

    -- Where profiles / tasks / conversation pointers lived before a link moved them. A 'baseline'
    -- row (from = to) records "this item already belonged to the target when the link ran".
    CREATE TABLE IF NOT EXISTS care_link_moves (
      seq                INTEGER PRIMARY KEY AUTOINCREMENT,
      link_event_id      TEXT NOT NULL,
      entity_type        TEXT NOT NULL CHECK (entity_type IN ('profile','task','conversation')),
      entity_id          TEXT NOT NULL,
      kind               TEXT NOT NULL CHECK (kind IN ('move','baseline')),
      from_customer_id   TEXT NOT NULL,
      to_customer_id     TEXT NOT NULL,
      created_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_care_link_moves_entity
      ON care_link_moves(entity_type, entity_id, seq);
    CREATE INDEX IF NOT EXISTS idx_care_link_moves_event
      ON care_link_moves(link_event_id);

    -- Explicit customer-wide attribute choices made at link time (encrypted, cleared on settle).
    CREATE TABLE IF NOT EXISTS care_link_field_changes (
      seq                  INTEGER PRIMARY KEY AUTOINCREMENT,
      link_event_id        TEXT NOT NULL,
      customer_id          TEXT NOT NULL,
      field                TEXT NOT NULL,
      source_customer_id   TEXT,
      previous_enc         TEXT,
      applied_enc          TEXT,
      outcome              TEXT CHECK (outcome IS NULL OR outcome IN ('restored','kept_edited')),
      settled_at           INTEGER,
      created_at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_care_link_fields_event
      ON care_link_field_changes(link_event_id);

    -- Task scope and source links the base task row has no columns for.
    CREATE TABLE IF NOT EXISTS care_task_meta (
      task_id            TEXT PRIMARY KEY REFERENCES care_tasks(id) ON DELETE CASCADE,
      scope              TEXT NOT NULL CHECK (scope IN ('customer','account','conversation')),
      account_id         TEXT,
      source_message_id  TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_care_task_meta_account
      ON care_task_meta(account_id) WHERE account_id IS NOT NULL;
  `);
}

export type LinkEventKind = 'link' | 'unlink';
export type MoveEntityType = 'profile' | 'task' | 'conversation';
export type TaskScope = 'customer' | 'account' | 'conversation';

export interface LinkEventRecord {
  id: string;
  kind: LinkEventKind;
  requestId: string | null;
  payloadHash: string;
  targetCustomerId: string;
  actor: string | null;
  refs: Record<string, unknown>;
  revisions: Record<string, [number, number]>;
  createdAtMs: number;
}

export interface MembershipRecord {
  seq: number;
  linkEventId: string;
  identityId: string;
  fromCustomerId: string;
  toCustomerId: string;
  kind: LinkEventKind;
  createdAtMs: number;
}

export interface MoveRecord {
  seq: number;
  linkEventId: string;
  entityType: MoveEntityType;
  entityId: string;
  kind: 'move' | 'baseline';
  fromCustomerId: string;
  toCustomerId: string;
  createdAtMs: number;
}

export interface FieldChangeRecord {
  seq: number;
  linkEventId: string;
  customerId: string;
  field: string;
  sourceCustomerId: string | null;
  previousValue: string | null;
  appliedValue: string | null;
  outcome: 'restored' | 'kept_edited' | null;
  settledAtMs: number | null;
}

export interface TaskMetaRecord {
  taskId: string;
  scope: TaskScope;
  accountId: string | null;
  sourceMessageId: string | null;
}

export interface TaskQueryFilter {
  taskId?: string;
  customerId?: string;
  conversationId?: string;
  accountId?: string;
  owner?: string | null;
  scope?: TaskScope;
  done?: boolean;
  /** Only open tasks due strictly before this instant. */
  overdueBeforeMs?: number;
  limit?: number;
  after?: { dueAtMs: number; id: string };
}

export interface TaskRow {
  id: string;
  customerId: string;
  conversationId: string | null;
  title: string;
  dueAtMs: number;
  done: boolean;
  owner: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  scope: TaskScope;
  accountId: string | null;
  sourceMessageId: string | null;
}

export interface WaitingRow {
  conversationId: string;
  accountId: string;
  kind: string;
  waitingSinceMs: number;
  primaryCustomerId: string | null;
  owner: string | null;
}

export interface OverdueTaskRow {
  taskId: string;
  owner: string | null;
  accountId: string | null;
  dueAtMs: number;
}

export class CareAuditStore {
  constructor(
    protected readonly db: Database.Database,
    protected readonly key?: CareKeyInput,
  ) {}

  // ── link / unlink events ───────────────────────────────────────────────────────────────

  insertLinkEvent(input: {
    id: string;
    kind: LinkEventKind;
    requestId?: string | null;
    payloadHash: string;
    targetCustomerId: string;
    actor?: string | null;
    refs: Record<string, unknown>;
    revisions: Record<string, [number, number]>;
  }): LinkEventRecord {
    this.db
      .prepare(
        `INSERT INTO care_link_events (id, kind, request_id, payload_hash, target_customer_id, actor, refs_json, revisions_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        input.requestId ?? null,
        input.payloadHash,
        input.targetCustomerId,
        input.actor ?? null,
        JSON.stringify(input.refs),
        JSON.stringify(input.revisions),
        Date.now(),
      );
    return this.getLinkEvent(input.id)!;
  }

  getLinkEvent(id: string): LinkEventRecord | null {
    const row = this.db.prepare('SELECT * FROM care_link_events WHERE id = ?').get(id) as any;
    return row ? this.mapEvent(row) : null;
  }

  findLinkEventByRequest(requestId: string): LinkEventRecord | null {
    const row = this.db.prepare('SELECT * FROM care_link_events WHERE request_id = ?').get(requestId) as any;
    return row ? this.mapEvent(row) : null;
  }

  /** Newest first; events whose target is the customer or that moved one of its identities. */
  listLinkEventsForCustomer(customerId: string, limit = 50): LinkEventRecord[] {
    const capped = Math.min(Math.max(Math.trunc(limit) || 1, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT * FROM care_link_events e
         WHERE e.target_customer_id = @c
            OR EXISTS (SELECT 1 FROM care_identity_membership_history h
                       WHERE h.link_event_id = e.id AND (h.from_customer_id = @c OR h.to_customer_id = @c))
         ORDER BY e.created_at DESC, e.id DESC LIMIT @n`,
      )
      .all({ c: customerId, n: capped }) as any[];
    return rows.map((r) => this.mapEvent(r));
  }

  // ── identity membership history ────────────────────────────────────────────────────────

  addMembership(input: {
    linkEventId: string;
    identityId: string;
    fromCustomerId: string;
    toCustomerId: string;
    kind: LinkEventKind;
  }): void {
    this.db
      .prepare(
        `INSERT INTO care_identity_membership_history (link_event_id, identity_id, from_customer_id, to_customer_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.linkEventId, input.identityId, input.fromCustomerId, input.toCustomerId, input.kind, Date.now());
  }

  /** The most recent membership change of one identity (the one an unlink would undo). */
  latestMembership(identityId: string): MembershipRecord | null {
    const row = this.db
      .prepare('SELECT * FROM care_identity_membership_history WHERE identity_id = ? ORDER BY seq DESC LIMIT 1')
      .get(identityId) as any;
    return row ? this.mapMembership(row) : null;
  }

  listMembershipsForEvent(linkEventId: string): MembershipRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM care_identity_membership_history WHERE link_event_id = ? ORDER BY seq ASC')
        .all(linkEventId) as any[]
    ).map((r) => this.mapMembership(r));
  }

  membershipHistory(identityId: string): MembershipRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM care_identity_membership_history WHERE identity_id = ? ORDER BY seq ASC')
        .all(identityId) as any[]
    ).map((r) => this.mapMembership(r));
  }

  // ── moved profiles / tasks / conversation pointers ─────────────────────────────────────

  addMove(input: {
    linkEventId: string;
    entityType: MoveEntityType;
    entityId: string;
    kind: 'move' | 'baseline';
    fromCustomerId: string;
    toCustomerId: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO care_link_moves (link_event_id, entity_type, entity_id, kind, from_customer_id, to_customer_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.linkEventId, input.entityType, input.entityId, input.kind, input.fromCustomerId, input.toCustomerId, Date.now());
  }

  /** Latest recorded location change of an entity (baselines do not change a location and are ignored). */
  latestMove(entityType: MoveEntityType, entityId: string): MoveRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM care_link_moves WHERE entity_type = ? AND entity_id = ? AND kind = 'move' ORDER BY seq DESC LIMIT 1`)
      .get(entityType, entityId) as any;
    return row ? this.mapMove(row) : null;
  }

  /** Was the entity recorded as already belonging to its owner when this link event ran? */
  hasBaseline(linkEventId: string, entityType: MoveEntityType, entityId: string): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM care_link_moves WHERE link_event_id = ? AND entity_type = ? AND entity_id = ? AND kind = 'baseline'`)
        .get(linkEventId, entityType, entityId),
    );
  }

  listMovesForEvent(linkEventId: string): MoveRecord[] {
    return (
      this.db.prepare('SELECT * FROM care_link_moves WHERE link_event_id = ? ORDER BY seq ASC').all(linkEventId) as any[]
    ).map((r) => this.mapMove(r));
  }

  /** Where each profile currently held by the customer originally came from (origin scope). */
  profileOrigins(customerId: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT p.id AS id, (
           SELECT m.from_customer_id FROM care_link_moves m
           WHERE m.entity_type = 'profile' AND m.entity_id = p.id ORDER BY m.seq DESC LIMIT 1
         ) AS origin
         FROM care_profiles p WHERE p.customer_id = ?`,
      )
      .all(customerId) as Array<{ id: string; origin: string | null }>;
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.id, r.origin ?? customerId);
    return out;
  }

  // ── explicit customer-wide attribute choices ───────────────────────────────────────────

  addFieldChange(input: {
    linkEventId: string;
    customerId: string;
    field: string;
    sourceCustomerId: string | null;
    previousValue: string | null;
    appliedValue: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO care_link_field_changes (link_event_id, customer_id, field, source_customer_id, previous_enc, applied_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.linkEventId,
        input.customerId,
        input.field,
        input.sourceCustomerId,
        encryptNullable(input.previousValue, this.key),
        encryptNullable(input.appliedValue, this.key),
        Date.now(),
      );
  }

  listOpenFieldChanges(linkEventId: string): FieldChangeRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM care_link_field_changes WHERE link_event_id = ? AND settled_at IS NULL ORDER BY seq ASC')
        .all(linkEventId) as any[]
    ).map((r) => ({
      seq: Number(r.seq),
      linkEventId: r.link_event_id,
      customerId: r.customer_id,
      field: r.field,
      sourceCustomerId: r.source_customer_id,
      previousValue: decryptNullable(r.previous_enc, this.key),
      appliedValue: decryptNullable(r.applied_enc, this.key),
      outcome: r.outcome ?? null,
      settledAtMs: r.settled_at === null || r.settled_at === undefined ? null : Number(r.settled_at),
    }));
  }

  /** Clears both ciphertexts: nothing about the old value is retained once the unlink handled it. */
  settleFieldChange(seq: number, outcome: 'restored' | 'kept_edited'): void {
    this.db
      .prepare('UPDATE care_link_field_changes SET previous_enc = NULL, applied_enc = NULL, outcome = ?, settled_at = ? WHERE seq = ?')
      .run(outcome, Date.now(), seq);
  }

  // ── task metadata ──────────────────────────────────────────────────────────────────────

  upsertTaskMeta(input: TaskMetaRecord): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO care_task_meta (task_id, scope, account_id, source_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET scope = excluded.scope, account_id = excluded.account_id,
           source_message_id = excluded.source_message_id, updated_at = excluded.updated_at`,
      )
      .run(input.taskId, input.scope, input.accountId, input.sourceMessageId, now, now);
  }

  getTaskMeta(taskId: string): TaskMetaRecord | null {
    const row = this.db.prepare('SELECT * FROM care_task_meta WHERE task_id = ?').get(taskId) as any;
    return row
      ? { taskId: row.task_id, scope: row.scope, accountId: row.account_id, sourceMessageId: row.source_message_id }
      : null;
  }

  /** Newest-first-by-due keyset page (due ASC, id ASC). Task titles are decrypted, so keep pages small. */
  queryTasks(filter: TaskQueryFilter = {}): TaskRow[] {
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100) || 1, 1), 500);
    const where: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (filter.taskId !== undefined) {
      where.push('t.id = @taskId');
      params.taskId = filter.taskId;
    }
    if (filter.customerId !== undefined) {
      where.push('t.customer_id = @customerId');
      params.customerId = filter.customerId;
    }
    if (filter.conversationId !== undefined) {
      where.push('t.conversation_id = @conversationId');
      params.conversationId = filter.conversationId;
    }
    if (filter.accountId !== undefined) {
      where.push('COALESCE(m.account_id, cv.account_id) = @accountId');
      params.accountId = filter.accountId;
    }
    if (filter.owner !== undefined) {
      if (filter.owner === null) where.push('t.owner IS NULL');
      else {
        where.push('t.owner = @owner');
        params.owner = filter.owner;
      }
    }
    if (filter.scope !== undefined) {
      where.push(`${TASK_SCOPE_SQL} = @scope`);
      params.scope = filter.scope;
    }
    if (filter.done !== undefined) where.push(`t.done = ${filter.done ? 1 : 0}`);
    if (filter.overdueBeforeMs !== undefined) {
      where.push('t.done = 0 AND t.due_at < @overdueBefore');
      params.overdueBefore = filter.overdueBeforeMs;
    }
    if (filter.after) {
      where.push('(t.due_at > @afterDue OR (t.due_at = @afterDue AND t.id > @afterId))');
      params.afterDue = filter.after.dueAtMs;
      params.afterId = filter.after.id;
    }
    const sql = `SELECT t.*, ${TASK_SCOPE_SQL} AS scope, COALESCE(m.account_id, cv.account_id) AS account_id,
                        m.source_message_id AS source_message_id
                 FROM care_tasks t
                 LEFT JOIN care_task_meta m ON m.task_id = t.id
                 LEFT JOIN care_conversations cv ON cv.id = t.conversation_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY t.due_at ASC, t.id ASC LIMIT @limit`;
    return (this.db.prepare(sql).all(params) as any[]).map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      conversationId: r.conversation_id,
      title: decryptNullable(r.title_enc, this.key) ?? '',
      dueAtMs: Number(r.due_at),
      done: Boolean(r.done),
      owner: r.owner,
      revision: Number(r.revision),
      createdAtMs: Number(r.created_at),
      updatedAtMs: Number(r.updated_at),
      scope: r.scope,
      accountId: r.account_id ?? null,
      sourceMessageId: r.source_message_id ?? null,
    }));
  }

  /** Account an existing task is scoped to (explicit metadata first, else its conversation's account). */
  taskAccountId(taskId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT COALESCE(m.account_id, cv.account_id) AS account_id
         FROM care_tasks t LEFT JOIN care_task_meta m ON m.task_id = t.id
         LEFT JOIN care_conversations cv ON cv.id = t.conversation_id WHERE t.id = ?`,
      )
      .get(taskId) as { account_id: string | null } | undefined;
    return row?.account_id ?? null;
  }

  /** Re-points a profile at another customer (origin account scope is kept). Bumps its revision. */
  reassignProfile(profileId: string, customerId: string): boolean {
    return (
      this.db
        .prepare('UPDATE care_profiles SET customer_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(customerId, Date.now(), profileId).changes > 0
    );
  }

  /** Re-points a task at another customer (conversation / source links are kept). Bumps its revision. */
  reassignTask(taskId: string, customerId: string): boolean {
    return (
      this.db
        .prepare('UPDATE care_tasks SET customer_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(customerId, Date.now(), taskId).changes > 0
    );
  }

  // ── helpers for the link/unlink flows ──────────────────────────────────────────────────

  /** Conversations whose `primary_customer_id` is the customer: [id, accountId]. */
  listPrimaryConversations(customerId: string): Array<{ id: string; accountId: string }> {
    return (
      this.db.prepare('SELECT id, account_id FROM care_conversations WHERE primary_customer_id = ? ORDER BY id').all(customerId) as any[]
    ).map((r) => ({ id: r.id, accountId: r.account_id }));
  }

  /** Does `identityId` author at least one message of the conversation? */
  identitySpeaksIn(identityId: string, conversationId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM care_messages WHERE conversation_id = ? AND sender_identity_id = ? LIMIT 1')
        .get(conversationId, identityId),
    );
  }

  /**
   * Does the conversation legitimately belong to the customer? Direct / email-thread: primary customer or
   * any inbound sender identity of the customer. Group / topic: only when one of the customer's identities
   * wrote in it (a group is never "owned" by one of its members).
   */
  conversationBelongsToCustomer(conversationId: string, customerId: string): boolean {
    const conv = this.db
      .prepare('SELECT kind, primary_customer_id FROM care_conversations WHERE id = ?')
      .get(conversationId) as { kind: string; primary_customer_id: string | null } | undefined;
    if (!conv) return false;
    const spoke = Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM care_messages m JOIN care_identities i ON i.id = m.sender_identity_id
           WHERE m.conversation_id = ? AND i.customer_id = ? LIMIT 1`,
        )
        .get(conversationId, customerId),
    );
    if (spoke) return true;
    return (conv.kind === 'direct' || conv.kind === 'email_thread') && conv.primary_customer_id === customerId;
  }

  customerHasIdentityOnAccount(customerId: string, accountId: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM care_identities WHERE customer_id = ? AND account_id = ? LIMIT 1').get(customerId, accountId),
    );
  }

  /** Accounts a customer can be read from: identity accounts plus accounts of conversations it is primary of. */
  customerSourceAccounts(customerId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT account_id FROM care_identities WHERE customer_id = @c
           UNION SELECT account_id FROM care_conversations WHERE primary_customer_id = @c
           ORDER BY 1`,
        )
        .all({ c: customerId }) as Array<{ account_id: string }>
    ).map((r) => r.account_id);
  }

  /**
   * Keyset page of the merged customer timeline restricted to `accountIds`: every message of
   * direct / email-thread conversations the customer is part of, plus only the customer's OWN messages
   * in groups / topics. Newest first on (sent_at, id). Returns IDs; the message store decrypts them.
   */
  timelineMessageIds(input: {
    customerId: string;
    accountIds: string[];
    limit: number;
    before?: { sentAtMs: number; id: string };
    /** Restrict to one message (membership check for reply targets). */
    messageId?: string;
  }): Array<{ id: string; sentAtMs: number }> {
    if (input.accountIds.length === 0) return [];
    const limit = Math.min(Math.max(Math.trunc(input.limit) || 1, 1), 500);
    const marks = input.accountIds.map(() => '?').join(',');
    // The shared message filter is repeated in both branches below, so its parameters are bound twice (positional, in order).
    // `+m.account_id`: the unary plus keeps the planner from choosing the (account_id, ...) lookup index, which walks EVERY message of
    // the account instead of the few hundred reached through the sender / conversation indexes
    let filter = `m.is_deleted = 0 AND m.tombstone = 0 AND +m.account_id IN (${marks})`;
    const filterParams: unknown[] = [...input.accountIds];
    if (input.before) {
      // unary plus on the keyset columns: without it the OR becomes a MULTI-INDEX OR whose first arm is a scan of care_messages
      filter += ' AND (+m.sent_at < ? OR (+m.sent_at = ? AND +m.id < ?))';
      filterParams.push(input.before.sentAtMs, input.before.sentAtMs, input.before.id);
    }
    if (input.messageId) {
      filter += ' AND m.id = ?';
      filterParams.push(input.messageId);
    }
    // Three index lookups instead of one OR over every conversation (that OR could not use an index, so each request
    // scanned all conversations):
    //   A  messages written by one of the customer's identities (any conversation kind)      -> idx_care_messages_sender
    //   B  every message of the direct / email-thread conversations the customer is primary of -> idx_care_conversations_customer
    //   C  every message of the direct / email-thread conversations the customer spoke in     -> the sender index, then the timeline index
    // A UNION of A with B+C (B and C share one conversation list) is exactly the old predicate, deduplicated by (id, sent_at).
    const rows = this.db
      .prepare(
        `WITH ident(id) AS MATERIALIZED (SELECT id FROM care_identities WHERE customer_id = ?),
              convs(id) AS MATERIALIZED (
                SELECT cv.id FROM care_conversations cv WHERE cv.kind IN ('direct','email_thread') AND cv.primary_customer_id = ?
                UNION
                SELECT cv.id FROM care_conversations cv
                WHERE cv.kind IN ('direct','email_thread')
                  AND cv.id IN (SELECT x.conversation_id FROM care_messages x WHERE x.sender_identity_id IN (SELECT id FROM ident))
              )
         SELECT id, sent_at FROM (
           SELECT m.id AS id, m.sent_at AS sent_at FROM care_messages m
           WHERE m.sender_identity_id IN (SELECT id FROM ident) AND ${filter}
           UNION
           SELECT m.id AS id, m.sent_at AS sent_at FROM care_messages m
           WHERE m.conversation_id IN (SELECT id FROM convs) AND ${filter}
         )
         ORDER BY sent_at DESC, id DESC LIMIT ?`,
      )
      .all(input.customerId, input.customerId, ...filterParams, ...filterParams, limit) as any[];
    return rows.map((r) => ({ id: r.id, sentAtMs: Number(r.sent_at) }));
  }

  // ── waiting / overdue metric rows ──────────────────────────────────────────────────────

  /**
   * Conversations the server projection currently marks as waiting. The projection itself already
   * encodes the semantics (oldest unanswered live inbound, history/recovery/system never start it,
   * group/topic only when directed at the account); this just joins the owner label.
   * Owner = primary customer's owner; for direct/email threads without one, the latest inbound sender's.
   */
  listWaiting(filter: { accountId?: string } = {}): WaitingRow[] {
    const params: Record<string, unknown> = {};
    let accountSql = '';
    if (filter.accountId !== undefined) {
      accountSql = 'AND cv.account_id = @accountId';
      params.accountId = filter.accountId;
    }
    const rows = this.db
      .prepare(
        `SELECT cv.id AS id, cv.account_id AS account_id, cv.kind AS kind, cv.waiting_since AS waiting_since,
                cv.primary_customer_id AS primary_customer_id,
                COALESCE(pc.owner, CASE WHEN cv.kind IN ('direct','email_thread') THEN ic.owner END) AS owner
         FROM care_conversations cv
         LEFT JOIN care_customers pc ON pc.id = cv.primary_customer_id
         LEFT JOIN care_customers ic ON ic.id = (
           SELECT i.customer_id FROM care_messages m JOIN care_identities i ON i.id = m.sender_identity_id
           WHERE m.conversation_id = cv.id AND m.direction = 'in' AND m.sender_role = 'customer' AND m.is_deleted = 0
           ORDER BY m.sent_at DESC, m.id DESC LIMIT 1)
         WHERE cv.waiting_since IS NOT NULL AND cv.status = 'active' ${accountSql}
         ORDER BY cv.waiting_since ASC, cv.id ASC`,
      )
      .all(params) as any[];
    return rows.map((r) => ({
      conversationId: r.id,
      accountId: r.account_id,
      kind: r.kind,
      waitingSinceMs: Number(r.waiting_since),
      primaryCustomerId: r.primary_customer_id ?? null,
      owner: r.owner ?? null,
    }));
  }

  /** Open tasks due strictly before `nowMs`: owner/account only, no titles. */
  listOverdueTaskRows(nowMs: number): OverdueTaskRow[] {
    return (
      this.db
        .prepare(
          `SELECT t.id AS id, t.owner AS owner, t.due_at AS due_at, COALESCE(m.account_id, cv.account_id) AS account_id
           FROM care_tasks t LEFT JOIN care_task_meta m ON m.task_id = t.id
           LEFT JOIN care_conversations cv ON cv.id = t.conversation_id
           WHERE t.done = 0 AND t.due_at < ? ORDER BY t.due_at ASC, t.id ASC`,
        )
        .all(nowMs) as any[]
    ).map((r) => ({ taskId: r.id, owner: r.owner ?? null, accountId: r.account_id ?? null, dueAtMs: Number(r.due_at) }));
  }

  // ── mappers ────────────────────────────────────────────────────────────────────────────

  private mapEvent(row: any): LinkEventRecord {
    let refs: Record<string, unknown>;
    let revisions: Record<string, [number, number]>;
    try {
      refs = JSON.parse(row.refs_json);
      revisions = JSON.parse(row.revisions_json);
    } catch {
      throw new CareError('CONFIGURATION_CONFLICT', 'Link audit row is corrupt', 500);
    }
    return {
      id: row.id,
      kind: row.kind,
      requestId: row.request_id ?? null,
      payloadHash: row.payload_hash,
      targetCustomerId: row.target_customer_id,
      actor: row.actor ?? null,
      refs,
      revisions,
      createdAtMs: Number(row.created_at),
    };
  }

  private mapMembership(row: any): MembershipRecord {
    return {
      seq: Number(row.seq),
      linkEventId: row.link_event_id,
      identityId: row.identity_id,
      fromCustomerId: row.from_customer_id,
      toCustomerId: row.to_customer_id,
      kind: row.kind,
      createdAtMs: Number(row.created_at),
    };
  }

  private mapMove(row: any): MoveRecord {
    return {
      seq: Number(row.seq),
      linkEventId: row.link_event_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      kind: row.kind,
      fromCustomerId: row.from_customer_id,
      toCustomerId: row.to_customer_id,
      createdAtMs: Number(row.created_at),
    };
  }
}

const TASK_SCOPE_SQL = `COALESCE(m.scope, CASE WHEN t.conversation_id IS NOT NULL THEN 'conversation' ELSE 'customer' END)`;
