// Core schema. Agents, brain folders and connections are YAML files, not rows.
// Timestamps are ISO-8601 UTC strings (strftime('%Y-%m-%dT%H:%M:%fZ')).

export const CORE_MIGRATION_001 = /* sql */ `
CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT 'Cuộc trò chuyện mới',
  session_id      TEXT,
  session_runtime TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id, updated_at);

CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','waiting','review','done','failed','cancelled')),
  kind            TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','chat','team')),
  priority        INTEGER NOT NULL DEFAULT 0,
  parent_id       INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source          TEXT NOT NULL DEFAULT 'user',
  trigger         TEXT NOT NULL DEFAULT 'assigned',
  context_profile TEXT NOT NULL DEFAULT 'standard' CHECK (context_profile IN ('standard','lean')),
  depth           INTEGER NOT NULL DEFAULT 0,
  run_after       TEXT,
  result          TEXT,
  error           TEXT,
  recover_count   INTEGER NOT NULL DEFAULT 0,
  meta            TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, priority DESC, id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source, created_at);

CREATE TABLE IF NOT EXISTS task_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  run_id     INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, id);

CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,
  runtime        TEXT NOT NULL,
  model          TEXT,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','cancelled')),
  trigger        TEXT NOT NULL DEFAULT 'assigned',
  session_id     TEXT,
  output         TEXT,
  error_family   TEXT,
  error          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_usd       REAL,
  access_json    TEXT,
  skills_json    TEXT,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at    TEXT,
  duration_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, started_at);

CREATE TABLE IF NOT EXISTS run_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  type   TEXT NOT NULL,
  data   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS schedules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  cron         TEXT NOT NULL,
  timezone     TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  prompt       TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_run_at  TEXT,
  next_run_at  TEXT,
  last_task_id INTEGER,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','agent','system')),
  content         TEXT NOT NULL,
  task_id         INTEGER,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS memories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       TEXT,
  content        TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'user',
  source_task_id INTEGER,
  source_run_id  INTEGER,
  pinned         INTEGER NOT NULL DEFAULT 0,
  use_count      INTEGER NOT NULL DEFAULT 0,
  last_used_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, content='memories', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS brain_docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id  TEXT NOT NULL,
  path       TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (folder_id, path)
);
CREATE VIRTUAL TABLE IF NOT EXISTS brain_fts USING fts5(
  title, content, content='brain_docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS brain_ai AFTER INSERT ON brain_docs BEGIN
  INSERT INTO brain_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS brain_ad AFTER DELETE ON brain_docs BEGIN
  INSERT INTO brain_fts(brain_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS brain_au AFTER UPDATE ON brain_docs BEGIN
  INSERT INTO brain_fts(brain_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO brain_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TABLE IF NOT EXISTS board (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT,
  task_id    INTEGER,
  kind       TEXT NOT NULL DEFAULT 'note',
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  run_id  INTEGER,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor, ts);

CREATE TABLE IF NOT EXISTS attention (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  detail     TEXT,
  task_id    INTEGER,
  module_id  TEXT,
  link       TEXT,
  severity   TEXT NOT NULL DEFAULT 'info',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS modules (
  id           TEXT PRIMARY KEY,
  enabled      INTEGER NOT NULL DEFAULT 0,
  version      TEXT NOT NULL,
  installed_at TEXT,
  settings     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
