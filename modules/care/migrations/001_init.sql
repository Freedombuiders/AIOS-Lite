-- care: full schema (generated from createCareSchema; the code stays idempotent and re-applies it on Add)
CREATE TABLE IF NOT EXISTS care_schema_meta (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );

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

CREATE TABLE IF NOT EXISTS care_tombstones (
      account_id                TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      native_message_namespace  TEXT NOT NULL,
      native_message_id         TEXT NOT NULL,
      external_conversation_key TEXT,
      deleted_at                INTEGER NOT NULL,
      created_at                INTEGER NOT NULL,
      PRIMARY KEY(account_id, native_message_namespace, native_message_id)
    );

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
      updated_at            INTEGER NOT NULL, policy_ext_enc TEXT,
      CHECK (
        (scope = 'global'  AND account_id IS NULL AND channel IS NULL AND customer_id IS NULL) OR
        (scope = 'channel' AND account_id IS NULL AND channel IS NOT NULL AND customer_id IS NULL) OR
        (scope = 'customer' AND customer_id IS NOT NULL) OR
        (scope = 'account' AND account_id IS NOT NULL AND customer_id IS NULL) OR
        (scope IN ('conversation','identity','domain') AND account_id IS NOT NULL
           AND scope_target IS NOT NULL AND customer_id IS NULL)
      )
    );

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

CREATE TABLE IF NOT EXISTS care_journal_pins (
      care_account_id  TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      consumer         TEXT NOT NULL,
      min_seq          INTEGER NOT NULL,
      created_at       INTEGER NOT NULL,
      PRIMARY KEY(care_account_id, consumer)
    );

CREATE TABLE IF NOT EXISTS care_delivery_intents (
      id                  TEXT PRIMARY KEY,
      account_id          TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      conversation_id     TEXT REFERENCES care_conversations(id) ON DELETE SET NULL,
      client_request_id   TEXT NOT NULL,
      actor               TEXT NOT NULL CHECK (actor IN ('manual','approved','auto')),
      purpose             TEXT NOT NULL CHECK (purpose IN ('care','campaign')),
      status              TEXT NOT NULL CHECK (status IN ('draft','pending','sending','sent','retry_wait','uncertain','needs_review','failed','cancelled','discarded')),
      status_reason       TEXT,
      channel             TEXT NOT NULL CHECK (channel IN ('zalo','telegram','email')),
      payload_enc         TEXT NOT NULL,
      payload_hash        TEXT NOT NULL,
      payload_revision    INTEGER NOT NULL DEFAULT 1 CHECK (payload_revision >= 1),
      approved_revision   INTEGER,
      context_revision    INTEGER,
      policy_revision     TEXT,
      reply_message_id    TEXT,
      adapter_retry_token TEXT NOT NULL,
      source_run_id       TEXT,
      created_by_enc      TEXT,
      approved_by_enc     TEXT,
      queue_seq           INTEGER,
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      max_attempts        INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
      next_attempt_at     INTEGER NOT NULL DEFAULT 0,
      owner_epoch         INTEGER NOT NULL CHECK (owner_epoch >= 1),
      lease_owner         TEXT,
      lease_expires_at    INTEGER,
      claim_token         TEXT,
      claim_generation    INTEGER NOT NULL DEFAULT 0,
      last_claim_seq      INTEGER NOT NULL DEFAULT 0,
      receipt_level       TEXT CHECK (receipt_level IS NULL OR receipt_level IN ('accepted','delivered','read')),
      canonical_message_id TEXT,
      last_error_code     TEXT,
      last_error_enc      TEXT,
      transition_seq      INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      sent_at             INTEGER,
      UNIQUE(account_id, client_request_id)
    );

CREATE TABLE IF NOT EXISTS care_delivery_attempts (
      id                TEXT PRIMARY KEY,
      intent_id         TEXT NOT NULL REFERENCES care_delivery_intents(id) ON DELETE CASCADE,
      account_id        TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      attempt_no        INTEGER NOT NULL CHECK (attempt_no >= 1),
      request_token     TEXT NOT NULL,
      owner_epoch       INTEGER NOT NULL CHECK (owner_epoch >= 1),
      claim_token       TEXT,
      worker_id         TEXT,
      outcome           TEXT CHECK (outcome IS NULL OR outcome IN ('accepted','uncertain','retryable','terminal','review')),
      receipt_level     TEXT CHECK (receipt_level IS NULL OR receipt_level IN ('accepted','delivered','read')),
      native_message_id TEXT,
      remote_timestamp  INTEGER,
      error_code        TEXT,
      error_enc         TEXT,
      started_at        INTEGER NOT NULL,
      finished_at       INTEGER,
      UNIQUE(intent_id, attempt_no)
    );

CREATE TABLE IF NOT EXISTS care_account_holders (
      account_id     TEXT PRIMARY KEY REFERENCES care_accounts(id) ON DELETE CASCADE,
      role           TEXT NOT NULL CHECK (role IN ('core','legacy')),
      holder_id      TEXT NOT NULL,
      process_token  TEXT NOT NULL,
      pid            INTEGER,
      host           TEXT,
      generation     INTEGER NOT NULL CHECK (generation >= 1),
      lock_seq       INTEGER NOT NULL CHECK (lock_seq >= 1),
      acquired_at    INTEGER NOT NULL,
      heartbeat_at   INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL,
      released_at    INTEGER
    );

CREATE TABLE IF NOT EXISTS care_runtime_switches (
      switch_key     TEXT PRIMARY KEY,
      enabled        INTEGER NOT NULL CHECK (enabled IN (0,1)),
      enabled_since  INTEGER,
      changed_at     INTEGER NOT NULL,
      changed_by     TEXT NOT NULL,
      reason         TEXT
    );

CREATE TABLE IF NOT EXISTS care_runtime_switch_log (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      switch_key  TEXT NOT NULL,
      from_state  INTEGER,
      to_state    INTEGER NOT NULL,
      actor       TEXT NOT NULL,
      reason      TEXT,
      at          INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS care_backlog_holds (
      item_kind    TEXT NOT NULL,
      item_id      TEXT NOT NULL,
      account_id   TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('held','released','discarded')),
      held_at      INTEGER NOT NULL,
      cutoff_at    INTEGER NOT NULL,
      reason       TEXT NOT NULL,
      held_by      TEXT NOT NULL,
      resolved_at  INTEGER,
      resolved_by  TEXT,
      PRIMARY KEY (item_kind, item_id)
    );

CREATE TABLE IF NOT EXISTS care_legacy_inflight (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind       TEXT NOT NULL CHECK (source_kind IN ('zalo','email')),
      source_account_id TEXT NOT NULL,
      path              TEXT NOT NULL,
      started_at        INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS care_cutover_log (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      id              TEXT NOT NULL UNIQUE,
      account_id      TEXT NOT NULL,
      from_owner      TEXT NOT NULL,
      to_owner        TEXT NOT NULL,
      epoch_before    INTEGER NOT NULL,
      epoch_after     INTEGER,
      transition_kind TEXT NOT NULL CHECK (transition_kind IN ('forward','rollback','abort')),
      outcome         TEXT NOT NULL CHECK (outcome IN ('applied','refused')),
      refusal_codes   TEXT,
      actor           TEXT NOT NULL,
      reason          TEXT NOT NULL,
      evidence_json   TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS care_agent_runs (
      id                  TEXT PRIMARY KEY,
      account_id          TEXT NOT NULL REFERENCES care_accounts(id) ON DELETE CASCADE,
      conversation_id     TEXT NOT NULL REFERENCES care_conversations(id) ON DELETE CASCADE,
      trigger_message_id  TEXT NOT NULL REFERENCES care_messages(id) ON DELETE CASCADE,
      context_revision    INTEGER NOT NULL,
      policy_revision     TEXT NOT NULL,
      assignment_id       TEXT,
      agent_id            TEXT NOT NULL DEFAULT '',
      mode                TEXT CHECK (mode IS NULL OR mode IN ('observe','draft','auto')),
      trigger_kind        TEXT NOT NULL DEFAULT 'inbound' CHECK (trigger_kind IN ('inbound','manual')),
      status              TEXT NOT NULL CHECK (status IN ('running','skipped','failed','drafted')),
      skip_reason         TEXT,
      decision_enc        TEXT,
      draft_ref           TEXT,
      model_called        INTEGER NOT NULL DEFAULT 0 CHECK (model_called IN (0,1)),
      latency_ms          INTEGER,
      cost_usd            REAL NOT NULL DEFAULT 0,
      cost_source         TEXT NOT NULL DEFAULT 'placeholder' CHECK (cost_source IN ('placeholder','provider')),
      attempts            INTEGER NOT NULL DEFAULT 1,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      UNIQUE(conversation_id, trigger_message_id, context_revision, trigger_kind)
    );

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

CREATE TABLE IF NOT EXISTS care_identity_membership_history (
      seq                INTEGER PRIMARY KEY AUTOINCREMENT,
      link_event_id      TEXT NOT NULL,
      identity_id        TEXT NOT NULL,
      from_customer_id   TEXT NOT NULL,
      to_customer_id     TEXT NOT NULL,
      kind               TEXT NOT NULL CHECK (kind IN ('link','unlink')),
      created_at         INTEGER NOT NULL
    );

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

CREATE TABLE IF NOT EXISTS care_task_meta (
      task_id            TEXT PRIMARY KEY REFERENCES care_tasks(id) ON DELETE CASCADE,
      scope              TEXT NOT NULL CHECK (scope IN ('customer','account','conversation')),
      account_id         TEXT,
      source_message_id  TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS care_bridge_audit (
      seq               INTEGER PRIMARY KEY AUTOINCREMENT,
      id                TEXT NOT NULL UNIQUE,
      action            TEXT NOT NULL,
      source_kind       TEXT NOT NULL,
      source_account_id TEXT NOT NULL,
      care_account_id   TEXT NOT NULL,
      actor             TEXT NOT NULL,
      reason            TEXT NOT NULL,
      outcome           TEXT NOT NULL,
      detail_json       TEXT NOT NULL DEFAULT '{}',
      created_at        INTEGER NOT NULL
    );

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

CREATE TABLE IF NOT EXISTS care_conversation_notes (
      id                TEXT PRIMARY KEY,
      conversation_id   TEXT NOT NULL REFERENCES care_conversations(id) ON DELETE CASCADE,
      client_request_id TEXT NOT NULL UNIQUE,
      body_enc          TEXT NOT NULL,
      author            TEXT NOT NULL DEFAULT 'owner',
      created_at        INTEGER NOT NULL,
      deleted_at        INTEGER
    );

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

CREATE INDEX IF NOT EXISTS idx_care_accounts_lookup
      ON care_accounts(channel, desired_state, write_owner);

CREATE INDEX IF NOT EXISTS idx_care_customers_stage
      ON care_customers(stage, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_care_identities_customer
      ON care_identities(customer_id);

CREATE INDEX IF NOT EXISTS idx_care_conversations_inbox
      ON care_conversations(account_id, last_message_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_care_conversations_waiting
      ON care_conversations(waiting_since) WHERE waiting_since IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_care_messages_timeline
      ON care_messages(conversation_id, sent_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_care_messages_lookup
      ON care_messages(account_id, native_message_namespace, native_message_id);

CREATE INDEX IF NOT EXISTS idx_care_messages_projection
      ON care_messages(conversation_id, direction, sender_role, is_deleted, sent_at);

CREATE INDEX IF NOT EXISTS idx_care_messages_reply_ref
      ON care_messages(conversation_id, reply_to_ref) WHERE reply_to_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_care_pending_receipts_target
      ON care_pending_receipts(account_id, native_message_id);

CREATE INDEX IF NOT EXISTS idx_care_events_seq
      ON care_events(seq);

CREATE INDEX IF NOT EXISTS idx_care_events_account
      ON care_events(account_id, seq);

CREATE UNIQUE INDEX IF NOT EXISTS idx_care_jobs_dedupe
      ON care_jobs(account_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_care_jobs_claim
      ON care_jobs(status, due_at, owner_epoch);

CREATE INDEX IF NOT EXISTS idx_care_source_journal_seq
      ON care_source_journal(seq);

CREATE INDEX IF NOT EXISTS idx_care_source_journal_applied
      ON care_source_journal(applied_at);

CREATE INDEX IF NOT EXISTS idx_care_assignments_lookup
      ON care_assignments(account_id, scope, priority DESC);

CREATE INDEX IF NOT EXISTS idx_care_tasks_due
      ON care_tasks(done, due_at);

CREATE INDEX IF NOT EXISTS idx_care_bridge_artifacts_lookup
      ON care_bridge_artifacts(account_id, source_table, state);

CREATE INDEX IF NOT EXISTS idx_care_source_journal_row
      ON care_source_journal(source_kind, source_table, source_id, seq);

CREATE INDEX IF NOT EXISTS idx_care_source_journal_account
      ON care_source_journal(account_id, seq);

CREATE UNIQUE INDEX IF NOT EXISTS idx_care_delivery_one_sending
      ON care_delivery_intents(account_id) WHERE status = 'sending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_care_delivery_token
      ON care_delivery_intents(account_id, adapter_retry_token);

CREATE INDEX IF NOT EXISTS idx_care_delivery_due
      ON care_delivery_intents(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_care_delivery_conversation
      ON care_delivery_intents(conversation_id, queue_seq) WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_care_delivery_account_status
      ON care_delivery_intents(account_id, status, queue_seq);

CREATE INDEX IF NOT EXISTS idx_care_delivery_attempts_intent
      ON care_delivery_attempts(intent_id, attempt_no);

CREATE INDEX IF NOT EXISTS idx_care_delivery_attempts_native
      ON care_delivery_attempts(account_id, native_message_id) WHERE native_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_care_backlog_holds_account
      ON care_backlog_holds(account_id, status);

CREATE INDEX IF NOT EXISTS idx_care_legacy_inflight_account ON care_legacy_inflight(source_kind, source_account_id);

CREATE INDEX IF NOT EXISTS idx_care_cutover_log_account ON care_cutover_log(account_id, seq);

CREATE INDEX IF NOT EXISTS idx_care_agent_runs_conversation
      ON care_agent_runs(conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_care_agent_runs_agent_day
      ON care_agent_runs(agent_id, created_at) WHERE model_called = 1;

CREATE INDEX IF NOT EXISTS idx_care_agent_runs_account
      ON care_agent_runs(account_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_care_link_events_request
      ON care_link_events(request_id) WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_care_link_events_target
      ON care_link_events(target_customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_care_membership_identity
      ON care_identity_membership_history(identity_id, seq);

CREATE INDEX IF NOT EXISTS idx_care_membership_event
      ON care_identity_membership_history(link_event_id);

CREATE INDEX IF NOT EXISTS idx_care_link_moves_entity
      ON care_link_moves(entity_type, entity_id, seq);

CREATE INDEX IF NOT EXISTS idx_care_link_moves_event
      ON care_link_moves(link_event_id);

CREATE INDEX IF NOT EXISTS idx_care_link_fields_event
      ON care_link_field_changes(link_event_id);

CREATE INDEX IF NOT EXISTS idx_care_task_meta_account
      ON care_task_meta(account_id) WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_care_bridge_audit_account ON care_bridge_audit(care_account_id, seq);

CREATE INDEX IF NOT EXISTS idx_care_conversation_notes_conv
      ON care_conversation_notes(conversation_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_care_customers_recent ON care_customers(updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_care_tasks_customer ON care_tasks(customer_id, due_at, id);

CREATE INDEX IF NOT EXISTS idx_care_tasks_conversation ON care_tasks(conversation_id, due_at, id) WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_care_tasks_due_id ON care_tasks(due_at, id);

CREATE INDEX IF NOT EXISTS idx_care_conversations_status_recent ON care_conversations(status, last_message_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_care_jobs_health ON care_jobs(account_id, job_type, status, due_at, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_care_messages_sender ON care_messages(sender_identity_id, sent_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_care_conversations_customer ON care_conversations(primary_customer_id) WHERE primary_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_care_source_journal_row_ver ON care_source_journal(source_kind, source_table, source_id, source_version);

CREATE TRIGGER IF NOT EXISTS care_accounts_reenable_hold
    AFTER UPDATE OF desired_state, send_enabled ON care_accounts
    WHEN (NEW.desired_state = 'active' AND OLD.desired_state <> 'active') OR (NEW.send_enabled = 1 AND OLD.send_enabled = 0)
    BEGIN
      INSERT INTO care_backlog_holds (item_kind, item_id, account_id, status, held_at, cutoff_at, reason, held_by)
      SELECT 'job', j.id, j.account_id, 'held', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000 + 999,
             're-enabled:account', 'trigger'
      FROM care_jobs j
      WHERE j.account_id = NEW.id AND j.status = 'pending' AND j.job_type IN ('outbox_dispatch','inbound_turn')
        AND j.created_at <= CAST(strftime('%s','now') AS INTEGER) * 1000 + 999
      ON CONFLICT(item_kind, item_id) DO UPDATE SET
        status = 'held', held_at = excluded.held_at, cutoff_at = excluded.cutoff_at, reason = excluded.reason,
        held_by = excluded.held_by, resolved_at = NULL, resolved_by = NULL
      WHERE care_backlog_holds.status <> 'held';

      INSERT INTO care_backlog_holds (item_kind, item_id, account_id, status, held_at, cutoff_at, reason, held_by)
      SELECT 'outbox_intent', i.id, i.account_id, 'held', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000 + 999,
             're-enabled:account', 'trigger'
      FROM care_delivery_intents i
      WHERE i.account_id = NEW.id AND i.status IN ('pending','retry_wait')
        AND i.created_at <= CAST(strftime('%s','now') AS INTEGER) * 1000 + 999
      ON CONFLICT(item_kind, item_id) DO UPDATE SET
        status = 'held', held_at = excluded.held_at, cutoff_at = excluded.cutoff_at, reason = excluded.reason,
        held_by = excluded.held_by, resolved_at = NULL, resolved_by = NULL
      WHERE care_backlog_holds.status <> 'held';
    END;

CREATE TRIGGER IF NOT EXISTS care_cutover_log_no_update BEFORE UPDATE ON care_cutover_log
    BEGIN SELECT RAISE(ABORT, 'care_cutover_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS care_cutover_log_no_delete BEFORE DELETE ON care_cutover_log
    BEGIN SELECT RAISE(ABORT, 'care_cutover_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS care_bridge_audit_no_update BEFORE UPDATE ON care_bridge_audit
    BEGIN SELECT RAISE(ABORT, 'care_bridge_audit is append-only'); END;

CREATE TRIGGER IF NOT EXISTS care_bridge_audit_no_delete BEFORE DELETE ON care_bridge_audit
    BEGIN SELECT RAISE(ABORT, 'care_bridge_audit is append-only'); END;

INSERT OR IGNORE INTO care_schema_meta (key, value) VALUES ('schema_version', '4');
