/**
 * Additive and Idempotent Customer Care Schema
 * All tables, unique constraints, CHECK constraints and indexes for Batch 01.
 *
 * Encryption at rest (AES-256-GCM, `*_enc` columns): message bodies/metadata, customer
 * attributes (name/company/phone/email/tags), identity display attributes, account labels and
 * health notes, conversation titles, assignment instructions, profile notes/needs, task titles,
 * job payloads/errors, credentials, source-journal payloads and optional event replay payloads.
 *
 * Plaintext by design (lookup keys / enums / numbers only): primary keys, account/channel
 * enums, native account IDs, external conversation keys, external identity IDs, native message
 * IDs/namespaces, native order keys, reply-link refs (RFC Message-ID / quoted native ID),
 * timestamps, flags, counters and the scrubbed allowlisted event journal. These are lookup
 * identifiers, not customer content; no blind index is used because no sensitive FIELD depends on it.
 */

import type Database from 'better-sqlite3';
import { CareError } from '../../../_lib/care-kit/errors.js';
import { ensureAgentRunSchema } from './agent-run-store.js';
import { ensureAuditSchema } from './audit-store.js';
import { ensureBridgeAuditSchema } from './bridge-audit.js';
import { ensureOutboxSchema } from './outbox-store.js';
import { ensureOwnershipSchema } from './ownership-store.js';
import { ensureWorkflowSchema } from '../workflow/schema.js';

/**
 * Current schema version.
 *
 *   3  accepted Batch 01 foundation (integrated; may hold real data)
 *   4  Batch 02 legacy bridges: capture registry, bridge state, non-dispatching artifacts,
 *      journal retention pins, journal indexes, assignment policy extensions
 *
 * Versions are migrated ONE step at a time by an additive migration (CREATE ... IF NOT EXISTS /
 * ADD COLUMN), inside the same IMMEDIATE transaction that bumps the stored version. Anything
 * else (older than the oldest migratable version, newer than this runtime, malformed, or
 * unversioned care_* tables) is refused rather than layered on.
 */
export const CARE_SCHEMA_VERSION = 4;

/** Oldest stored version a migration path exists for. */
const OLDEST_MIGRATABLE_VERSION = 3;

function careTableNames(db: Database.Database): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'care\\_%' ESCAPE '\\'`).all() as Array<{
      name: string;
    }>
  ).map((t) => t.name);
}

type SchemaState = { kind: 'fresh' } | { kind: 'versioned'; version: number };

/**
 * Pure inspection (no writes). Throws for anything that is neither a fresh install nor a
 * version this runtime can run or migrate.
 *  - no care_* tables at all                      -> fresh
 *  - stored version in [oldest migratable, current] -> versioned (migrated if older)
 *  - anything else (older, newer, negative, non-numeric, missing row with tables present)
 *                                                   -> refuse; never mutate unsupported tables
 */
function inspectSchema(db: Database.Database): SchemaState {
  const tables = careTableNames(db);
  if (tables.length === 0) return { kind: 'fresh' };

  if (!tables.includes('care_schema_meta')) {
    throw new CareError(
      'CONFIGURATION_CONFLICT',
      'Found unversioned care_* tables (pre-release layout); refusing to run until they are migrated or dropped',
      500,
    );
  }
  const row = db.prepare(`SELECT value FROM care_schema_meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  const version = row && /^\d{1,6}$/.test(row.value) && String(Number(row.value)) === row.value ? Number(row.value) : NaN;
  if (!Number.isInteger(version) || version < OLDEST_MIGRATABLE_VERSION || version > CARE_SCHEMA_VERSION) {
    throw new CareError(
      'CONFIGURATION_CONFLICT',
      `Care schema version '${row?.value ?? 'missing'}' is not supported by this runtime (supports ${OLDEST_MIGRATABLE_VERSION}..${CARE_SCHEMA_VERSION}); refusing to run`,
      500,
    );
  }
  return { kind: 'versioned', version };
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string): void {
  if (!columnNames(db, table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * v3 -> v4, ADDITIVE ONLY. Idempotent (every statement is IF NOT EXISTS / guarded), and it is also
 * what a fresh install runs after the v3 base tables, so a migrated database and a fresh one end
 * up with the same layout. Existing rows are never rewritten.
 */
function applyV4Additions(db: Database.Database): void {
  db.exec(`
    -- Which source accounts are captured, and the Care account each one maps to (stable ID).
    -- Read by the capture triggers themselves, so it applies to EVERY writer connection.
    CREATE TABLE IF NOT EXISTS care_capture_accounts (
      source_kind        TEXT NOT NULL CHECK (source_kind IN ('zalo','email')),
      source_account_id  TEXT NOT NULL,
      care_account_id    TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
      enabled_at         INTEGER,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      PRIMARY KEY(source_kind, source_account_id),
      UNIQUE(care_account_id)
    );

    -- Per-account bridge progress: snapshot watermark, chunk cursors and the journal position
    -- already replayed. Chunk effects + links + this row change in ONE transaction.
    CREATE TABLE IF NOT EXISTS care_bridge_state (
      care_account_id    TEXT PRIMARY KEY REFERENCES care_accounts(id) ON DELETE CASCADE,
      source_kind        TEXT NOT NULL,
      source_account_id  TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'enabled'
                         CHECK (status IN ('enabled','backfilling','backfilled','disabled')),
      watermark_s0       INTEGER NOT NULL DEFAULT 0,
      cursors_json       TEXT NOT NULL DEFAULT '{}',
      applied_seq        INTEGER NOT NULL DEFAULT 0,
      backfill_done_at   INTEGER,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );

    -- Non-dispatching mirrors of legacy state that has no canonical Care entity yet
    -- (outbox/draft/attempt states, agent runs, campaigns, account config, kind-wide
    -- assignments). Nothing ever reads these to send; they exist so a later cutover has the
    -- exact source state and a verifier can compare it.
    CREATE TABLE IF NOT EXISTS care_bridge_artifacts (
      id               TEXT PRIMARY KEY,
      account_id       TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      source_kind      TEXT NOT NULL,
      source_table     TEXT NOT NULL,
      source_id        TEXT NOT NULL,
      state            TEXT,
      source_deleted   INTEGER NOT NULL DEFAULT 0 CHECK (source_deleted IN (0,1)),
      source_version   INTEGER NOT NULL DEFAULT 0,
      payload_enc      TEXT NOT NULL,
      dispatchable     INTEGER NOT NULL DEFAULT 0 CHECK (dispatchable = 0),
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      UNIQUE(source_kind, source_table, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_care_bridge_artifacts_lookup
      ON care_bridge_artifacts(account_id, source_table, state);

    -- Journal retention pins: while a migration/replayer is active, nothing at or after
    -- min_seq may be purged for that account.
    CREATE TABLE IF NOT EXISTS care_journal_pins (
      care_account_id  TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      consumer         TEXT NOT NULL,
      min_seq          INTEGER NOT NULL,
      created_at       INTEGER NOT NULL,
      PRIMARY KEY(care_account_id, consumer)
    );

    CREATE INDEX IF NOT EXISTS idx_care_source_journal_row
      ON care_source_journal(source_kind, source_table, source_id, seq);
    CREATE INDEX IF NOT EXISTS idx_care_source_journal_account
      ON care_source_journal(account_id, seq);
  `);

  // Native policy extensions of a legacy assignment (primaryOnly, delays, human pause, quotas,
  // triggers, review keywords, instructions text...). Encrypted; opaque to routing.
  addColumnIfMissing(db, 'care_assignments', 'policy_ext_enc', 'TEXT');
}

/** One-step migrations keyed by the version they upgrade FROM. */
const MIGRATIONS: Record<number, (db: Database.Database) => void> = {
  3: applyV4Additions,
};

/**
 * Tables owned by later work packages (CC-10..CC-19). Additive and idempotent; they ride the same
 * IMMEDIATE transaction and need no version bump of their own while they only add tables/columns.
 */
function applyExtensions(db: Database.Database): void {
  ensureOutboxSchema(db);
  ensureOwnershipSchema(db);
  ensureAgentRunSchema(db);
  ensureAuditSchema(db);
  ensureBridgeAuditSchema(db);
  ensureWorkflowSchema(db);
  ensurePerformanceIndexes(db);
}

/**
 * Indexes added after CC-23 query-plan review (docs/plans/customer-care/evidence/cc-23-regression-benchmarks.md).
 * Each one removes a full SCAN of a big table from a hot read, or the O(history) journal version
 * lookup on a hot legacy row. Additive and idempotent (IF NOT EXISTS), so no schema version bump: an
 * older binary simply ignores them. Exported for the regression test that proves they stay present.
 */
export const PERFORMANCE_INDEXES: readonly string[] = [
  // GET /customers (recent) and the q-scan: ORDER BY updated_at DESC, id DESC
  'CREATE INDEX IF NOT EXISTS idx_care_customers_recent ON care_customers(updated_at DESC, id DESC)',
  // Customer 360 / conversation panel / GET /tasks?customer= : tasks by customer, conversation, global due order
  'CREATE INDEX IF NOT EXISTS idx_care_tasks_customer ON care_tasks(customer_id, due_at, id)',
  'CREATE INDEX IF NOT EXISTS idx_care_tasks_conversation ON care_tasks(conversation_id, due_at, id) WHERE conversation_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_care_tasks_due_id ON care_tasks(due_at, id)',
  // GET /status: SELECT DISTINCT status FROM care_conversations. Leading column is status, followed by the inbox sort keys,
  // so the inbox status filter (WHERE status = ? ORDER BY last_message_at DESC, id DESC) uses it without a temp sort. A
  // status-only index was tried first and made the planner pick it (plus a TEMP B-TREE sort) for that filter.
  'CREATE INDEX IF NOT EXISTS idx_care_conversations_status_recent ON care_conversations(status, last_message_at DESC, id DESC)',
  // GET /health: GROUP BY account_id, job_type, status over the whole job history (covering)
  'CREATE INDEX IF NOT EXISTS idx_care_jobs_health ON care_jobs(account_id, job_type, status, due_at, lease_expires_at)',
  // Customer timeline (audit.timelineMessageIds), three index lookups instead of an OR over every conversation:
  // messages by sender identity, and the conversations a customer is primary of (an index on either alone did not remove
  // the scan while the query was a single OR; both are needed by the UNION rewrite)
  'CREATE INDEX IF NOT EXISTS idx_care_messages_sender ON care_messages(sender_identity_id, sent_at DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_care_conversations_customer ON care_conversations(primary_customer_id) WHERE primary_customer_id IS NOT NULL',
  // capture trigger: MAX(source_version) for a hot row (zalo_threads is updated once per message)
  'CREATE INDEX IF NOT EXISTS idx_care_source_journal_row_ver ON care_source_journal(source_kind, source_table, source_id, source_version)',
];

function ensurePerformanceIndexes(db: Database.Database): void {
  for (const ddl of PERFORMANCE_INDEXES) db.exec(ddl);
}

function setVersion(db: Database.Database, version: number): void {
  db.prepare(`INSERT INTO care_schema_meta (key, value) VALUES ('schema_version', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(version));
}

export function createCareSchema(db: Database.Database): void {
  const apply = db.transaction(() => {
    const state = inspectSchema(db);
    if (state.kind === 'fresh') {
      createTables(db); // the accepted v3 base layout (+ meta table)
      applyV4Additions(db);
      applyExtensions(db);
      setVersion(db, CARE_SCHEMA_VERSION);
      return;
    }
    let version = state.version;
    while (version < CARE_SCHEMA_VERSION) {
      const migrate = MIGRATIONS[version];
      if (!migrate) {
        throw new CareError('CONFIGURATION_CONFLICT', `No Care schema migration from version ${version}`, 500);
      }
      migrate(db);
      version += 1;
      setVersion(db, version);
    }
    // Same-version re-run: additive statements are no-ops, but keep the layout self-healing.
    createTables(db);
    applyV4Additions(db);
    applyExtensions(db);
  });
  // IMMEDIATE: the compatibility check, the migration and the DDL must hold the write lock
  // together. A deferred transaction would read, then fail with SQLITE_BUSY on the lock upgrade
  // when several agent processes boot against one database at once (the busy timeout cannot
  // help an upgrade).
  apply.immediate();
}

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS care_schema_meta (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );

    -- 1. Accounts: channel + connector kind + native account ID. Everything is OFF by default.
    CREATE TABLE IF NOT EXISTS care_accounts (
      id                 TEXT PRIMARY KEY,
      channel            TEXT NOT NULL CHECK (channel IN ('zalo','telegram','email')),
      connector_kind     TEXT NOT NULL,
      native_account_id  TEXT NOT NULL,
      label_enc          TEXT NOT NULL,
      health_note_enc    TEXT,
      credential_ref     TEXT,
      desired_state      TEXT NOT NULL DEFAULT 'paused'
                         CHECK (desired_state IN ('active','paused','draining','disconnected')),
      health_status      TEXT NOT NULL DEFAULT 'healthy' CHECK (health_status IN ('healthy','degraded','error')),
      sync_enabled       INTEGER NOT NULL DEFAULT 0 CHECK (sync_enabled IN (0,1)),
      send_enabled       INTEGER NOT NULL DEFAULT 0 CHECK (send_enabled IN (0,1)),
      ai_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (ai_enabled IN (0,1)),
      write_owner        TEXT NOT NULL DEFAULT 'legacy' CHECK (write_owner IN ('legacy','draining','core')),
      owner_epoch        INTEGER NOT NULL DEFAULT 1 CHECK (owner_epoch >= 1),
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      UNIQUE(channel, connector_kind, native_account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_care_accounts_lookup
      ON care_accounts(channel, desired_state, write_owner);

    -- 2. Customers: Customer 360 profile, independent of channel (attributes encrypted)
    CREATE TABLE IF NOT EXISTS care_customers (
      id               TEXT PRIMARY KEY,
      display_name_enc TEXT NOT NULL,
      company_enc      TEXT,
      phone_enc        TEXT,
      email_enc        TEXT,
      stage            TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','consulting','quoted','deposit','won','lost')),
      tags_enc         TEXT,
      owner            TEXT,
      revision         INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_care_customers_stage
      ON care_customers(stage, updated_at DESC);

    -- 3. Identities: Contact identity per account + namespace + external ID
    CREATE TABLE IF NOT EXISTS care_identities (
      id                   TEXT PRIMARY KEY,
      customer_id          TEXT NOT NULL REFERENCES care_customers(id) ON DELETE RESTRICT,
      account_id           TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      namespace            TEXT NOT NULL,
      external_identity_id TEXT NOT NULL,
      display_name_enc     TEXT,
      username_enc         TEXT,
      avatar_url_enc       TEXT,
      verified             INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      UNIQUE(account_id, namespace, external_identity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_care_identities_customer
      ON care_identities(customer_id);

    -- 4. Conversations: Channel conversation projection
    CREATE TABLE IF NOT EXISTS care_conversations (
      id                      TEXT PRIMARY KEY,
      account_id              TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      external_key            TEXT NOT NULL,
      kind                    TEXT NOT NULL CHECK (kind IN ('direct','group','topic','email_thread')),
      title_enc               TEXT NOT NULL,
      primary_customer_id     TEXT REFERENCES care_customers(id) ON DELETE SET NULL,
      status                  TEXT NOT NULL DEFAULT 'active',
      is_paused               INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0,1)),
      paused_until            INTEGER,
      is_opted_out            INTEGER NOT NULL DEFAULT 0 CHECK (is_opted_out IN (0,1)),
      waiting_since           INTEGER,
      remote_unread_count     INTEGER NOT NULL DEFAULT 0 CHECK (remote_unread_count >= 0),
      local_seen_message_id   TEXT REFERENCES care_messages(id) ON DELETE SET NULL,
      -- Provider read coverage in NATIVE coordinates (box + order key, or timestamp when unordered);
      -- the *_message_id columns are only a convenience link to the resolved local row.
      remote_read_message_id  TEXT REFERENCES care_messages(id) ON DELETE SET NULL,
      remote_read_ns          TEXT,
      remote_read_key         TEXT,
      remote_read_sent_at     INTEGER,
      remote_receipt_message_id TEXT REFERENCES care_messages(id) ON DELETE SET NULL,
      remote_receipt_ns       TEXT,
      remote_receipt_key      TEXT,
      remote_receipt_sent_at  INTEGER,
      last_message_id         TEXT REFERENCES care_messages(id) ON DELETE SET NULL,
      last_message_at         INTEGER NOT NULL DEFAULT 0,
      revision                INTEGER NOT NULL DEFAULT 1,
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL,
      UNIQUE(account_id, external_key)
    );

    CREATE INDEX IF NOT EXISTS idx_care_conversations_inbox
      ON care_conversations(account_id, last_message_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_care_conversations_waiting
      ON care_conversations(waiting_since) WHERE waiting_since IS NOT NULL;

    -- 5. Messages: Canonical messages with encrypted body, encrypted metadata and tombstones
    CREATE TABLE IF NOT EXISTS care_messages (
      id                        TEXT PRIMARY KEY,
      conversation_id           TEXT NOT NULL REFERENCES care_conversations(id) ON DELETE CASCADE,
      account_id                TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      native_message_namespace  TEXT NOT NULL,
      native_message_id         TEXT NOT NULL,
      native_version            TEXT,
      direction                 TEXT NOT NULL CHECK (direction IN ('in','out')),
      sender_identity_id        TEXT REFERENCES care_identities(id) ON DELETE SET NULL,
      sender_role               TEXT NOT NULL CHECK (sender_role IN ('customer','self','operator','agent','system')),
      body_enc                  TEXT NOT NULL,
      metadata_enc              TEXT NOT NULL,
      origin                    TEXT NOT NULL CHECK (origin IN ('live','history','recovery')),
      sent_at                   INTEGER NOT NULL CHECK (sent_at >= 0),
      native_order_key          TEXT,
      ref_id                    TEXT,
      reply_to_ref              TEXT,
      live_observed             INTEGER NOT NULL DEFAULT 0 CHECK (live_observed IN (0,1)),
      directed_at_account       INTEGER NOT NULL DEFAULT 0 CHECK (directed_at_account IN (0,1)),
      is_deleted                INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
      deleted_at                INTEGER,
      tombstone                 INTEGER NOT NULL DEFAULT 0 CHECK (tombstone IN (0,1)),
      created_at                INTEGER NOT NULL,
      UNIQUE(account_id, native_message_namespace, native_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_care_messages_timeline
      ON care_messages(conversation_id, sent_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_care_messages_lookup
      ON care_messages(account_id, native_message_namespace, native_message_id);
    CREATE INDEX IF NOT EXISTS idx_care_messages_projection
      ON care_messages(conversation_id, direction, sender_role, is_deleted, sent_at);
    CREATE INDEX IF NOT EXISTS idx_care_messages_reply_ref
      ON care_messages(conversation_id, reply_to_ref) WHERE reply_to_ref IS NOT NULL;

    -- 5b. Tombstones for deletes that arrived BEFORE the message (peer may be unknown: Telegram
    --     common-box delete updates carry IDs only). Bound to a conversation when the message shows up.
    CREATE TABLE IF NOT EXISTS care_tombstones (
      account_id                TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      native_message_namespace  TEXT NOT NULL,
      native_message_id         TEXT NOT NULL,
      external_conversation_key TEXT,
      deleted_at                INTEGER NOT NULL,
      created_at                INTEGER NOT NULL,
      PRIMARY KEY(account_id, native_message_namespace, native_message_id)
    );

    -- 5c. Provider read receipts whose target message is not held yet. Durable effect of the
    --     original provider event (account + event_id); resolved when the target lands.
    CREATE TABLE IF NOT EXISTS care_pending_receipts (
      account_id                TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      event_id                  TEXT NOT NULL,
      external_conversation_key TEXT NOT NULL,
      native_message_namespace  TEXT,
      native_message_id         TEXT NOT NULL,
      direction                 TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
      created_at                INTEGER NOT NULL,
      PRIMARY KEY(account_id, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_care_pending_receipts_target
      ON care_pending_receipts(account_id, native_message_id);

    -- 6. Sync State: adapter-owned typed checkpoints per account + checkpoint box
    CREATE TABLE IF NOT EXISTS care_sync_state (
      account_id        TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      cursor_namespace  TEXT NOT NULL,
      opaque_cursor     TEXT NOT NULL,
      position          TEXT,
      revision          INTEGER NOT NULL DEFAULT 1,
      covered_until     INTEGER,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY(account_id, cursor_namespace)
    );

    -- 7. Events Journal: durable event stream; ledger key is (account_id, event_id)
    CREATE TABLE IF NOT EXISTS care_events (
      seq                  INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id             TEXT NOT NULL,
      account_id           TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      conversation_id      TEXT,
      event_type           TEXT NOT NULL,
      checkpoint_namespace TEXT,
      checkpoint_cursor    TEXT,
      epoch                INTEGER NOT NULL DEFAULT 1,
      payload_json         TEXT NOT NULL,
      replay_enc           TEXT,
      created_at           INTEGER NOT NULL,
      UNIQUE(account_id, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_care_events_seq
      ON care_events(seq);
    CREATE INDEX IF NOT EXISTS idx_care_events_account
      ON care_events(account_id, seq);

    -- 8. Jobs Queue: durable job claim/lease with epoch guard and claim token (payload encrypted)
    CREATE TABLE IF NOT EXISTS care_jobs (
      id                TEXT PRIMARY KEY,
      account_id        TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      job_type          TEXT NOT NULL CHECK (job_type IN ('inbound_turn','outbox_dispatch','sync_poll','cleanup')),
      conversation_id   TEXT REFERENCES care_conversations(id) ON DELETE SET NULL,
      dedupe_key        TEXT,
      payload_enc       TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','completed','failed')),
      owner_epoch       INTEGER NOT NULL DEFAULT 1,
      claim_token       TEXT,
      claim_generation  INTEGER NOT NULL DEFAULT 0,
      lease_owner       TEXT,
      lease_expires_at  INTEGER,
      due_at            INTEGER NOT NULL,
      attempts          INTEGER NOT NULL DEFAULT 0,
      max_attempts      INTEGER NOT NULL DEFAULT 5,
      last_error_enc    TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_care_jobs_dedupe
      ON care_jobs(account_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_care_jobs_claim
      ON care_jobs(status, due_at, owner_epoch);

    -- 9. Source Journal: Replay log for legacy bridge and cutover
    CREATE TABLE IF NOT EXISTS care_source_journal (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id      TEXT NOT NULL,
      source_kind     TEXT NOT NULL,
      source_table    TEXT NOT NULL,
      source_id       TEXT NOT NULL,
      operation       TEXT NOT NULL CHECK (operation IN ('insert','update','delete')),
      source_version  INTEGER NOT NULL DEFAULT 1,
      payload_enc     TEXT NOT NULL,
      applied_at      INTEGER,
      created_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_care_source_journal_seq
      ON care_source_journal(seq);
    CREATE INDEX IF NOT EXISTS idx_care_source_journal_applied
      ON care_source_journal(applied_at);

    -- 10. Legacy Links: Mapping between canonical IDs and legacy source rows
    CREATE TABLE IF NOT EXISTS care_legacy_links (
      canonical_id      TEXT NOT NULL,
      canonical_entity  TEXT NOT NULL,
      source_kind       TEXT NOT NULL,
      legacy_table      TEXT NOT NULL,
      legacy_id         TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      PRIMARY KEY(source_kind, legacy_table, legacy_id),
      UNIQUE(canonical_entity, canonical_id)
    );

    -- 11. Migration Runs: Metadata and watermarks for cutover rehearsal
    CREATE TABLE IF NOT EXISTS care_migration_runs (
      run_id           TEXT PRIMARY KEY,
      account_id       TEXT NOT NULL,
      status           TEXT NOT NULL,
      watermark_s0     INTEGER,
      watermark_s1     INTEGER,
      final_watermark  INTEGER,
      metadata_json    TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    -- 12. Credentials: Strict encrypted credentials per account
    CREATE TABLE IF NOT EXISTS care_credentials (
      id               TEXT PRIMARY KEY,
      account_id       TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      credential_type  TEXT NOT NULL,
      payload_enc      TEXT NOT NULL,
      revision         INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      UNIQUE(account_id, credential_type)
    );

    -- 13. Assignments: routing rules. Scope shape is enforced by the database, not only by stores:
    --     global/channel carry no account, customer carries a customer, the rest are account scoped.
    CREATE TABLE IF NOT EXISTS care_assignments (
      id                    TEXT PRIMARY KEY,
      account_id            TEXT REFERENCES care_accounts(id) ON DELETE CASCADE,
      customer_id           TEXT REFERENCES care_customers(id) ON DELETE CASCADE,
      scope                 TEXT NOT NULL
                            CHECK (scope IN ('conversation','customer','identity','domain','account','channel','global')),
      scope_target          TEXT,
      channel               TEXT CHECK (channel IS NULL OR channel IN ('zalo','telegram','email')),
      priority              INTEGER NOT NULL DEFAULT 0,
      enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      mode                  TEXT NOT NULL DEFAULT 'draft' CHECK (mode IN ('observe','draft','auto')),
      agent_id              TEXT,
      instructions_ref_enc  TEXT,
      config_version        INTEGER NOT NULL DEFAULT 1,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      CHECK (
        (scope = 'global'  AND account_id IS NULL AND channel IS NULL AND customer_id IS NULL) OR
        (scope = 'channel' AND account_id IS NULL AND channel IS NOT NULL AND customer_id IS NULL) OR
        (scope = 'customer' AND customer_id IS NOT NULL) OR
        (scope = 'account' AND account_id IS NOT NULL AND customer_id IS NULL) OR
        (scope IN ('conversation','identity','domain') AND account_id IS NOT NULL
           AND scope_target IS NOT NULL AND customer_id IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_care_assignments_lookup
      ON care_assignments(account_id, scope, priority DESC);

    -- 14. Customer Profiles: Customer-wide care notes and needs (encrypted at rest)
    CREATE TABLE IF NOT EXISTS care_profiles (
      id           TEXT PRIMARY KEY,
      customer_id  TEXT NOT NULL REFERENCES care_customers(id) ON DELETE CASCADE,
      account_id   TEXT REFERENCES care_accounts(id) ON DELETE SET NULL,
      provenance   TEXT NOT NULL DEFAULT 'canonical',
      need_enc     TEXT,
      note_enc     TEXT,
      revision     INTEGER NOT NULL DEFAULT 1,
      updated_at   INTEGER NOT NULL,
      created_at   INTEGER NOT NULL
    );

    -- 15. Tasks: Tasks associated with Customer 360 (title encrypted at rest)
    CREATE TABLE IF NOT EXISTS care_tasks (
      id               TEXT PRIMARY KEY,
      customer_id      TEXT NOT NULL REFERENCES care_customers(id) ON DELETE CASCADE,
      conversation_id  TEXT REFERENCES care_conversations(id) ON DELETE SET NULL,
      title_enc        TEXT NOT NULL,
      due_at           INTEGER NOT NULL,
      done             INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
      owner            TEXT,
      revision         INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_care_tasks_due
      ON care_tasks(done, due_at);
  `);
}
