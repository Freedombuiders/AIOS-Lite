-- zalo module schema (derived from the owner's db.ts zalo sections; migration column additions folded into CREATE TABLE).
    CREATE TABLE IF NOT EXISTS zalo_accounts (
      id                TEXT PRIMARY KEY,
      label             TEXT NOT NULL DEFAULT '',
      zalo_uid          TEXT,
      display_name      TEXT NOT NULL DEFAULT '',
      avatar_url        TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'disconnected',
      session_enc       TEXT,
      chat_enabled      INTEGER NOT NULL DEFAULT 1,
      daily_message_cap INTEGER NOT NULL DEFAULT 1000,
      manual_disconnect INTEGER NOT NULL DEFAULT 0,
      last_error        TEXT NOT NULL DEFAULT '',
      last_connected_at INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      limits_json TEXT NOT NULL DEFAULT '{}',
      send_lock_reason TEXT NOT NULL DEFAULT '',
      warmup_enabled INTEGER NOT NULL DEFAULT 0,
      warmup_started_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_zalo_accounts_uid ON zalo_accounts(zalo_uid) WHERE zalo_uid IS NOT NULL;

    CREATE TABLE IF NOT EXISTS zalo_threads (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id       TEXT NOT NULL,
      thread_type      TEXT NOT NULL,
      external_id      TEXT NOT NULL,
      name             TEXT NOT NULL DEFAULT '',
      avatar_url       TEXT NOT NULL DEFAULT '',
      members_count    INTEGER,
      global_id        TEXT NOT NULL DEFAULT '',
      last_message_at  INTEGER NOT NULL DEFAULT 0,
      last_preview     TEXT NOT NULL DEFAULT '',
      last_sender_type TEXT NOT NULL DEFAULT '',
      unread_count     INTEGER NOT NULL DEFAULT 0,
      paused_until     INTEGER,
      pause_reason     TEXT NOT NULL DEFAULT '',
      created_at       INTEGER NOT NULL,
      opted_out        INTEGER NOT NULL DEFAULT 0,
      opted_out_at     INTEGER,
      birth_date       TEXT,
      birth_date_checked_at INTEGER,
      UNIQUE(account_id, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_zalo_threads_recent ON zalo_threads(account_id, last_message_at DESC);

    -- sent_at is milliseconds (Zalo's own clock); msg_id_num is the numeric
    -- Zalo message id, the reliable sort key when ts is missing on echoes.

    CREATE TABLE IF NOT EXISTS zalo_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id     INTEGER NOT NULL,
      zalo_msg_id   TEXT,
      msg_id_num    INTEGER,
      cli_msg_id    TEXT,
      sender_type   TEXT NOT NULL,
      sender_uid    TEXT NOT NULL DEFAULT '',
      sender_name   TEXT NOT NULL DEFAULT '',
      body          TEXT NOT NULL,
      content_type  TEXT NOT NULL DEFAULT 'text',
      quote_json    TEXT,
      mentions_json TEXT,
      origin        TEXT NOT NULL DEFAULT 'live',
      is_deleted    INTEGER NOT NULL DEFAULT 0,
      sent_at       INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      UNIQUE(thread_id, zalo_msg_id)
    );

    CREATE INDEX IF NOT EXISTS idx_zalo_messages_thread ON zalo_messages(thread_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_zalo_messages_msgnum ON zalo_messages(msg_id_num);


    CREATE TABLE IF NOT EXISTS zalo_outbox (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id     INTEGER NOT NULL,
      body          TEXT NOT NULL,
      mentions_json TEXT,
      origin        TEXT NOT NULL,
      agent_id      TEXT NOT NULL DEFAULT '',
      run_id        INTEGER,
      status        TEXT NOT NULL DEFAULT 'pending',
      message_id    INTEGER,
      error         TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,
      sent_at       INTEGER,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      styles_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_zalo_outbox_status ON zalo_outbox(status, created_at);

    -- @zalo-schema:protection
    -- Key/value settings for the Zalo module (anti-ban protection lives under 'protection').
    CREATE TABLE IF NOT EXISTS zalo_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Per-nick daily SDK usage by category; day is the local date in the
    -- configured timezone, so quotas reset at local midnight.
    CREATE TABLE IF NOT EXISTS zalo_usage (
      account_id TEXT NOT NULL,
      day        TEXT NOT NULL,
      category   TEXT NOT NULL,
      count      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, day, category)
    );

    -- @zalo-schema:templates
    -- Uploaded template attachments (files live under ZALO_MEDIA_DIR/rel_path).
    CREATE TABLE IF NOT EXISTS zalo_media (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name   TEXT NOT NULL,
      mime        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      size        INTEGER NOT NULL,
      rel_path    TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    -- Marketing message templates: body is plain text, styles_json the Zalo
    -- ranges over it, attachments_json a JSON array of zalo_media ids.
    CREATE TABLE IF NOT EXISTS zalo_templates (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      body             TEXT NOT NULL DEFAULT '',
      styles_json      TEXT NOT NULL DEFAULT '[]',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    -- @zalo-schema:group-broadcast
    -- Scheduled group broadcasts: one campaign → many runs → one target per group.
    -- Dates are 'YYYY-MM-DD' wall dates in the campaign timezone; *_at are seconds.
    CREATE TABLE IF NOT EXISTS zalo_broadcasts (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      name                    TEXT NOT NULL,
      account_id              TEXT NOT NULL,
      template_id             INTEGER NOT NULL,
      target_thread_ids       TEXT NOT NULL DEFAULT '[]',
      schedule_kind           TEXT NOT NULL DEFAULT 'now',
      times_of_day            TEXT NOT NULL DEFAULT '[]',
      days_of_week            TEXT NOT NULL DEFAULT '[]',
      days_of_month           TEXT NOT NULL DEFAULT '[]',
      timezone                TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      start_date              TEXT,
      end_date                TEXT,
      min_delay_sec           INTEGER NOT NULL DEFAULT 20,
      max_delay_sec           INTEGER NOT NULL DEFAULT 45,
      state                   TEXT NOT NULL DEFAULT 'draft',
      paused_reason           TEXT NOT NULL DEFAULT '',
      consecutive_failed_runs INTEGER NOT NULL DEFAULT 0,
      next_run_at             INTEGER,
      activated_at            INTEGER,
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_zalo_broadcasts_state ON zalo_broadcasts(state);

    CREATE TABLE IF NOT EXISTS zalo_broadcast_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcast_id   INTEGER NOT NULL,
      scheduled_for  INTEGER NOT NULL,
      triggered_by   TEXT NOT NULL,
      state          TEXT NOT NULL DEFAULT 'pending',
      skip_reason    TEXT NOT NULL DEFAULT '',
      total_targets  INTEGER NOT NULL DEFAULT 0,
      sent_count     INTEGER NOT NULL DEFAULT 0,
      failed_count   INTEGER NOT NULL DEFAULT 0,
      skipped_count  INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      started_at     INTEGER,
      finished_at    INTEGER,
      UNIQUE(broadcast_id, scheduled_for, triggered_by)
    );

    CREATE INDEX IF NOT EXISTS idx_zalo_broadcast_runs_state ON zalo_broadcast_runs(state, scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_zalo_broadcast_runs_bc ON zalo_broadcast_runs(broadcast_id, scheduled_for DESC);

    CREATE TABLE IF NOT EXISTS zalo_broadcast_targets (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id         INTEGER NOT NULL,
      thread_id      INTEGER NOT NULL,
      state          TEXT NOT NULL DEFAULT 'pending',
      attempts       INTEGER NOT NULL DEFAULT 0,
      sent_steps     TEXT NOT NULL DEFAULT '[]',
      error_code     TEXT NOT NULL DEFAULT '',
      error_message  TEXT NOT NULL DEFAULT '',
      message_ids    TEXT NOT NULL DEFAULT '[]',
      sent_at        INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_zalo_broadcast_targets_run ON zalo_broadcast_targets(run_id, id);

    -- @zalo-schema:list-broadcast
    -- 1-1 broadcast to existing chats of a nick. Recipients are materialised
    -- (not queried live) so "who actually got it" survives across days.
    CREATE TABLE IF NOT EXISTS zalo_list_broadcasts (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      name                       TEXT NOT NULL,
      template_id                INTEGER NOT NULL,
      account_ids                TEXT NOT NULL DEFAULT '[]',
      filter_json                TEXT NOT NULL DEFAULT '{}',
      window_start               TEXT NOT NULL DEFAULT '08:00',
      window_end                 TEXT NOT NULL DEFAULT '17:00',
      days_of_week               TEXT NOT NULL DEFAULT '[]',
      timezone                   TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      start_date                 TEXT,
      end_date                   TEXT,
      daily_quota                INTEGER NOT NULL DEFAULT 100,
      per_nick_daily_quota       INTEGER NOT NULL DEFAULT 40,
      min_delay_sec              INTEGER NOT NULL DEFAULT 45,
      max_delay_sec              INTEGER NOT NULL DEFAULT 90,
      state                      TEXT NOT NULL DEFAULT 'draft',
      paused_reason              TEXT NOT NULL DEFAULT '',
      consecutive_failed_batches INTEGER NOT NULL DEFAULT 0,
      last_empty_batch_at        INTEGER,
      recipients_synced_at       INTEGER,
      created_at                 INTEGER NOT NULL,
      updated_at                 INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_zalo_list_broadcasts_state ON zalo_list_broadcasts(state);

    CREATE TABLE IF NOT EXISTS zalo_list_recipients (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcast_id  INTEGER NOT NULL,
      thread_id     INTEGER NOT NULL,
      account_id    TEXT NOT NULL,
      name_snapshot TEXT NOT NULL DEFAULT '',
      state         TEXT NOT NULL DEFAULT 'pending',
      sent_steps    INTEGER NOT NULL DEFAULT 0,
      attempts      INTEGER NOT NULL DEFAULT 0,
      error_code    TEXT NOT NULL DEFAULT '',
      sent_at       INTEGER,
      created_at    INTEGER NOT NULL,
      UNIQUE(broadcast_id, thread_id)
    );

    CREATE INDEX IF NOT EXISTS idx_zalo_list_recipients_state ON zalo_list_recipients(broadcast_id, state, id);
    CREATE INDEX IF NOT EXISTS idx_zalo_list_recipients_nick_day ON zalo_list_recipients(account_id, sent_at);

    CREATE TABLE IF NOT EXISTS zalo_list_batches (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcast_id INTEGER NOT NULL,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER,
      sent         INTEGER NOT NULL DEFAULT 0,
      failed       INTEGER NOT NULL DEFAULT 0,
      skipped      INTEGER NOT NULL DEFAULT 0,
      stop_reason  TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_zalo_list_batches_broadcast ON zalo_list_batches(broadcast_id, id DESC);

    -- @zalo-schema:birthday
    -- Single-row config (id is pinned to 1). Occasion template ids are plain
    -- integers into zalo_templates; a deleted template just skips the greeting.
    CREATE TABLE IF NOT EXISTS zalo_birthday_config (
      id                     INTEGER PRIMARY KEY CHECK (id = 1),
      enabled                INTEGER NOT NULL DEFAULT 0,
      send_time              TEXT NOT NULL DEFAULT '09:00',
      timezone               TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      late_tolerance_minutes INTEGER NOT NULL DEFAULT 180,
      before_enabled         INTEGER NOT NULL DEFAULT 0,
      before_days            INTEGER NOT NULL DEFAULT 3,
      before_template_id     INTEGER,
      on_day_enabled         INTEGER NOT NULL DEFAULT 1,
      on_day_template_id     INTEGER,
      after_enabled          INTEGER NOT NULL DEFAULT 0,
      after_days             INTEGER NOT NULL DEFAULT 1,
      after_template_id      INTEGER,
      per_nick_daily_quota   INTEGER NOT NULL DEFAULT 30,
      min_delay_sec          INTEGER NOT NULL DEFAULT 30,
      max_delay_sec          INTEGER NOT NULL DEFAULT 90,
      account_ids            TEXT NOT NULL DEFAULT '[]',
      updated_at             INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS zalo_birthday_greetings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id    INTEGER NOT NULL,
      account_id   TEXT NOT NULL,
      occasion     TEXT NOT NULL,
      birthday_on  TEXT NOT NULL,
      due_at       INTEGER NOT NULL,
      state        TEXT NOT NULL DEFAULT 'pending',
      skip_reason  TEXT NOT NULL DEFAULT '',
      error_code   TEXT NOT NULL DEFAULT '',
      sent_steps   INTEGER NOT NULL DEFAULT 0,
      message_ids  TEXT NOT NULL DEFAULT '[]',
      sent_at      INTEGER,
      -- 1 once the operator pressed "send now": the planner must not re-time it.
      forced       INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      UNIQUE(thread_id, occasion, birthday_on)
    );

    CREATE INDEX IF NOT EXISTS idx_zalo_birthday_due ON zalo_birthday_greetings(state, due_at);
    CREATE INDEX IF NOT EXISTS idx_zalo_birthday_day ON zalo_birthday_greetings(birthday_on);

    -- @zalo-schema:care-inbox
    -- Shared inbox v2: local copy of the images/files customers sent (Zalo CDN links expire). One row per
    -- (zalo_messages.id, media index); files live under STORE_DIR/zalo-media-cache/rel_path. A failed
    -- download keeps its row (error set, fetched_at = last attempt, seconds) so it is not retried every view.
    CREATE TABLE IF NOT EXISTS zalo_media_cache (
      message_id INTEGER NOT NULL,
      idx        INTEGER NOT NULL DEFAULT 0,
      rel_path   TEXT NOT NULL DEFAULT '',
      mime       TEXT NOT NULL DEFAULT '',
      file_name  TEXT NOT NULL DEFAULT '',
      size       INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL,
      error      TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (message_id, idx)
    );

