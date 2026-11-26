-- crm: one customer note per care customer (one-way export, database -> note)

-- Which note mirrors which customer. One row per customer; the same rel_path may exist in two folders
-- (two companies can both have khach-hang/lan.md), never twice in one folder.
CREATE TABLE IF NOT EXISTS crm_note_index (
  customer_id   TEXT PRIMARY KEY,
  folder_id     TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  -- sha256 of the machine-owned content last written (managed frontmatter keys + the two managed blocks)
  content_hash  TEXT,
  exported_at   INTEGER NOT NULL,
  UNIQUE (folder_id, rel_path)
);

-- Position of the exporter in care's change feed, per target folder.
CREATE TABLE IF NOT EXISTS crm_sync_state (
  folder_id        TEXT PRIMARY KEY,
  -- last care_customer_changes.seq applied
  feed_cursor      INTEGER NOT NULL DEFAULT 0,
  -- first full export: keyset position (last customer id done), done flag
  bootstrap_after  TEXT,
  bootstrap_done   INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap_done IN (0,1)),
  last_run_at      INTEGER,
  last_error       TEXT
);
