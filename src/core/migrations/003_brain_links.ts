// Wiki links between brain notes ([[slug]] / [[slug|nhãn]]), rebuilt from the files while indexing.
// Source of backlinks and of the brain graph. dst_slug is the link target, lowercased, without ".md".

export const CORE_MIGRATION_003 = /* sql */ `
CREATE TABLE IF NOT EXISTS brain_links (
  folder_id TEXT NOT NULL,
  src_path  TEXT NOT NULL,
  dst_slug  TEXT NOT NULL,
  PRIMARY KEY (folder_id, src_path, dst_slug)
);
CREATE INDEX IF NOT EXISTS idx_brain_links_dst ON brain_links(dst_slug);

-- notes indexed before this table existed have no links yet: make the next (incremental) reindex re-read them
UPDATE brain_docs SET mtime_ms = -1;
`;
