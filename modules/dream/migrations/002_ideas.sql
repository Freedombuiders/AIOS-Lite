-- D2 · formulas, daily suggestions, comparison.

-- which formula (cong-thuc/<slug>.md) a video was matched to; NULL = not part of any formula yet
ALTER TABLE dream_videos ADD COLUMN formula_slug TEXT;
CREATE INDEX IF NOT EXISTS dream_videos_labels ON dream_videos(folder_id, mo_dau, cau_truc, formula_slug);

-- "rút thành công thức": 3+ unassigned videos with the same labels in 30 days. The owner creates the formula or drops it.
CREATE TABLE IF NOT EXISTS dream_formula_proposals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id    TEXT NOT NULL,
  mo_dau       TEXT NOT NULL,
  cau_truc     TEXT NOT NULL,
  video_ids    TEXT NOT NULL,                     -- JSON array of dream_videos.id
  max_duration REAL,                              -- longest of those videos, seconds
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'created', 'dismissed')),
  formula_slug TEXT,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS dream_formula_proposals_open ON dream_formula_proposals(folder_id, mo_dau, cau_truc) WHERE status = 'open';

-- one row per day the morning suggestions ran (also when no formula could be picked), so a restart does not run twice
CREATE TABLE IF NOT EXISTS dream_idea_runs (
  day         TEXT PRIMARY KEY,                   -- YYYY-MM-DD, Asia/Ho_Chi_Minh
  folder_id   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running', 'done')),
  picked      INTEGER NOT NULL DEFAULT 0,
  written     INTEGER NOT NULL DEFAULT 0,
  note_path   TEXT,
  log         TEXT,                               -- Vietnamese lines: empty slots and why
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);

-- one suggestion. The expectation (expected_ratio) and the formula version are fixed here, when it is suggested.
CREATE TABLE IF NOT EXISTS dream_ideas (
  day               TEXT NOT NULL,
  slot              INTEGER NOT NULL,
  folder_id         TEXT NOT NULL,
  formula_path      TEXT NOT NULL,
  formula_slug      TEXT NOT NULL,
  formula_version   INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('hop', 'thu')),  -- a formula that fits, or one never tried
  source_video_path TEXT,
  source_video_slug TEXT,
  expected_ratio    REAL NOT NULL,
  tru_cot           TEXT,
  tieu_de           TEXT NOT NULL,
  cau_mo_dau        TEXT NOT NULL,
  viec_can_lam      TEXT NOT NULL,
  nen_tang          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'later', 'given', 'rejected')),
  reject_reason     TEXT,
  content_id        INTEGER,
  task_id           INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (day, slot)
);
CREATE INDEX IF NOT EXISTS dream_ideas_formula ON dream_ideas(formula_slug, status);

-- small key/value state: the cursor of learn's note feed
CREATE TABLE IF NOT EXISTS dream_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- one row per (post note, milestone) compared, so a replayed event with the same ER does not run the agent twice
CREATE TABLE IF NOT EXISTS dream_comparisons (
  folder_id    TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  milestone    TEXT NOT NULL,
  formula_slug TEXT NOT NULL,
  er           REAL,
  baseline_er  REAL,
  baseline_n   INTEGER NOT NULL,
  ratio        REAL,
  vs_expected  REAL,
  compared_at  INTEGER NOT NULL,
  PRIMARY KEY (folder_id, rel_path, milestone)
);
