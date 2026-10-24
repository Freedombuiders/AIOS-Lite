-- Facebook Content Studio (marketing): core, comments, analytics. Bảng quảng cáo thuộc module ads.
-- @fbstudio-schema:core
CREATE TABLE IF NOT EXISTS fb_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per Facebook Page reachable through the Composio connection.
CREATE TABLE IF NOT EXISTS fb_pages (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  connection_id     TEXT NOT NULL DEFAULT '',
  entity_id         TEXT NOT NULL DEFAULT '',
  enabled           INTEGER NOT NULL DEFAULT 0,
  role              TEXT NOT NULL DEFAULT '',
  main_kpi          TEXT NOT NULL DEFAULT '',
  timezone          TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  approval_required INTEGER NOT NULL DEFAULT 1,
  max_posts_per_day INTEGER NOT NULL DEFAULT 3,
  min_gap_minutes   INTEGER NOT NULL DEFAULT 180,
  window_start      TEXT NOT NULL DEFAULT '07:00',
  window_end        TEXT NOT NULL DEFAULT '22:00',
  grace_minutes     INTEGER NOT NULL DEFAULT 30,
  brand_voice       TEXT NOT NULL DEFAULT '',
  pillars_json      TEXT NOT NULL DEFAULT '[]',
  writer_agent      TEXT NOT NULL DEFAULT 'main',
  video_agent       TEXT NOT NULL DEFAULT 'main',
  status            TEXT NOT NULL DEFAULT 'ACTIVE',
  picture_url       TEXT NOT NULL DEFAULT '',
  followers         INTEGER,
  synced_at         INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Every post the studio knows about: ideas, drafts, scheduled, published,
-- and posts imported from Facebook that were made outside the app
-- (origin = 'imported'). One row = one post on one Page.
CREATE TABLE IF NOT EXISTS fb_content (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id         TEXT,
  title           TEXT NOT NULL DEFAULT '',
  caption         TEXT NOT NULL DEFAULT '',
  format          TEXT NOT NULL DEFAULT 'text',
  pillar          TEXT NOT NULL DEFAULT '',
  hook_type       TEXT NOT NULL DEFAULT '',
  cta             TEXT NOT NULL DEFAULT '',
  campaign        TEXT NOT NULL DEFAULT '',
  hooks_json      TEXT NOT NULL DEFAULT '[]',
  link_url        TEXT NOT NULL DEFAULT '',
  media_json      TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'draft',
  scheduled_at    INTEGER,
  published_at    INTEGER,
  fb_post_id      TEXT,
  permalink       TEXT NOT NULL DEFAULT '',
  published_as    TEXT NOT NULL DEFAULT '',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error      TEXT NOT NULL DEFAULT '',
  feedback        TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'user',
  origin          TEXT NOT NULL DEFAULT 'studio',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_content_post ON fb_content(fb_post_id) WHERE fb_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fb_content_due ON fb_content(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_fb_content_page ON fb_content(page_id, status);

CREATE TABLE IF NOT EXISTS fb_publish_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id  INTEGER,
  page_id     TEXT,
  action      TEXT NOT NULL,
  tool        TEXT NOT NULL DEFAULT '',
  ok          INTEGER NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fb_publish_log_content ON fb_publish_log(content_id, created_at);

-- Composio calls per hour and area (publish|comments|analytics|ads|pages).
CREATE TABLE IF NOT EXISTS fb_api_usage (
  hour   INTEGER NOT NULL,
  area   TEXT NOT NULL,
  calls  INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, area)
);

-- @fbstudio-schema:comments
CREATE TABLE IF NOT EXISTS fb_comments (
  id               TEXT PRIMARY KEY,
  page_id          TEXT NOT NULL,
  post_id          TEXT NOT NULL,
  parent_id        TEXT,
  author_id        TEXT NOT NULL DEFAULT '',
  author_name      TEXT NOT NULL DEFAULT '',
  message          TEXT NOT NULL DEFAULT '',
  created_time     INTEGER NOT NULL,
  fetched_at       INTEGER NOT NULL,
  from_page        INTEGER NOT NULL DEFAULT 0,
  step             TEXT NOT NULL DEFAULT '',
  rule_ref         TEXT NOT NULL DEFAULT '',
  reason           TEXT NOT NULL DEFAULT '',
  reply_text       TEXT NOT NULL DEFAULT '',
  private_text     TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'new',
  send_after       INTEGER,
  reply_comment_id TEXT,
  private_sent     INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  error            TEXT NOT NULL DEFAULT '',
  topic            TEXT NOT NULL DEFAULT '',
  decided_at       INTEGER,
  sent_at          INTEGER,
  action           TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_fb_comments_page ON fb_comments(page_id, created_time);
CREATE INDEX IF NOT EXISTS idx_fb_comments_queue ON fb_comments(status, send_after);
CREATE INDEX IF NOT EXISTS idx_fb_comments_post ON fb_comments(post_id, created_time);

-- Last seen comment count per post, so a poll only fetches posts that changed.
CREATE TABLE IF NOT EXISTS fb_comment_watch (
  post_id         TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL,
  comment_count   INTEGER NOT NULL DEFAULT 0,
  post_created_at INTEGER,
  last_checked_at INTEGER,
  message         TEXT NOT NULL DEFAULT '',
  permalink       TEXT NOT NULL DEFAULT ''
);

-- scope = 'page:<pageId>' (full ReplyRuleConfig) or 'post:<postId>' (overrides only).
CREATE TABLE IF NOT EXISTS fb_reply_rules (
  scope       TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL,
  post_id     TEXT,
  config_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fb_reply_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       TEXT NOT NULL,
  post_id       TEXT,
  name          TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  match_mode    TEXT NOT NULL DEFAULT 'contains',
  variants_json TEXT NOT NULL DEFAULT '[]',
  private_text  TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0,
  uses          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fb_reply_templates_page ON fb_reply_templates(page_id, post_id, sort);

-- @fbstudio-schema:analytics
-- milestone: 1h|6h|24h|3d|7d|28d (age of the post) or 'latest' (daily sweep).
CREATE TABLE IF NOT EXISTS fb_post_metrics (
  post_id        TEXT NOT NULL,
  page_id        TEXT NOT NULL,
  milestone      TEXT NOT NULL,
  captured_at    INTEGER NOT NULL,
  reach          INTEGER,
  impressions    INTEGER,
  reactions      INTEGER,
  comments       INTEGER,
  shares         INTEGER,
  clicks         INTEGER,
  video_views_3s INTEGER,
  avg_watch_s    REAL,
  video_length_s REAL,
  follows        INTEGER,
  saves          INTEGER,
  raw_json       TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (post_id, milestone)
);

-- day = YYYY-MM-DD in the Page timezone.
CREATE TABLE IF NOT EXISTS fb_page_daily (
  page_id         TEXT NOT NULL,
  day             TEXT NOT NULL,
  reach           INTEGER,
  impressions     INTEGER,
  engaged_users   INTEGER,
  new_follows     INTEGER,
  unfollows       INTEGER,
  followers_total INTEGER,
  link_clicks     INTEGER,
  messages        INTEGER,
  raw_json        TEXT NOT NULL DEFAULT '{}',
  captured_at     INTEGER NOT NULL,
  PRIMARY KEY (page_id, day)
);

-- Analyst write-ups. kind: channel|post|ads. body_json: {summary:string[], actions:string[]} or {note:string}.
CREATE TABLE IF NOT EXISTS fb_insights (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  subject_id   TEXT NOT NULL DEFAULT '',
  period_days  INTEGER NOT NULL DEFAULT 28,
  body_json    TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fb_insights_subject ON fb_insights(kind, page_id, subject_id, created_at);

