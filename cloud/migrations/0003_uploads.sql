-- T21: ảnh, video người dùng tải lên R2 (ảnh đăng bài, ảnh đại diện, ảnh bìa gói).
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size INTEGER,
  purpose TEXT NOT NULL CHECK (purpose IN ('post-media','avatar','pack-cover')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','deleted')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX uploads_user ON uploads (user_id, status, purpose);
CREATE INDEX uploads_cleanup ON uploads (status, expires_at);
