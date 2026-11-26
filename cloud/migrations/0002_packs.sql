-- T20: kho gói dữ liệu.
-- Một bản phát hành đi qua: pending (đã cấp đường tải lên) → draft (đã kiểm zip, chờ phát hành)
-- → published → yanked. Các cột kích thước, băm, manifest chỉ có từ draft; chữ ký chỉ có từ published.

CREATE TABLE packs (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL CHECK (module IN ('brain','learn','dream','crm')),
  name TEXT NOT NULL,
  summary TEXT,
  industry TEXT,
  cover_key TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','unlisted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX packs_module ON packs (module, industry);

CREATE TABLE pack_releases (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES packs(id),
  version TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER,
  sha256 TEXT,
  signature TEXT,
  key_id TEXT,
  manifest_json TEXT,
  notes_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','draft','published','yanked')),
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  yanked_at INTEGER,
  UNIQUE (pack_id, version)
);

CREATE TABLE downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX downloads_user_at ON downloads (user_id, at);
