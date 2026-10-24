CREATE TABLE IF NOT EXISTS kol_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE IF NOT EXISTS kol_personas (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      handle                TEXT NOT NULL DEFAULT '',
      status                TEXT NOT NULL DEFAULT 'draft',
      tagline               TEXT NOT NULL DEFAULT '',
      niche                 TEXT NOT NULL DEFAULT '',
      languages_json        TEXT NOT NULL DEFAULT '["vi"]',
      bio                   TEXT NOT NULL DEFAULT '',
      appearance_json       TEXT NOT NULL DEFAULT '{}',
      personality_json      TEXT NOT NULL DEFAULT '{}',
      audience              TEXT NOT NULL DEFAULT '',
      pillars_json          TEXT NOT NULL DEFAULT '[]',
      identity_source       TEXT NOT NULL DEFAULT 'synthetic',
      consent_note          TEXT NOT NULL DEFAULT '',
      disclosure_text       TEXT NOT NULL DEFAULT '',
      voice_id              TEXT NOT NULL DEFAULT '',
      brain_agent           TEXT NOT NULL DEFAULT 'main',
      image_model           TEXT NOT NULL DEFAULT '',
      video_model           TEXT NOT NULL DEFAULT '',
      realism_preset        TEXT NOT NULL DEFAULT 'pro-photo',
      consistency_threshold INTEGER NOT NULL DEFAULT 80,
      auto_reject_drift     INTEGER NOT NULL DEFAULT 0,
      monthly_cap_usd       REAL,
      autopilot_json        TEXT NOT NULL DEFAULT '{}',
      cover_asset_id        TEXT,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS kol_refs (
      id         TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'anchor',
      label      TEXT NOT NULL DEFAULT '',
      file       TEXT NOT NULL,
      mime       TEXT NOT NULL DEFAULT 'image/jpeg',
      width      INTEGER,
      height     INTEGER,
      sort       INTEGER NOT NULL DEFAULT 0,
      is_primary INTEGER NOT NULL DEFAULT 0,
      source     TEXT NOT NULL DEFAULT 'upload',
      asset_id   TEXT,
      created_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS kol_library (
      id         TEXT PRIMARY KEY,
      persona_id TEXT,
      kind       TEXT NOT NULL,
      grp        TEXT NOT NULL DEFAULT '',
      name       TEXT NOT NULL,
      prompt     TEXT NOT NULL DEFAULT '',
      file       TEXT,
      tags_json  TEXT NOT NULL DEFAULT '[]',
      builtin    INTEGER NOT NULL DEFAULT 0,
      sort       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    , preview_file TEXT, gender TEXT NOT NULL DEFAULT 'all');

CREATE TABLE IF NOT EXISTS kol_templates (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT '',
      kind       TEXT NOT NULL DEFAULT 'single',
      set_id     TEXT,
      position   INTEGER NOT NULL DEFAULT 0,
      file       TEXT NOT NULL,
      mime       TEXT NOT NULL DEFAULT 'image/jpeg',
      width      INTEGER,
      height     INTEGER,
      notes      TEXT NOT NULL DEFAULT '',
      source     TEXT NOT NULL DEFAULT 'upload',
      source_url TEXT NOT NULL DEFAULT '',
      tags_json  TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS kol_generations (
      id                  TEXT PRIMARY KEY,
      persona_id          TEXT NOT NULL,
      kind                TEXT NOT NULL,
      mode                TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'queued',
      provider            TEXT NOT NULL,
      model               TEXT NOT NULL,
      params_json         TEXT NOT NULL DEFAULT '{}',
      selection_json      TEXT NOT NULL DEFAULT '{}',
      prompt              TEXT NOT NULL DEFAULT '',
      refs_json           TEXT NOT NULL DEFAULT '[]',
      estimate_usd        REAL NOT NULL DEFAULT 0,
      cost_usd            REAL NOT NULL DEFAULT 0,
      cost_status         TEXT NOT NULL DEFAULT 'estimated',
      provider_request_id TEXT,
      error               TEXT NOT NULL DEFAULT '',
      attempts            INTEGER NOT NULL DEFAULT 0,
      requested_by        TEXT NOT NULL DEFAULT 'owner',
      post_id             TEXT,
      created_at          INTEGER NOT NULL,
      started_at          INTEGER,
      finished_at         INTEGER
    );

CREATE TABLE IF NOT EXISTS kol_assets (
      id                  TEXT PRIMARY KEY,
      persona_id          TEXT NOT NULL,
      generation_id       TEXT,
      kind                TEXT NOT NULL,
      file                TEXT NOT NULL,
      thumb               TEXT,
      mime                TEXT NOT NULL,
      width               INTEGER,
      height              INTEGER,
      duration_sec        REAL,
      bytes               INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'new',
      favorite            INTEGER NOT NULL DEFAULT 0,
      consistency_score   INTEGER,
      consistency_verdict TEXT,
      consistency_notes   TEXT NOT NULL DEFAULT '',
      model               TEXT NOT NULL DEFAULT '',
      provider            TEXT NOT NULL DEFAULT '',
      cost_usd            REAL NOT NULL DEFAULT 0,
      prompt              TEXT NOT NULL DEFAULT '',
      tags_json           TEXT NOT NULL DEFAULT '[]',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS kol_spend (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id    TEXT NOT NULL,
      generation_id TEXT,
      provider      TEXT NOT NULL,
      model         TEXT NOT NULL,
      kind          TEXT NOT NULL,
      cost_usd      REAL NOT NULL DEFAULT 0,
      cost_status   TEXT NOT NULL DEFAULT 'estimated',
      requested_by  TEXT NOT NULL DEFAULT 'owner',
      created_at    INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS kol_accounts (
      id                TEXT PRIMARY KEY,
      persona_id        TEXT NOT NULL,
      platform          TEXT NOT NULL,
      connection_id     TEXT NOT NULL,
      entity_id         TEXT NOT NULL DEFAULT '',
      external_id       TEXT NOT NULL DEFAULT '',
      handle            TEXT NOT NULL DEFAULT '',
      display_name      TEXT NOT NULL DEFAULT '',
      picture_url       TEXT NOT NULL DEFAULT '',
      enabled           INTEGER NOT NULL DEFAULT 1,
      auto_publish      INTEGER NOT NULL DEFAULT 0,
      max_posts_per_day INTEGER NOT NULL DEFAULT 2,
      min_gap_minutes   INTEGER NOT NULL DEFAULT 180,
      window_start      TEXT NOT NULL DEFAULT '08:00',
      window_end        TEXT NOT NULL DEFAULT '22:00',
      timezone          TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
      tiktok_privacy    TEXT NOT NULL DEFAULT 'SELF_ONLY',
      youtube_privacy   TEXT NOT NULL DEFAULT 'public',
      youtube_category  TEXT NOT NULL DEFAULT '22',
      status            TEXT NOT NULL DEFAULT 'ACTIVE',
      followers         INTEGER,
      followers_at      INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS kol_posts (
      id             TEXT PRIMARY KEY,
      persona_id     TEXT NOT NULL,
      title          TEXT NOT NULL DEFAULT '',
      pillar         TEXT NOT NULL DEFAULT '',
      format         TEXT NOT NULL DEFAULT 'photo',
      caption        TEXT NOT NULL DEFAULT '',
      hashtags_json  TEXT NOT NULL DEFAULT '[]',
      variants_json  TEXT NOT NULL DEFAULT '{}',
      asset_ids_json TEXT NOT NULL DEFAULT '[]',
      status         TEXT NOT NULL DEFAULT 'draft',
      scheduled_at   INTEGER,
      published_at   INTEGER,
      brief          TEXT NOT NULL DEFAULT '',
      source         TEXT NOT NULL DEFAULT 'owner',
      source_ref     TEXT NOT NULL DEFAULT '',
      feedback       TEXT NOT NULL DEFAULT '',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS kol_post_targets (
      id              TEXT PRIMARY KEY,
      post_id         TEXT NOT NULL,
      account_id      TEXT NOT NULL,
      platform        TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      external_id     TEXT,
      permalink       TEXT NOT NULL DEFAULT '',
      fb_content_id   INTEGER,
      publish_ref     TEXT,
      error           TEXT NOT NULL DEFAULT '',
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      published_at    INTEGER,
      updated_at      INTEGER NOT NULL,
      UNIQUE (post_id, account_id)
    );

CREATE TABLE IF NOT EXISTS kol_metrics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id   TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      views       INTEGER,
      likes       INTEGER,
      comments    INTEGER,
      shares      INTEGER,
      saves       INTEGER,
      reach       INTEGER,
      raw_json    TEXT NOT NULL DEFAULT '{}'
    );

CREATE TABLE IF NOT EXISTS kol_account_daily (
      account_id TEXT NOT NULL,
      day        TEXT NOT NULL,
      followers  INTEGER NOT NULL,
      PRIMARY KEY (account_id, day)
    );

CREATE TABLE IF NOT EXISTS kol_insights (
      id           TEXT PRIMARY KEY,
      persona_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      summary      TEXT NOT NULL DEFAULT '',
      ideas_json   TEXT NOT NULL DEFAULT '[]',
      post_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at   INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS kol_library_previews (
      item_id    TEXT NOT NULL,
      variant    TEXT NOT NULL,
      file       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, variant)
    );

CREATE TABLE IF NOT EXISTS kol_persona_previews (
      persona_id TEXT NOT NULL,
      item_id    TEXT NOT NULL,
      file       TEXT NOT NULL,
      score      INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (persona_id, item_id)
    );

CREATE TABLE IF NOT EXISTS kol_persona_preview_misses (
      persona_id TEXT NOT NULL,
      item_id    TEXT NOT NULL,
      attempts   INTEGER NOT NULL,
      error      TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (persona_id, item_id)
    );

CREATE INDEX IF NOT EXISTS idx_kol_refs_persona ON kol_refs(persona_id, sort);

CREATE INDEX IF NOT EXISTS idx_kol_library_kind ON kol_library(kind, persona_id, sort);

CREATE INDEX IF NOT EXISTS idx_kol_generations_persona ON kol_generations(persona_id, created_at);

CREATE INDEX IF NOT EXISTS idx_kol_generations_status ON kol_generations(status, created_at);

CREATE INDEX IF NOT EXISTS idx_kol_assets_persona ON kol_assets(persona_id, created_at);

CREATE INDEX IF NOT EXISTS idx_kol_assets_generation ON kol_assets(generation_id);

CREATE INDEX IF NOT EXISTS idx_kol_spend_created ON kol_spend(created_at);

CREATE INDEX IF NOT EXISTS idx_kol_spend_persona ON kol_spend(persona_id, created_at);

CREATE INDEX IF NOT EXISTS idx_kol_accounts_persona ON kol_accounts(persona_id);

CREATE INDEX IF NOT EXISTS idx_kol_posts_persona ON kol_posts(persona_id, status);

CREATE INDEX IF NOT EXISTS idx_kol_posts_due ON kol_posts(status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_kol_targets_status ON kol_post_targets(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_kol_metrics_target ON kol_metrics(target_id, captured_at);

CREATE INDEX IF NOT EXISTS idx_kol_insights_persona ON kol_insights(persona_id, created_at);

CREATE INDEX IF NOT EXISTS idx_kol_persona_previews_item ON kol_persona_previews(item_id);
