    -- @email-schema
    CREATE TABLE IF NOT EXISTS email_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- One row per Composio gmail connected account.
    CREATE TABLE IF NOT EXISTS email_accounts (
      id             TEXT PRIMARY KEY,
      connection_id  TEXT NOT NULL UNIQUE,
      entity_id      TEXT NOT NULL,
      email_address  TEXT NOT NULL DEFAULT '',
      display_name   TEXT NOT NULL DEFAULT '',
      status         TEXT NOT NULL DEFAULT 'ACTIVE',
      sync_enabled   INTEGER NOT NULL DEFAULT 0,
      poll_minutes   INTEGER NOT NULL DEFAULT 2,
      backfill_days  INTEGER NOT NULL DEFAULT 7,
      signature      TEXT NOT NULL DEFAULT '',
      daily_send_cap INTEGER NOT NULL DEFAULT 150,
      sync_cursor    INTEGER,
      care_since     INTEGER,
      last_poll_at   INTEGER,
      last_error     TEXT NOT NULL DEFAULT '',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_threads (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id               TEXT NOT NULL,
      gmail_thread_id          TEXT NOT NULL,
      subject                  TEXT NOT NULL DEFAULT '',
      customer_email           TEXT NOT NULL DEFAULT '',
      customer_name            TEXT NOT NULL DEFAULT '',
      reply_to                 TEXT NOT NULL DEFAULT '',
      last_message_at          INTEGER NOT NULL DEFAULT 0,
      last_preview             TEXT NOT NULL DEFAULT '',
      last_direction           TEXT NOT NULL DEFAULT '',
      message_count            INTEGER NOT NULL DEFAULT 0,
      unread_count             INTEGER NOT NULL DEFAULT 0,
      category                 TEXT NOT NULL DEFAULT '',
      automated_reason         TEXT NOT NULL DEFAULT '',
      paused_until             INTEGER,
      opted_out                INTEGER NOT NULL DEFAULT 0,
      agent_handled_message_id INTEGER,
      created_at               INTEGER NOT NULL,
      UNIQUE(account_id, gmail_thread_id)
    );

    CREATE INDEX IF NOT EXISTS idx_email_threads_recent ON email_threads(account_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_threads_customer ON email_threads(customer_email);

    CREATE TABLE IF NOT EXISTS email_messages (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id        INTEGER NOT NULL,
      account_id       TEXT NOT NULL,
      gmail_message_id TEXT NOT NULL,
      direction        TEXT NOT NULL,
      sender_type      TEXT NOT NULL,
      from_email       TEXT NOT NULL DEFAULT '',
      from_name        TEXT NOT NULL DEFAULT '',
      to_json          TEXT NOT NULL DEFAULT '[]',
      cc_json          TEXT NOT NULL DEFAULT '[]',
      subject          TEXT NOT NULL DEFAULT '',
      body_text        TEXT NOT NULL DEFAULT '',
      body_html        TEXT NOT NULL DEFAULT '',
      snippet          TEXT NOT NULL DEFAULT '',
      headers_json     TEXT NOT NULL DEFAULT '{}',
      labels_json      TEXT NOT NULL DEFAULT '[]',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      origin           TEXT NOT NULL DEFAULT 'live',
      sent_at          INTEGER NOT NULL,
      created_at       INTEGER NOT NULL,
      UNIQUE(account_id, gmail_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id, sent_at);

    -- scope 'account' = every mail of the mailbox (match_value ''),
    -- 'domain' = sender domain (match_value 'acme.com'),
    -- 'sender' = one address (match_value 'a@acme.com'). sender > domain > account.
    CREATE TABLE IF NOT EXISTS email_assignments (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id                 TEXT NOT NULL,
      scope                      TEXT NOT NULL,
      match_value                TEXT NOT NULL DEFAULT '',
      agent_id                   TEXT NOT NULL,
      mode                       TEXT NOT NULL DEFAULT 'draft',
      instructions               TEXT NOT NULL DEFAULT '',
      review_keywords            TEXT NOT NULL DEFAULT '[]',
      primary_only               INTEGER NOT NULL DEFAULT 1,
      max_replies_per_thread_day INTEGER NOT NULL DEFAULT 3,
      human_pause_minutes        INTEGER NOT NULL DEFAULT 240,
      auto_delay_seconds         INTEGER NOT NULL DEFAULT 120,
      enabled                    INTEGER NOT NULL DEFAULT 1,
      created_at                 INTEGER NOT NULL,
      updated_at                 INTEGER NOT NULL,
      UNIQUE(account_id, scope, match_value)
    );

    CREATE TABLE IF NOT EXISTS email_agent_runs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id          INTEGER NOT NULL,
      assignment_id      INTEGER,
      agent_id           TEXT NOT NULL DEFAULT '',
      trigger_message_id INTEGER,
      status             TEXT NOT NULL,
      skip_reason        TEXT NOT NULL DEFAULT '',
      reply_text         TEXT NOT NULL DEFAULT '',
      note               TEXT NOT NULL DEFAULT '',
      latency_ms         INTEGER NOT NULL DEFAULT 0,
      cost_usd           REAL NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_email_runs_thread ON email_agent_runs(thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_runs_created ON email_agent_runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS email_outbox (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id        INTEGER NOT NULL,
      account_id       TEXT NOT NULL,
      body             TEXT NOT NULL,
      to_email         TEXT NOT NULL,
      cc_json          TEXT NOT NULL DEFAULT '[]',
      origin           TEXT NOT NULL,
      agent_id         TEXT NOT NULL DEFAULT '',
      run_id           INTEGER,
      status           TEXT NOT NULL DEFAULT 'pending',
      send_after       INTEGER,
      review_reason    TEXT NOT NULL DEFAULT '',
      approved_at      INTEGER,
      gmail_message_id TEXT NOT NULL DEFAULT '',
      message_id       INTEGER,
      error            TEXT NOT NULL DEFAULT '',
      created_at       INTEGER NOT NULL,
      sent_at          INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox(status, send_after);
    CREATE INDEX IF NOT EXISTS idx_email_outbox_thread ON email_outbox(thread_id, created_at DESC);

    -- Every Composio call made for email, for the hourly budget.
    CREATE TABLE IF NOT EXISTS email_api_calls (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      area       TEXT NOT NULL,
      ok         INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_email_api_calls_created ON email_api_calls(created_at);

    -- Gmail poll coverage: one open query window per mailbox (src/email/sync.ts).
    -- email_accounts.sync_cursor only advances to window_end once the provider
    -- confirmed there is no next page AND every message of the window was stored.
    CREATE TABLE IF NOT EXISTS email_sync_windows (
      account_id     TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      query          TEXT NOT NULL,
      page_size      INTEGER NOT NULL,
      window_end     INTEGER NOT NULL,
      page_token     TEXT,
      pages_done     INTEGER NOT NULL DEFAULT 0,
      restarts       INTEGER NOT NULL DEFAULT 0,
      started_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );


    -- One row per connected external service. values_enc is
    -- encryptField(JSON of the owner's credentials); status is ok|error|unchecked.

    CREATE TABLE IF NOT EXISTS email_connector_mailboxes (
      account_id      TEXT PRIMARY KEY,
      covered_sec     INTEGER,
      step            INTEGER NOT NULL DEFAULT 0,
      win_kind        TEXT,
      win_query       TEXT,
      win_page_size   INTEGER,
      win_end_sec     INTEGER,
      win_lower_sec   INTEGER,
      win_token       TEXT,
      win_pages_done  INTEGER NOT NULL DEFAULT 0,
      win_restarts    INTEGER NOT NULL DEFAULT 0,
      win_started_sec INTEGER,
      status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','expired')),
      status_rev      INTEGER NOT NULL DEFAULT 0,
      healthy_pending INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_connector_attempts (
      account_id          TEXT NOT NULL,
      token               TEXT NOT NULL,
      client_request_id   TEXT NOT NULL,
      thread_key          TEXT NOT NULL,
      payload_hash        TEXT NOT NULL,
      text_hash           TEXT NOT NULL,
      actor               TEXT NOT NULL,
      state               TEXT NOT NULL CHECK (state IN ('prepared','refused','rejected','accepted','uncertain')),
      gmail_message_id    TEXT,
      gmail_thread_id     TEXT,
      candidate_message_id TEXT,
      accepted_at_ms      INTEGER,
      first_rpc_at_ms     INTEGER,
      rpc_count           INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      PRIMARY KEY (account_id, token)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_connector_attempts_request
      ON email_connector_attempts (account_id, client_request_id);
    CREATE INDEX IF NOT EXISTS idx_email_connector_attempts_gmail
      ON email_connector_attempts (account_id, gmail_message_id);
    CREATE INDEX IF NOT EXISTS idx_email_connector_attempts_thread
      ON email_connector_attempts (account_id, thread_key, state);

    CREATE TABLE IF NOT EXISTS email_connector_cooldowns (
      account_id  TEXT NOT NULL,
      scope       TEXT NOT NULL,
      until_ms    INTEGER NOT NULL,
      reason      TEXT,
      PRIMARY KEY (account_id, scope)
    );
  
