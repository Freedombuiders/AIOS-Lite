// Data packs installed from the cloud store (src/packs). One row per pack per brain folder, and one row per
// note the machine wrote, with the hash of what it wrote: a file whose hash differs was changed by the owner
// and is never overwritten or deleted by an update or an uninstall.

export const CORE_MIGRATION_004 = /* sql */ `
CREATE TABLE IF NOT EXISTS pack_installs (
  pack_id      TEXT NOT NULL,
  version      TEXT NOT NULL,
  folder_id    TEXT NOT NULL,
  module       TEXT NOT NULL,
  name         TEXT NOT NULL,
  zip_sha256   TEXT NOT NULL,
  key_id       TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (pack_id, folder_id)
);
CREATE TABLE IF NOT EXISTS pack_files (
  pack_id   TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  rel_path  TEXT NOT NULL,
  sha256    TEXT NOT NULL,
  PRIMARY KEY (pack_id, folder_id, rel_path)
);
CREATE INDEX IF NOT EXISTS idx_pack_files_path ON pack_files(folder_id, rel_path);
`;
