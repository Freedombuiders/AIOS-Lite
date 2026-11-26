-- T14 · module learn: each published Facebook post becomes a brain note.
-- learn_state: small key/value state (the contentFeed cursor, the folder the 90-day backfill was done for).
CREATE TABLE IF NOT EXISTS learn_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Which note holds which post, per brain folder (two companies may both have noi-dung/bai/x.md).
-- source = 'facebook', source_id = fb_content.id as text.
CREATE TABLE IF NOT EXISTS learn_post_index (
  folder_id  TEXT NOT NULL,
  source     TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (folder_id, source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_learn_post_index_path ON learn_post_index(folder_id, rel_path);
