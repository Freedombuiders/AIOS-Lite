-- T19: người dùng, phiên, mã một lần, nhật ký quản trị, giới hạn tần suất.
-- Mọi cột thời gian là mili giây kể từ epoch (UTC).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX users_created ON users (created_at, id);
CREATE INDEX users_email ON users (email);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('mobile','machine','web')),
  label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Mã một lần cho luồng đăng nhập trên máy tính. Chỉ lưu SHA-256 của mã.
CREATE TABLE login_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Lượt đăng nhập web đang chờ Google gọi lại: nối `state` gửi Google với địa chỉ trả về,
-- `state` của app, nonce và PKCE. Sống 10 phút, dùng một lần.
CREATE TABLE oauth_pending (
  state_hash TEXT PRIMARY KEY,
  return_url TEXT NOT NULL,
  client_state TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  at INTEGER NOT NULL
);

-- Đếm theo cửa sổ cố định: một dòng mỗi khoá (ví dụ "auth:<ip>").
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
