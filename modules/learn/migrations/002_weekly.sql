-- T15 · module learn part 2: lesson book, weekly review, score before posting.

-- One row per ISO week whose review note was written (so a restart after a missed Monday writes it once).
CREATE TABLE IF NOT EXISTS learn_weekly (
  year       INTEGER NOT NULL,
  week       INTEGER NOT NULL,
  folder_id  TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (year, week)
);

-- Every change of a lesson's state (and its creation, from_state NULL), for "đổi trạng thái tuần này".
CREATE TABLE IF NOT EXISTS learn_lesson_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id  TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  from_state TEXT,
  to_state   TEXT NOT NULL,
  actor      TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learn_lesson_log_at ON learn_lesson_log(folder_id, at);

-- What waits for the owner in "Chờ duyệt": a new lesson an agent proposed (kind 'new'), or a state change the
-- machine proposes (kind 'transition', to_state set). `basis` = measured trial posts when proposed, so a dismissed
-- proposal comes back only when there are more posts to judge.
CREATE TABLE IF NOT EXISTS learn_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id   TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('new', 'transition')),
  to_state    TEXT,
  reason      TEXT NOT NULL DEFAULT '',
  basis       INTEGER NOT NULL DEFAULT 0,
  proposed_by TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed', 'superseded')),
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_learn_proposals_open ON learn_proposals(folder_id, rel_path, kind, COALESCE(to_state, '')) WHERE status = 'open';

-- Opening type of a draft text by content hash: the same text is classified by an agent once.
CREATE TABLE IF NOT EXISTS learn_hook_cache (
  hash       TEXT PRIMARY KEY,
  mo_dau     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
