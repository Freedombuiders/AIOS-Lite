-- T14a · Lineage of a post and a durable feed for other modules.
-- Lineage is written once when the row is created (never by later edits):
--   idea_id            the idea the post came from
--   formula_slug       the formula used to write it, with formula_version
--   source_video_slug  the video the post was made from
--   expected_ratio     the expectation fixed when the idea was created
ALTER TABLE fb_content ADD COLUMN idea_id TEXT;
ALTER TABLE fb_content ADD COLUMN formula_slug TEXT;
ALTER TABLE fb_content ADD COLUMN formula_version INTEGER;
ALTER TABLE fb_content ADD COLUMN source_video_slug TEXT;
ALTER TABLE fb_content ADD COLUMN expected_ratio REAL;

CREATE INDEX IF NOT EXISTS idx_fb_content_idea ON fb_content(idea_id) WHERE idea_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fb_content_formula ON fb_content(formula_slug, formula_version) WHERE formula_slug IS NOT NULL;

-- Append-only: one row when a post becomes published ('published') and one each
-- time a metrics snapshot of a post actually changes ('snapshot'). Written in the
-- same transaction as the change. Consumers read it in id order with their own
-- cursor (provides.contentFeed), so nothing is lost across restarts.
CREATE TABLE IF NOT EXISTS fb_content_feed (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  content_id INTEGER NOT NULL,
  post_id    TEXT,
  milestone  TEXT,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fb_content_feed_content ON fb_content_feed(content_id, id);
