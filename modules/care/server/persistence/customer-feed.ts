/**
 * Customer change feed: an append-only list of "customer X changed" rows, written by SQLite triggers on
 * care_customers, care_profiles and care_tasks. A trigger runs inside the statement that fired it, so the row is
 * committed (or rolled back) with the write itself, and every write path is covered, including the bridge upserts,
 * the link/unlink reassignments and a raw DELETE.
 *
 * Other modules read it through `ctx.modules.get('care').customers.changesSince(cursor)` and keep their own cursor,
 * so nothing is lost across a restart (in-memory events are; and module events cannot be heard across modules).
 *
 * The feed holds no customer content: ids, entity kind, operation, plaintext enums (stage, done) and timestamps only.
 * Writes that changed nothing leave no row: the UPDATE triggers fire only when a stored column really differs
 * (updateCustomer keeps the ciphertext of an unchanged field, see directory-stores.ts).
 */
import type Database from 'better-sqlite3';

/** epoch milliseconds inside a trigger */
const NOW_MS = `CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)`;

const changed = (cols: string[]) => cols.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');

const CUSTOMER_FIELDS: Array<[column: string, field: string]> = [
  ['display_name_enc', 'ten'],
  ['company_enc', 'cong_ty'],
  ['phone_enc', 'sdt'],
  ['email_enc', 'email'],
  ['tags_enc', 'the'],
  ['owner', 'phu_trach'],
];

/** "ten,sdt" — the names of the customer fields an UPDATE changed (stage is reported separately) */
const changedFieldList = `rtrim(${CUSTOMER_FIELDS.map(([c, f]) => `CASE WHEN OLD.${c} IS NOT NEW.${c} THEN '${f},' ELSE '' END`).join(' || ')}, ',')`;

export const CUSTOMER_FEED_DDL = `
  CREATE TABLE IF NOT EXISTS care_customer_changes (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  TEXT NOT NULL,
    entity       TEXT NOT NULL CHECK (entity IN ('customer','profile','task')),
    entity_id    TEXT NOT NULL,
    op           TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
    detail       TEXT,
    at           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_care_customer_changes_customer ON care_customer_changes(customer_id, seq);

  CREATE TRIGGER IF NOT EXISTS care_customer_changes_customer_ins AFTER INSERT ON care_customers BEGIN
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    VALUES (NEW.id, 'customer', NEW.id, 'insert', json_object('stage', NEW.stage), ${NOW_MS});
  END;
  CREATE TRIGGER IF NOT EXISTS care_customer_changes_customer_upd AFTER UPDATE ON care_customers
  WHEN ${changed(['id', 'stage', ...CUSTOMER_FIELDS.map(([c]) => c)])} BEGIN
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    VALUES (NEW.id, 'customer', NEW.id, 'update',
      json_object('stage_from', CASE WHEN OLD.stage IS NOT NEW.stage THEN OLD.stage END,
                  'stage_to', CASE WHEN OLD.stage IS NOT NEW.stage THEN NEW.stage END,
                  'fields', ${changedFieldList}),
      ${NOW_MS});
  END;
  CREATE TRIGGER IF NOT EXISTS care_customer_changes_customer_del AFTER DELETE ON care_customers BEGIN
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    VALUES (OLD.id, 'customer', OLD.id, 'delete', NULL, ${NOW_MS});
  END;

  CREATE TRIGGER IF NOT EXISTS care_customer_changes_profile_ins AFTER INSERT ON care_profiles BEGIN
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    VALUES (NEW.customer_id, 'profile', NEW.id, 'insert', NULL, ${NOW_MS});
  END;
  -- A bridge replay rewrites the ciphertext but keeps revision and updated_at: not a change. A reassignment to the
  -- same customer bumps the revision but keeps the content: not a change either.
  CREATE TRIGGER IF NOT EXISTS care_customer_changes_profile_upd AFTER UPDATE ON care_profiles
  WHEN ${changed(['customer_id', 'provenance'])}
    OR ((${changed(['revision', 'updated_at'])}) AND (${changed(['need_enc', 'note_enc'])})) BEGIN
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    SELECT OLD.customer_id, 'profile', NEW.id, 'update', json_object('moved_to', NEW.customer_id), ${NOW_MS}
    WHERE OLD.customer_id IS NOT NEW.customer_id;
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    VALUES (NEW.customer_id, 'profile', NEW.id, 'update',
      CASE WHEN OLD.customer_id IS NOT NEW.customer_id THEN json_object('moved_from', OLD.customer_id) END, ${NOW_MS});
  END;
  CREATE TRIGGER IF NOT EXISTS care_customer_changes_profile_del AFTER DELETE ON care_profiles BEGIN
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    VALUES (OLD.customer_id, 'profile', OLD.id, 'delete', NULL, ${NOW_MS});
  END;

  CREATE TRIGGER IF NOT EXISTS care_customer_changes_task_ins AFTER INSERT ON care_tasks BEGIN
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    VALUES (NEW.customer_id, 'task', NEW.id, 'insert', json_object('due', NEW.due_at, 'done', NEW.done), ${NOW_MS});
  END;
  CREATE TRIGGER IF NOT EXISTS care_customer_changes_task_upd AFTER UPDATE ON care_tasks
  WHEN ${changed(['customer_id', 'conversation_id', 'title_enc', 'due_at', 'done', 'owner'])} BEGIN
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    SELECT OLD.customer_id, 'task', NEW.id, 'update', json_object('moved_to', NEW.customer_id), ${NOW_MS}
    WHERE OLD.customer_id IS NOT NEW.customer_id;
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    VALUES (NEW.customer_id, 'task', NEW.id, 'update',
      json_object('done_from', OLD.done, 'done_to', NEW.done, 'due_from', OLD.due_at, 'due_to', NEW.due_at,
                  'moved_from', CASE WHEN OLD.customer_id IS NOT NEW.customer_id THEN OLD.customer_id END),
      ${NOW_MS});
  END;
  CREATE TRIGGER IF NOT EXISTS care_customer_changes_task_del AFTER DELETE ON care_tasks BEGIN
    INSERT INTO care_customer_changes (customer_id, entity, entity_id, op, detail, at)
    VALUES (OLD.customer_id, 'task', OLD.id, 'delete', NULL, ${NOW_MS});
  END;
`;

/** Additive and idempotent (IF NOT EXISTS): rides the extensions of createCareSchema, no version bump. */
export function ensureCustomerFeedSchema(db: Database.Database): void {
  db.exec(CUSTOMER_FEED_DDL);
}

export interface CustomerChange {
  seq: number;
  customerId: string;
  entity: 'customer' | 'profile' | 'task';
  entityId: string;
  op: 'insert' | 'update' | 'delete';
  /** plaintext enums / numbers only (stage_from, stage_to, fields, due, done…) */
  detail: Record<string, unknown> | null;
  atMs: number;
}

const toChange = (r: any): CustomerChange => ({
  seq: Number(r.seq),
  customerId: r.customer_id,
  entity: r.entity,
  entityId: r.entity_id,
  op: r.op,
  detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  atMs: Number(r.at),
});

export class CareCustomerFeed {
  constructor(private readonly db: Database.Database) {}

  /** Rows with seq > cursor, oldest first, at most `limit` (1..1000). `cursor` is the last seq returned (0 = start). */
  changesSince(cursor: number, limit = 200): { changes: CustomerChange[]; cursor: number } {
    const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 1000);
    const after = Math.max(0, Math.trunc(cursor) || 0);
    const rows = this.db.prepare('SELECT * FROM care_customer_changes WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(after, n) as any[];
    const changes = rows.map(toChange);
    return { changes, cursor: changes.length ? changes[changes.length - 1]!.seq : after };
  }

  /** Highest seq written so far (0 when empty). */
  latest(): number {
    const r = this.db.prepare('SELECT MAX(seq) AS s FROM care_customer_changes').get() as { s: number | null };
    return Number(r.s ?? 0);
  }

  /** Newest first: the history of one customer. */
  history(customerId: string, limit = 20): CustomerChange[] {
    const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 200);
    return (this.db.prepare('SELECT * FROM care_customer_changes WHERE customer_id = ? ORDER BY seq DESC LIMIT ?').all(customerId, n) as any[]).map(toChange);
  }

  /** Time of the newest change of a customer, or null. */
  lastChangeAt(customerId: string): number | null {
    const r = this.db.prepare('SELECT at FROM care_customer_changes WHERE customer_id = ? ORDER BY seq DESC LIMIT 1').get(customerId) as
      | { at: number }
      | undefined;
    return r ? Number(r.at) : null;
  }
}
