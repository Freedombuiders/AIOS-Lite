CREATE TABLE IF NOT EXISTS radar_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  layer         TEXT NOT NULL,
  day           TEXT NOT NULL,
  session_key   TEXT,
  label         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  phase         TEXT,
  error         TEXT,
  item_count    INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  log           TEXT NOT NULL DEFAULT '[]',
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_radar_runs_layer_day ON radar_runs(layer, day);

CREATE TABLE IF NOT EXISTS radar_items (
  day         TEXT NOT NULL,
  layer       TEXT NOT NULL,
  session_key TEXT NOT NULL,
  id          TEXT NOT NULL,
  json        TEXT NOT NULL,
  PRIMARY KEY (day, layer, session_key, id)
);

CREATE TABLE IF NOT EXISTS radar_seen (
  id            TEXT NOT NULL,
  layer         TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  first_day     TEXT NOT NULL,
  last_day      TEXT NOT NULL,
  times         INTEGER NOT NULL DEFAULT 1,
  last_comments INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, layer)
);

CREATE TABLE IF NOT EXISTS radar_pains (
  id               TEXT PRIMARY KEY,
  layer            TEXT NOT NULL,
  title            TEXT NOT NULL,
  detail           TEXT NOT NULL DEFAULT '',
  professions_json TEXT NOT NULL DEFAULT '[]',
  topics_json      TEXT NOT NULL DEFAULT '[]',
  first_day        TEXT NOT NULL,
  last_day         TEXT NOT NULL,
  times            INTEGER NOT NULL DEFAULT 1,
  report_days_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS radar_reports (
  day          TEXT NOT NULL,
  layer        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (day, layer)
);

-- module key/value store: radar config, per-layer run markers, Apify rotation cursor
CREATE TABLE IF NOT EXISTS radar_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
