CREATE TABLE IF NOT EXISTS fb_ad_accounts (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL DEFAULT '',
      currency       TEXT NOT NULL DEFAULT 'VND',
      timezone       TEXT NOT NULL DEFAULT '',
      connection_id  TEXT NOT NULL DEFAULT '',
      entity_id      TEXT NOT NULL DEFAULT '',
      enabled        INTEGER NOT NULL DEFAULT 0,
      result_type    TEXT NOT NULL DEFAULT 'lead',
      target_cpa     REAL,
      monthly_budget REAL,
      status         TEXT NOT NULL DEFAULT 'ACTIVE',
      synced_at      INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

CREATE TABLE IF NOT EXISTS fb_ads_daily (
 freq_window REAL,
      account_id    TEXT NOT NULL,
      level         TEXT NOT NULL,
      object_id     TEXT NOT NULL,
      parent_id     TEXT NOT NULL DEFAULT '',
      day           TEXT NOT NULL,
      name          TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT '',
      daily_budget  REAL,
      spend         REAL NOT NULL DEFAULT 0,
      impressions   INTEGER NOT NULL DEFAULT 0,
      reach         INTEGER,
      frequency     REAL,
      clicks        INTEGER NOT NULL DEFAULT 0,
      link_clicks   INTEGER NOT NULL DEFAULT 0,
      lp_views      INTEGER NOT NULL DEFAULT 0,
      results       INTEGER NOT NULL DEFAULT 0,
      result_value  REAL NOT NULL DEFAULT 0,
      purchases     INTEGER NOT NULL DEFAULT 0,
      video_3s      INTEGER NOT NULL DEFAULT 0,
      thruplays     INTEGER NOT NULL DEFAULT 0,
      creative_json TEXT NOT NULL DEFAULT '{}',
      learning      TEXT NOT NULL DEFAULT '',
      raw_json      TEXT NOT NULL DEFAULT '{}',
      captured_at   INTEGER NOT NULL,
      PRIMARY KEY (account_id, level, object_id, day)
    );

CREATE INDEX IF NOT EXISTS idx_fb_ads_daily_day ON fb_ads_daily(account_id, day, level);

CREATE TABLE IF NOT EXISTS fb_ads_placement_daily (
      account_id  TEXT NOT NULL,
      day         TEXT NOT NULL,
      placement   TEXT NOT NULL,
      spend       REAL NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      results     INTEGER NOT NULL DEFAULT 0,
      captured_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, day, placement)
    );

CREATE TABLE IF NOT EXISTS fb_ads_recommendations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id    TEXT NOT NULL,
      level         TEXT NOT NULL,
      object_id     TEXT NOT NULL,
      object_name   TEXT NOT NULL DEFAULT '',
      action        TEXT NOT NULL,
      rule          TEXT NOT NULL,
      reason        TEXT NOT NULL,
      metrics_json  TEXT NOT NULL DEFAULT '{}',
      state         TEXT NOT NULL DEFAULT 'open',
      snoozed_until INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_fb_ads_recs ON fb_ads_recommendations(account_id, state, created_at);
