// Owner sessions of the core API (src/api/owner.ts). Only a SHA-256 hash of each session token is stored, so a
// process that reads the database (an agent with a shell runs as the same OS user) cannot replay a session.

export const CORE_MIGRATION_005 = /* sql */ `
CREATE TABLE IF NOT EXISTS owner_sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
`;
