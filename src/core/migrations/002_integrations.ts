// Integrations (Pancake, Botcake, Composio…): encrypted credentials, call log, approvals for "ask" grants.

export const CORE_MIGRATION_002 = /* sql */ `
CREATE TABLE IF NOT EXISTS integration_credentials (
  integration_id TEXT PRIMARY KEY,
  values_enc     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'unchecked',
  status_detail  TEXT NOT NULL DEFAULT '',
  account_label  TEXT NOT NULL DEFAULT '',
  checked_at     INTEGER,
  updated_at     INTEGER NOT NULL
);

-- every command an agent ran (command name only, never its arguments)
CREATE TABLE IF NOT EXISTS integration_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  task_id        INTEGER,
  command        TEXT NOT NULL,
  access         TEXT NOT NULL,
  ok             INTEGER NOT NULL,
  error          TEXT NOT NULL DEFAULT '',
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integration_calls_recent ON integration_calls(integration_id, created_at);

-- write/destructive commands waiting for the owner (grant "ask", or destructive under "write")
CREATE TABLE IF NOT EXISTS integration_approvals (
  id             TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  task_id        INTEGER,
  command        TEXT NOT NULL,
  args_json      TEXT NOT NULL,
  args_hash      TEXT NOT NULL,
  risk           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','failed')),
  result_json    TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_integration_approvals_status ON integration_approvals(status, created_at);

-- "always allow exactly this": agent + integration + command + args hash
CREATE TABLE IF NOT EXISTS integration_trust_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  command        TEXT NOT NULL,
  args_hash      TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (agent_id, integration_id, command, args_hash)
);
`;
