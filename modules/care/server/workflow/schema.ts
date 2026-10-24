/**
 * Inbox v2 tables owned by the workflow service: care-only conversation state, internal notes, canned replies.
 * Additive and idempotent; called from `applyExtensions` (persistence/schema.ts) inside its IMMEDIATE transaction, so no
 * CARE_SCHEMA_VERSION bump. This file imports nothing but the DB type: persistence/schema.ts depends on it.
 *
 * `care_conversation_state` is deliberately NOT a column set on `care_conversations`: the projector rewrites that row
 * (status, is_paused, revision), and a person's "done / snoozed / assigned to me" must survive it.
 */

import type Database from 'better-sqlite3';

export function ensureWorkflowSchema(db: Database.Database): void {
  db.exec(`
    -- One row per conversation a person ever touched (created lazily). Times are epoch ms.
    -- workflow 'auto' = no manual status (open/pending is derived from care_conversations.waiting_since).
    CREATE TABLE IF NOT EXISTS care_conversation_state (
      conversation_id    TEXT PRIMARY KEY REFERENCES care_conversations(id) ON DELETE CASCADE,
      workflow           TEXT NOT NULL DEFAULT 'auto' CHECK (workflow IN ('auto','snoozed','done')),
      snoozed_until      INTEGER,
      changed_at         INTEGER,
      assignee_kind      TEXT NOT NULL DEFAULT 'default' CHECK (assignee_kind IN ('default','owner','agent','none')),
      assignee_agent_id  TEXT,
      ai_mode            TEXT CHECK (ai_mode IS NULL OR ai_mode IN ('off','draft','auto')),
      taken_over_at      INTEGER,
      state_revision     INTEGER NOT NULL DEFAULT 1 CHECK (state_revision >= 1),
      updated_at         INTEGER NOT NULL
    );

    -- Internal notes: body encrypted with the Care key; soft-deleted so the event journal ids stay meaningful.
    CREATE TABLE IF NOT EXISTS care_conversation_notes (
      id                TEXT PRIMARY KEY,
      conversation_id   TEXT NOT NULL REFERENCES care_conversations(id) ON DELETE CASCADE,
      client_request_id TEXT NOT NULL UNIQUE,
      body_enc          TEXT NOT NULL,
      author            TEXT NOT NULL DEFAULT 'owner',
      created_at        INTEGER NOT NULL,
      deleted_at        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_care_conversation_notes_conv
      ON care_conversation_notes(conversation_id, created_at, id);

    -- Canned replies: the owner's own templates (not customer content), so plaintext like rule names.
    CREATE TABLE IF NOT EXISTS care_canned_replies (
      id          TEXT PRIMARY KEY,
      shortcut    TEXT NOT NULL UNIQUE,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      email_body  TEXT,
      sort        INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
}
