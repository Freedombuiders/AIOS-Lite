// Store for the marketing module (fb_* tables). Extracted from the owner's db.ts sections
// core/comments/analytics/shared; the handle comes from compat getDb(), never opened here.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb, _initTestDatabase as initCompatDatabase } from '../../../src/modules/compat/index.js';

const db = new Proxy({} as ReturnType<typeof getDb>, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});
/** Test helper: a fresh in-memory database with the core schema plus this module's tables. */
export function _initTestDatabase(databasePath = ':memory:'): void {
  initCompatDatabase(databasePath);
  getDb().exec(fs.readFileSync(fileURLToPath(new URL('../migrations/001_init.sql', import.meta.url)), 'utf8'));
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

// @fbstudio-db:shared

export function getFbSetting(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM fb_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setFbSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO fb_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowSec());
}

/** Counts one Composio call against the current hour for `area`. */
export function recordFbApiCall(area: string, ok: boolean, atSec: number = nowSec()): void {
  const hour = atSec - (atSec % 3600);
  db.prepare(
    `INSERT INTO fb_api_usage (hour, area, calls, errors) VALUES (?, ?, 1, ?)
     ON CONFLICT(hour, area) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors`,
  ).run(hour, area, ok ? 0 : 1);
}

/** Composio calls since `sinceSec` (rounded down to the hour), optionally for one area. */
export function countFbApiCallsSince(sinceSec: number, area?: string): number {
  const hour = sinceSec - (sinceSec % 3600);
  const row = area
    ? db.prepare(`SELECT COALESCE(SUM(calls), 0) AS n FROM fb_api_usage WHERE hour >= ? AND area = ?`).get(hour, area)
    : db.prepare(`SELECT COALESCE(SUM(calls), 0) AS n FROM fb_api_usage WHERE hour >= ?`).get(hour);
  return (row as { n: number }).n;
}

// @fbstudio-db:core

export interface FbPageRow {
  id: string;
  name: string;
  connection_id: string;
  entity_id: string;
  enabled: number;
  role: string;
  main_kpi: string;
  timezone: string;
  approval_required: number;
  max_posts_per_day: number;
  min_gap_minutes: number;
  window_start: string;
  window_end: string;
  grace_minutes: number;
  brand_voice: string;
  pillars_json: string;
  writer_agent: string;
  video_agent: string;
  status: string;
  picture_url: string;
  followers: number | null;
  synced_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface FbContentRow {
  id: number;
  page_id: string | null;
  title: string;
  caption: string;
  format: string;
  pillar: string;
  hook_type: string;
  cta: string;
  campaign: string;
  hooks_json: string;
  link_url: string;
  media_json: string;
  status: string;
  scheduled_at: number | null;
  published_at: number | null;
  fb_post_id: string | null;
  permalink: string;
  published_as: string;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string;
  feedback: string;
  source: string;
  origin: string;
  created_at: number;
  updated_at: number;
}

export interface FbPublishLogRow {
  id: number;
  content_id: number | null;
  page_id: string | null;
  action: string;
  tool: string;
  ok: number;
  detail: string;
  duration_ms: number;
  created_at: number;
}

const FB_PAGE_EDITABLE = new Set([
  'name', 'connection_id', 'entity_id', 'enabled', 'role', 'main_kpi', 'timezone', 'approval_required',
  'max_posts_per_day', 'min_gap_minutes', 'window_start', 'window_end', 'grace_minutes', 'brand_voice',
  'pillars_json', 'writer_agent', 'video_agent', 'status', 'picture_url', 'followers', 'synced_at',
]);

const FB_CONTENT_EDITABLE = new Set([
  'page_id', 'title', 'caption', 'format', 'pillar', 'hook_type', 'cta', 'campaign', 'hooks_json', 'link_url',
  'media_json', 'status', 'scheduled_at', 'published_at', 'fb_post_id', 'permalink', 'published_as', 'attempts',
  'next_attempt_at', 'last_error', 'feedback', 'source',
]);

function fbSetClause(patch: Record<string, unknown>, allowed: Set<string>): { sql: string; values: unknown[] } {
  const keys = Object.keys(patch).filter((k) => allowed.has(k) && patch[k] !== undefined);
  return { sql: keys.map((k) => `${k} = ?`).join(', '), values: keys.map((k) => patch[k]) };
}

export function listFbPages(): FbPageRow[] {
  return db.prepare(`SELECT * FROM fb_pages ORDER BY enabled DESC, name COLLATE NOCASE`).all() as FbPageRow[];
}

export function getFbPage(id: string): FbPageRow | undefined {
  return db.prepare(`SELECT * FROM fb_pages WHERE id = ?`).get(id) as FbPageRow | undefined;
}

/** Inserts a Page found by a sync (disabled until the owner enables it) or refreshes its connection and profile data. */
export function upsertFbPageFromSync(p: {
  id: string;
  name: string;
  connection_id: string;
  entity_id: string;
  picture_url: string;
  followers: number | null;
}): void {
  const now = nowSec();
  db.prepare(
    `INSERT INTO fb_pages (id, name, connection_id, entity_id, enabled, status, picture_url, followers, synced_at, created_at, updated_at)
     VALUES (@id, @name, @connection_id, @entity_id, 0, 'ACTIVE', @picture_url, @followers, @now, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       connection_id = excluded.connection_id,
       entity_id = excluded.entity_id,
       status = 'ACTIVE',
       picture_url = CASE WHEN excluded.picture_url <> '' THEN excluded.picture_url ELSE fb_pages.picture_url END,
       followers = COALESCE(excluded.followers, fb_pages.followers),
       synced_at = excluded.synced_at,
       updated_at = excluded.updated_at`,
  ).run({ ...p, now });
}

export function updateFbPageFields(id: string, patch: Record<string, unknown>): boolean {
  const { sql, values } = fbSetClause(patch, FB_PAGE_EDITABLE);
  if (!sql) return false;
  return db.prepare(`UPDATE fb_pages SET ${sql}, updated_at = ? WHERE id = ?`).run(...values, nowSec(), id).changes > 0;
}

/** Sets a Page's connection status. Returns true when the status actually changed. */
export function setFbPageStatus(id: string, status: string): boolean {
  return db.prepare(`UPDATE fb_pages SET status = ?, updated_at = ? WHERE id = ? AND status <> ?`).run(status, nowSec(), id, status).changes > 0;
}

/** Marks every Page served by `connectionId` as EXPIRED; returns the ids that were not EXPIRED before. */
export function expireFbPagesForConnection(connectionId: string): string[] {
  const rows = db.prepare(`SELECT id FROM fb_pages WHERE connection_id = ? AND status <> 'EXPIRED'`).all(connectionId) as Array<{ id: string }>;
  if (rows.length === 0) return [];
  db.prepare(`UPDATE fb_pages SET status = 'EXPIRED', updated_at = ? WHERE connection_id = ? AND status <> 'EXPIRED'`).run(nowSec(), connectionId);
  return rows.map((r) => r.id);
}

export function insertFbContent(row: Partial<Omit<FbContentRow, 'id' | 'created_at' | 'updated_at'>>): number {
  const now = nowSec();
  const keys = Object.keys(row).filter((k) => FB_CONTENT_EDITABLE.has(k) && (row as Record<string, unknown>)[k] !== undefined);
  const cols = [...keys, 'created_at', 'updated_at'];
  const values = [...keys.map((k) => (row as Record<string, unknown>)[k]), now, now];
  const res = db.prepare(`INSERT INTO fb_content (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...values);
  return Number(res.lastInsertRowid);
}

export function getFbContent(id: number): FbContentRow | undefined {
  return db.prepare(`SELECT * FROM fb_content WHERE id = ?`).get(id) as FbContentRow | undefined;
}

/**
 * Updates a content row; when `onlyStatuses` is given the UPDATE only applies
 * while the row is in one of them (an atomic compare-and-set). Returns true
 * when a row changed.
 */
export function updateFbContentFields(id: number, patch: Record<string, unknown>, onlyStatuses?: string[]): boolean {
  const { sql, values } = fbSetClause(patch, FB_CONTENT_EDITABLE);
  if (!sql) return false;
  const guard = onlyStatuses?.length ? ` AND status IN (${onlyStatuses.map(() => '?').join(', ')})` : '';
  return db.prepare(`UPDATE fb_content SET ${sql}, updated_at = ? WHERE id = ?${guard}`).run(...values, nowSec(), id, ...(onlyStatuses ?? [])).changes > 0;
}

/** Marks who created a row ('kol' for KOL Studio hand-offs); origin is not part of the editable fields. */
export function setFbContentOrigin(id: number, origin: string): void {
  db.prepare(`UPDATE fb_content SET origin = ? WHERE id = ?`).run(origin, id);
}

export function deleteFbContentRow(id: number): boolean {
  return db.prepare(`DELETE FROM fb_content WHERE id = ? AND status <> 'publishing'`).run(id).changes > 0;
}

export interface FbContentFilter {
  /** One status or a comma-separated list ('failed,missed'). */
  status?: string;
  pageId?: string;
  format?: string;
  pillar?: string;
  q?: string;
}

function fbContentWhere(f: FbContentFilter, withStatus: boolean): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (withStatus && f.status) {
    const list = f.status.split(',').map((x) => x.trim()).filter(Boolean);
    where.push(`status IN (${list.map(() => '?').join(', ')})`);
    params.push(...list);
  }
  if (f.pageId) { where.push('page_id = ?'); params.push(f.pageId); }
  if (f.format) { where.push('format = ?'); params.push(f.format); }
  if (f.pillar) { where.push('pillar = ?'); params.push(f.pillar); }
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(title LIKE ? ESCAPE '\\' OR caption LIKE ? ESCAPE '\\' OR hooks_json LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listFbContentRows(f: FbContentFilter, limit: number, offset: number): { rows: FbContentRow[]; total: number } {
  const { sql, params } = fbContentWhere(f, true);
  const rows = db.prepare(`SELECT * FROM fb_content ${sql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as FbContentRow[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM fb_content ${sql}`).get(...params) as { n: number }).n;
  return { rows, total };
}

/** Per-status counts for the same filters as the list, ignoring the status filter itself. */
export function countFbContentByStatus(f: FbContentFilter): Record<string, number> {
  const { sql, params } = fbContentWhere(f, false);
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM fb_content ${sql} GROUP BY status`).all(...params) as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Scheduled or published in [fromSec, toSec), plus missed/failed rows scheduled in the range. */
export function listFbCalendarRows(fromSec: number, toSec: number, pageId?: string): FbContentRow[] {
  const pageSql = pageId ? ' AND page_id = ?' : '';
  const params: unknown[] = [fromSec, toSec, fromSec, toSec, fromSec, toSec];
  if (pageId) params.push(pageId);
  return db.prepare(
    `SELECT * FROM fb_content WHERE (
       (status IN ('scheduled', 'publishing', 'missed', 'failed') AND scheduled_at >= ? AND scheduled_at < ?)
       OR (status = 'published' AND COALESCE(published_at, scheduled_at) >= ? AND COALESCE(published_at, scheduled_at) < ?)
       OR (status = 'approved' AND scheduled_at >= ? AND scheduled_at < ?)
     )${pageSql} ORDER BY COALESCE(published_at, scheduled_at) ASC, id ASC`,
  ).all(...params) as FbContentRow[];
}

/** Times (published or scheduled) of the Page's posts in [fromSec, toSec], used for the scheduling rules. */
export function listFbOccupiedTimes(pageId: string, fromSec: number, toSec: number, excludeId?: number): number[] {
  const rows = db.prepare(
    `SELECT COALESCE(published_at, scheduled_at) AS t FROM fb_content
     WHERE page_id = ? AND id <> ? AND status IN ('scheduled', 'publishing', 'published')
       AND COALESCE(published_at, scheduled_at) BETWEEN ? AND ?`,
  ).all(pageId, excludeId ?? -1, fromSec, toSec) as Array<{ t: number }>;
  return rows.map((r) => r.t);
}

export function listDueFbContent(now: number, limit: number): FbContentRow[] {
  return db.prepare(
    `SELECT * FROM fb_content WHERE status = 'scheduled' AND scheduled_at <= ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY scheduled_at ASC, id ASC LIMIT ?`,
  ).all(now, now, limit) as FbContentRow[];
}

/** Atomically moves a row to 'publishing' and counts the attempt. Returns false when someone else got it first. */
export function claimFbContent(id: number, fromStatuses: string[], now: number = nowSec()): boolean {
  return db.prepare(
    `UPDATE fb_content SET status = 'publishing', attempts = attempts + 1, next_attempt_at = NULL, updated_at = ?
     WHERE id = ? AND status IN (${fromStatuses.map(() => '?').join(', ')})`,
  ).run(now, id, ...fromStatuses).changes === 1;
}

/** Undoes a claim that never reached Facebook (budget spent, Page not ready): no attempt is counted. */
export function releaseFbContentClaim(id: number, backTo: string, nextAttemptAt: number | null): boolean {
  return db.prepare(
    `UPDATE fb_content SET status = ?, attempts = MAX(attempts - 1, 0), next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'publishing'`,
  ).run(backTo, nextAttemptAt, nowSec(), id).changes === 1;
}

export function listStuckFbPublishing(updatedBefore: number): FbContentRow[] {
  return db.prepare(`SELECT * FROM fb_content WHERE status = 'publishing' AND updated_at < ?`).all(updatedBefore) as FbContentRow[];
}

export function getNextScheduledFbContent(): (FbContentRow & { page_name: string | null }) | undefined {
  return db.prepare(
    `SELECT c.*, p.name AS page_name FROM fb_content c LEFT JOIN fb_pages p ON p.id = c.page_id
     WHERE c.status = 'scheduled' AND c.scheduled_at IS NOT NULL ORDER BY c.scheduled_at ASC, c.id ASC LIMIT 1`,
  ).get() as (FbContentRow & { page_name: string | null }) | undefined;
}

export function insertFbPublishLog(e: {
  content_id: number | null;
  page_id: string | null;
  action: string;
  tool?: string;
  ok: boolean;
  detail?: string;
  duration_ms?: number;
}): void {
  db.prepare(
    `INSERT INTO fb_publish_log (content_id, page_id, action, tool, ok, detail, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.content_id, e.page_id, e.action, e.tool ?? '', e.ok ? 1 : 0, (e.detail ?? '').slice(0, 500), e.duration_ms ?? 0, nowSec());
}

export function listFbPublishLog(contentId: number, limit = 50): FbPublishLogRow[] {
  return db.prepare(`SELECT * FROM fb_publish_log WHERE content_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(contentId, limit) as FbPublishLogRow[];
}

/** Newest metrics row for a post ('latest' sweep first, otherwise the most recent milestone). */
export function getFbLatestPostMetrics(postId: string): { reach: number | null; reactions: number | null; comments: number | null; shares: number | null } | undefined {
  return db.prepare(
    `SELECT reach, reactions, comments, shares FROM fb_post_metrics WHERE post_id = ?
     ORDER BY (milestone = 'latest') DESC, captured_at DESC LIMIT 1`,
  ).get(postId) as { reach: number | null; reactions: number | null; comments: number | null; shares: number | null } | undefined;
}

export function getFbPageWeekCounts(pageId: string, weekStart: number, weekEnd: number): { posted: number; scheduled: number } {
  const posted = (db.prepare(`SELECT COUNT(*) AS n FROM fb_content WHERE page_id = ? AND status = 'published' AND published_at >= ? AND published_at < ?`).get(pageId, weekStart, weekEnd) as { n: number }).n;
  const scheduled = (db.prepare(`SELECT COUNT(*) AS n FROM fb_content WHERE page_id = ? AND status = 'scheduled' AND scheduled_at >= ? AND scheduled_at < ?`).get(pageId, weekStart, weekEnd) as { n: number }).n;
  return { posted, scheduled };
}

export function countFbSentReplies(pageId: string, sinceSec: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM fb_comments WHERE page_id = ? AND status = 'sent' AND sent_at >= ?`).get(pageId, sinceSec) as { n: number }).n;
}

/** Newest Analyst summary for a Page (kind 'channel'), or undefined before the Analyst has run. */
export function getLatestFbChannelInsight(pageId: string): { body_json: string; created_at: number } | undefined {
  return db.prepare(
    `SELECT body_json, created_at FROM fb_insights WHERE page_id = ? AND kind = 'channel' ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(pageId) as { body_json: string; created_at: number } | undefined;
}

/** Published posts of a Page since `sinceSec` with their newest metrics, for planning (content-cli insights). */
export function listFbPostsWithMetrics(pageId: string, sinceSec: number): Array<FbContentRow & { reach: number | null; reactions: number | null; m_comments: number | null; m_shares: number | null }> {
  return db.prepare(
    `SELECT c.*, m.reach AS reach, m.reactions AS reactions, m.comments AS m_comments, m.shares AS m_shares
       FROM fb_content c
       LEFT JOIN fb_post_metrics m ON m.post_id = c.fb_post_id
        AND m.captured_at = (SELECT MAX(captured_at) FROM fb_post_metrics WHERE post_id = c.fb_post_id)
      WHERE c.page_id = ? AND c.status = 'published' AND c.published_at >= ?`,
  ).all(pageId, sinceSec) as Array<FbContentRow & { reach: number | null; reactions: number | null; m_comments: number | null; m_shares: number | null }>;
}

// @fbstudio-db:comments

export interface FbCommentRow {
  id: string;
  page_id: string;
  post_id: string;
  parent_id: string | null;
  author_id: string;
  author_name: string;
  message: string;
  created_time: number;
  fetched_at: number;
  from_page: number;
  step: string;
  rule_ref: string;
  reason: string;
  reply_text: string;
  private_text: string;
  status: string;
  send_after: number | null;
  reply_comment_id: string | null;
  private_sent: number;
  attempts: number;
  error: string;
  topic: string;
  decided_at: number | null;
  sent_at: number | null;
  action: string;
}

export interface FbCommentLogRow extends FbCommentRow {
  post_title: string;
  post_permalink: string;
}

export interface FbCommentWatchRow {
  post_id: string;
  page_id: string;
  comment_count: number;
  post_created_at: number | null;
  last_checked_at: number | null;
  message: string;
  permalink: string;
}

export interface FbReplyTemplateRow {
  id: number;
  page_id: string;
  post_id: string | null;
  name: string;
  keywords_json: string;
  match_mode: string;
  variants_json: string;
  private_text: string;
  enabled: number;
  sort: number;
  uses: number;
  created_at: number;
  updated_at: number;
}

/** The slice of fb_pages the comments worker needs. */
export interface FbCommentPageRow {
  id: string;
  name: string;
  connection_id: string;
  entity_id: string;
  enabled: number;
  status: string;
  brand_voice: string;
  timezone: string;
}

const FB_COMMENT_UPDATABLE = new Set([
  'step', 'rule_ref', 'reason', 'reply_text', 'private_text', 'status', 'send_after', 'reply_comment_id',
  'private_sent', 'attempts', 'error', 'topic', 'decided_at', 'sent_at', 'action',
]);

export function getFbCommentPage(pageId: string): FbCommentPageRow | undefined {
  return db.prepare(
    `SELECT id, name, connection_id, entity_id, enabled, status, brand_voice, timezone FROM fb_pages WHERE id = ?`,
  ).get(pageId) as FbCommentPageRow | undefined;
}

export function listFbCommentPages(): FbCommentPageRow[] {
  return db.prepare(
    `SELECT id, name, connection_id, entity_id, enabled, status, brand_voice, timezone FROM fb_pages ORDER BY name`,
  ).all() as FbCommentPageRow[];
}

/** Sets a Page's connection status; true when the status actually changed. */
export function setFbCommentPageStatus(pageId: string, status: string): boolean {
  return db.prepare(`UPDATE fb_pages SET status = ?, updated_at = ? WHERE id = ? AND status != ?`)
    .run(status, nowSec(), pageId, status).changes > 0;
}

/** Inserts a comment unless its id is already stored; true when a row was added. */
export function insertFbCommentIfNew(row: Omit<FbCommentRow, 'action'> & { action?: string }): boolean {
  return db.prepare(
    `INSERT OR IGNORE INTO fb_comments
       (id, page_id, post_id, parent_id, author_id, author_name, message, created_time, fetched_at, from_page,
        step, rule_ref, reason, reply_text, private_text, status, send_after, reply_comment_id, private_sent,
        attempts, error, topic, decided_at, sent_at, action)
     VALUES (@id, @page_id, @post_id, @parent_id, @author_id, @author_name, @message, @created_time, @fetched_at, @from_page,
        @step, @rule_ref, @reason, @reply_text, @private_text, @status, @send_after, @reply_comment_id, @private_sent,
        @attempts, @error, @topic, @decided_at, @sent_at, @action)`,
  ).run({ action: '', ...row }).changes > 0;
}

export function getFbComment(id: string): FbCommentRow | undefined {
  return db.prepare(`SELECT * FROM fb_comments WHERE id = ?`).get(id) as FbCommentRow | undefined;
}

export function fbCommentExists(id: string): boolean {
  return db.prepare(`SELECT 1 FROM fb_comments WHERE id = ?`).get(id) !== undefined;
}

/** True when `id` is a comment the studio itself posted as a reply (guards against answering our own replies). */
export function isFbOwnReplyId(id: string): boolean {
  return db.prepare(`SELECT 1 FROM fb_comments WHERE reply_comment_id = ?`).get(id) !== undefined;
}

export function updateFbComment(id: string, patch: Partial<Omit<FbCommentRow, 'id' | 'page_id' | 'post_id'>>): void {
  const entries = Object.entries(patch).filter(([k, v]) => FB_COMMENT_UPDATABLE.has(k) && v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE fb_comments SET ${sets} WHERE id = @row_id`)
    .run({ ...Object.fromEntries(entries), row_id: id });
}

/**
 * Takes a lease on a queued comment: only one caller wins, and the comment
 * is not due again until `leaseUntil`. Counts the attempt.
 */
export function claimFbCommentForSend(id: string, now: number, leaseUntil: number): boolean {
  return db.prepare(
    `UPDATE fb_comments SET attempts = attempts + 1, send_after = ?
     WHERE id = ? AND status = 'queued' AND send_after IS NOT NULL AND send_after <= ?`,
  ).run(leaseUntil, id, now).changes === 1;
}

export function listFbNewComments(pageId: string, limit: number): FbCommentRow[] {
  return db.prepare(
    `SELECT * FROM fb_comments WHERE page_id = ? AND status = 'new' AND from_page = 0
     ORDER BY created_time ASC LIMIT ?`,
  ).all(pageId, limit) as FbCommentRow[];
}

export function listFbDueComments(now: number, limit: number): FbCommentRow[] {
  return db.prepare(
    `SELECT * FROM fb_comments WHERE status = 'queued' AND send_after IS NOT NULL AND send_after <= ?
     ORDER BY send_after ASC LIMIT ?`,
  ).all(now, limit) as FbCommentRow[];
}

const FB_COMMENT_LOG_SELECT = `
  SELECT c.*,
         COALESCE(NULLIF(fc.title, ''), NULLIF(fc.caption, ''), NULLIF(w.message, ''), '') AS post_title,
         COALESCE(NULLIF(fc.permalink, ''), w.permalink, '') AS post_permalink
  FROM fb_comments c
  LEFT JOIN fb_content fc ON fc.fb_post_id = c.post_id
  LEFT JOIN fb_comment_watch w ON w.post_id = c.post_id`;

/** The newest customer comments of a Page (the Page's own comments are not part of the log). */
export function listFbCommentsForLog(pageId: string, limit: number): FbCommentLogRow[] {
  return db.prepare(
    `${FB_COMMENT_LOG_SELECT} WHERE c.page_id = ? AND c.from_page = 0 ORDER BY c.created_time DESC, c.id DESC LIMIT ?`,
  ).all(pageId, limit) as FbCommentLogRow[];
}

export function getFbCommentForLog(id: string): FbCommentLogRow | undefined {
  return db.prepare(`${FB_COMMENT_LOG_SELECT} WHERE c.id = ?`).get(id) as FbCommentLogRow | undefined;
}

/** Customer comments created at or after `sinceSec`, for the log's KPIs and charts. */
export function listFbCommentsSince(pageId: string, sinceSec: number): FbCommentRow[] {
  return db.prepare(
    `SELECT * FROM fb_comments WHERE page_id = ? AND from_page = 0 AND created_time >= ? ORDER BY created_time ASC`,
  ).all(pageId, sinceSec) as FbCommentRow[];
}

export function topFbCommentTopics(pageId: string, sinceSec: number, limit: number): { topic: string; count: number }[] {
  return db.prepare(
    `SELECT topic, COUNT(*) AS count FROM fb_comments
     WHERE page_id = ? AND from_page = 0 AND created_time >= ? AND topic != ''
     GROUP BY topic ORDER BY count DESC, topic ASC LIMIT ?`,
  ).all(pageId, sinceSec, limit) as { topic: string; count: number }[];
}

/** Comments of a post created before `beforeSec` (newest first), including the Page's own, for agent context. */
export function listFbThreadComments(postId: string, beforeSec: number, excludeId: string, limit: number): FbCommentRow[] {
  return db.prepare(
    `SELECT * FROM fb_comments WHERE post_id = ? AND created_time <= ? AND id != ?
     ORDER BY created_time DESC, id DESC LIMIT ?`,
  ).all(postId, beforeSec, excludeId, limit) as FbCommentRow[];
}

/** Replies (not reactions) the studio queued or sent for a Page since `sinceSec`. */
export function countFbRepliesDecidedSince(pageId: string, sinceSec: number): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM fb_comments
     WHERE page_id = ? AND from_page = 0 AND action = 'reply' AND status IN ('queued', 'sent') AND decided_at >= ?`,
  ).get(pageId, sinceSec) as { n: number };
  return row.n;
}

/** Replies the studio queued or sent to one author on one post. */
export function countFbRepliesToAuthorOnPost(postId: string, authorId: string, excludeId: string): number {
  if (!authorId) return 0;
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM fb_comments
     WHERE post_id = ? AND author_id = ? AND id != ? AND from_page = 0 AND action = 'reply' AND status IN ('queued', 'sent')`,
  ).get(postId, authorId, excludeId) as { n: number };
  return row.n;
}

/**
 * True when someone (the studio or a human on the Page) replied to this
 * author on this post since `sinceSec`.
 */
export function hasFbReplyToAuthorSince(postId: string, authorId: string, excludeId: string, sinceSec: number): boolean {
  if (!authorId) return false;
  const ours = db.prepare(
    `SELECT 1 FROM fb_comments
     WHERE post_id = ? AND author_id = ? AND id != ? AND from_page = 0 AND status IN ('queued', 'sent', 'reacted')
       AND decided_at >= ? LIMIT 1`,
  ).get(postId, authorId, excludeId, sinceSec);
  if (ours) return true;
  const human = db.prepare(
    `SELECT 1 FROM fb_comments p
     WHERE p.post_id = ? AND p.from_page = 1 AND p.created_time >= ?
       AND p.parent_id IN (SELECT id FROM fb_comments WHERE post_id = ? AND author_id = ? AND from_page = 0)
     LIMIT 1`,
  ).get(postId, sinceSec, postId, authorId);
  return human !== undefined;
}

export function getFbCommentWatch(postId: string): FbCommentWatchRow | undefined {
  return db.prepare(`SELECT * FROM fb_comment_watch WHERE post_id = ?`).get(postId) as FbCommentWatchRow | undefined;
}

export function listFbCommentWatch(pageId: string): FbCommentWatchRow[] {
  return db.prepare(`SELECT * FROM fb_comment_watch WHERE page_id = ? ORDER BY post_created_at DESC`)
    .all(pageId) as FbCommentWatchRow[];
}

/** Records what the poller saw of a post; `checked` also stamps last_checked_at (comments were fetched). */
export function upsertFbCommentWatch(row: {
  post_id: string; page_id: string; comment_count: number; post_created_at: number | null;
  message: string; permalink: string; last_checked_at: number | null;
}): void {
  db.prepare(
    `INSERT INTO fb_comment_watch (post_id, page_id, comment_count, post_created_at, last_checked_at, message, permalink)
     VALUES (@post_id, @page_id, @comment_count, @post_created_at, @last_checked_at, @message, @permalink)
     ON CONFLICT(post_id) DO UPDATE SET
       comment_count = excluded.comment_count,
       post_created_at = COALESCE(excluded.post_created_at, post_created_at),
       last_checked_at = COALESCE(excluded.last_checked_at, last_checked_at),
       message = CASE WHEN excluded.message != '' THEN excluded.message ELSE message END,
       permalink = CASE WHEN excluded.permalink != '' THEN excluded.permalink ELSE permalink END`,
  ).run(row);
}

/** Post title and caption for the agent's context: the studio's own record first, then what the poller saw. */
export function getFbPostText(postId: string): { title: string; caption: string } | undefined {
  const content = db.prepare(`SELECT title, caption FROM fb_content WHERE fb_post_id = ?`).get(postId) as
    { title: string; caption: string } | undefined;
  if (content && (content.title || content.caption)) return content;
  const watch = db.prepare(`SELECT message FROM fb_comment_watch WHERE post_id = ?`).get(postId) as { message: string } | undefined;
  return watch?.message ? { title: '', caption: watch.message } : content;
}

/** Recent posts of a Page for the per-post rule picker. */
export function listFbRecentPostsForRules(pageId: string, limit: number): { post_id: string; title: string; published_at: number | null }[] {
  return db.prepare(
    `SELECT post_id, title, published_at FROM (
       SELECT fb_post_id AS post_id,
              COALESCE(NULLIF(title, ''), NULLIF(caption, ''), '') AS title,
              published_at
       FROM fb_content WHERE page_id = ? AND fb_post_id IS NOT NULL AND status != 'deleted'
       UNION ALL
       SELECT w.post_id, w.message, w.post_created_at FROM fb_comment_watch w
       WHERE w.page_id = ? AND w.post_id NOT IN (SELECT fb_post_id FROM fb_content WHERE fb_post_id IS NOT NULL)
     ) ORDER BY published_at DESC LIMIT ?`,
  ).all(pageId, pageId, limit) as { post_id: string; title: string; published_at: number | null }[];
}

export function getFbReplyRuleJson(scope: string): string | undefined {
  const row = db.prepare(`SELECT config_json FROM fb_reply_rules WHERE scope = ?`).get(scope) as { config_json: string } | undefined;
  return row?.config_json;
}

export function putFbReplyRule(scope: string, pageId: string, postId: string | null, configJson: string): void {
  db.prepare(
    `INSERT INTO fb_reply_rules (scope, page_id, post_id, config_json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
  ).run(scope, pageId, postId, configJson, nowSec());
}

export function deleteFbReplyRule(scope: string): boolean {
  return db.prepare(`DELETE FROM fb_reply_rules WHERE scope = ?`).run(scope).changes > 0;
}

/** Scopes of the post-level overrides stored for a Page. */
export function listFbPostOverridePostIds(pageId: string): string[] {
  return (db.prepare(`SELECT post_id FROM fb_reply_rules WHERE page_id = ? AND post_id IS NOT NULL`).all(pageId) as { post_id: string }[])
    .map((r) => r.post_id);
}

/** Every template of a Page, page-scope and post-scope, in evaluation order. */
export function listFbReplyTemplates(pageId: string): FbReplyTemplateRow[] {
  return db.prepare(`SELECT * FROM fb_reply_templates WHERE page_id = ? ORDER BY sort ASC, id ASC`).all(pageId) as FbReplyTemplateRow[];
}

export function getFbReplyTemplate(id: number): FbReplyTemplateRow | undefined {
  return db.prepare(`SELECT * FROM fb_reply_templates WHERE id = ?`).get(id) as FbReplyTemplateRow | undefined;
}

export function insertFbReplyTemplate(t: {
  page_id: string; post_id: string | null; name: string; keywords_json: string; match_mode: string;
  variants_json: string; private_text: string; enabled: number; sort: number;
}): number {
  const now = nowSec();
  return Number(db.prepare(
    `INSERT INTO fb_reply_templates
       (page_id, post_id, name, keywords_json, match_mode, variants_json, private_text, enabled, sort, uses, created_at, updated_at)
     VALUES (@page_id, @post_id, @name, @keywords_json, @match_mode, @variants_json, @private_text, @enabled, @sort, 0, @now, @now)`,
  ).run({ ...t, now }).lastInsertRowid);
}

export function updateFbReplyTemplate(id: number, t: {
  post_id: string | null; name: string; keywords_json: string; match_mode: string;
  variants_json: string; private_text: string; enabled: number; sort: number;
}): void {
  db.prepare(
    `UPDATE fb_reply_templates SET post_id = @post_id, name = @name, keywords_json = @keywords_json,
       match_mode = @match_mode, variants_json = @variants_json, private_text = @private_text,
       enabled = @enabled, sort = @sort, updated_at = @now WHERE id = @id`,
  ).run({ ...t, id, now: nowSec() });
}

export function deleteFbReplyTemplate(id: number): boolean {
  return db.prepare(`DELETE FROM fb_reply_templates WHERE id = ?`).run(id).changes > 0;
}

export function bumpFbReplyTemplateUses(id: number): void {
  db.prepare(`UPDATE fb_reply_templates SET uses = uses + 1 WHERE id = ?`).run(id);
}

// @fbstudio-db:analytics

export interface FbAnalyticsPageRow {
  id: string;
  name: string;
  connection_id: string;
  entity_id: string;
  enabled: number;
  role: string;
  main_kpi: string;
  timezone: string;
  pillars_json: string;
  status: string;
  followers: number | null;
}

const FB_ANALYTICS_PAGE_COLS = `id, name, connection_id, entity_id, enabled, role, main_kpi, timezone, pillars_json, status, followers`;

export function listFbAnalyticsPages(opts: { enabledOnly?: boolean } = {}): FbAnalyticsPageRow[] {
  const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
  return db.prepare(`SELECT ${FB_ANALYTICS_PAGE_COLS} FROM fb_pages ${where} ORDER BY name`).all() as FbAnalyticsPageRow[];
}

export function getFbAnalyticsPage(id: string): FbAnalyticsPageRow | undefined {
  return db.prepare(`SELECT ${FB_ANALYTICS_PAGE_COLS} FROM fb_pages WHERE id = ?`).get(id) as FbAnalyticsPageRow | undefined;
}

export function setFbAnalyticsPageStatus(id: string, status: string): void {
  db.prepare(`UPDATE fb_pages SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowSec(), id);
}

export function setFbAnalyticsPageFollowers(id: string, followers: number): void {
  db.prepare(`UPDATE fb_pages SET followers = ?, synced_at = ?, updated_at = ? WHERE id = ?`).run(followers, nowSec(), nowSec(), id);
}

/** A published post of a Page (studio or imported) as analytics sees it. */
export interface FbAnalyticsPostRow {
  content_id: number;
  page_id: string;
  fb_post_id: string;
  title: string;
  caption: string;
  format: string;
  pillar: string;
  hook_type: string;
  source: string;
  origin: string;
  published_at: number | null;
  permalink: string;
}

const FB_ANALYTICS_POST_COLS = `id AS content_id, page_id, fb_post_id, title, caption, format, pillar, hook_type, source, origin, published_at, permalink`;

/** Published posts (with a Facebook id) of one Page published at or after `sinceSec`, oldest first. */
export function listFbAnalyticsPosts(pageId: string, sinceSec: number): FbAnalyticsPostRow[] {
  return db.prepare(
    `SELECT ${FB_ANALYTICS_POST_COLS} FROM fb_content
     WHERE page_id = ? AND status = 'published' AND fb_post_id IS NOT NULL AND published_at IS NOT NULL AND published_at >= ?
     ORDER BY published_at ASC`,
  ).all(pageId, sinceSec) as FbAnalyticsPostRow[];
}

export function getFbAnalyticsPostByFbId(fbPostId: string): FbAnalyticsPostRow | undefined {
  return db.prepare(
    `SELECT ${FB_ANALYTICS_POST_COLS} FROM fb_content WHERE fb_post_id = ? AND status != 'deleted'`,
  ).get(fbPostId) as FbAnalyticsPostRow | undefined;
}

/** Imported posts still waiting for a pillar / hook-type classification, newest first. */
export function listFbUnclassifiedImportedPosts(pageId: string, limit: number): FbAnalyticsPostRow[] {
  return db.prepare(
    `SELECT ${FB_ANALYTICS_POST_COLS} FROM fb_content
     WHERE page_id = ? AND origin = 'imported' AND status = 'published' AND pillar = '' AND caption != ''
     ORDER BY published_at DESC LIMIT ?`,
  ).all(pageId, limit) as FbAnalyticsPostRow[];
}

export function setFbImportedClassification(contentId: number, pillar: string, hookType: string): void {
  db.prepare(
    `UPDATE fb_content SET pillar = ?, hook_type = CASE WHEN hook_type = '' THEN ? ELSE hook_type END, updated_at = ?
     WHERE id = ? AND origin = 'imported' AND pillar = ''`,
  ).run(pillar, hookType, nowSec(), contentId);
}

export interface ImportedFbPostInput {
  pageId: string;
  fbPostId: string;
  title: string;
  caption: string;
  format: string;
  publishedAt: number | null;
  permalink: string;
  linkUrl?: string;
}

/**
 * Writes a post found on Facebook into fb_content (origin 'imported', status
 * 'published'). A post whose fb_post_id is already known is never duplicated:
 * imported rows get their caption/title/format refreshed, studio rows only
 * get empty permalink / published_at filled in.
 */
export function upsertImportedFbPost(input: ImportedFbPostInput): { id: number; created: boolean } {
  const existing = db.prepare(`SELECT id, origin FROM fb_content WHERE fb_post_id = ?`).get(input.fbPostId) as { id: number; origin: string } | undefined;
  const now = nowSec();
  if (existing) {
    if (existing.origin === 'imported') {
      db.prepare(
        `UPDATE fb_content SET title = ?, caption = ?, format = ?, permalink = ?, link_url = ?, updated_at = ?,
           published_at = COALESCE(published_at, ?)
         WHERE id = ?`,
      ).run(input.title, input.caption, input.format, input.permalink, input.linkUrl ?? '', now, input.publishedAt, existing.id);
    } else {
      db.prepare(
        `UPDATE fb_content SET permalink = CASE WHEN permalink = '' THEN ? ELSE permalink END,
           published_at = COALESCE(published_at, ?), updated_at = ?
         WHERE id = ?`,
      ).run(input.permalink, input.publishedAt, now, existing.id);
    }
    return { id: existing.id, created: false };
  }
  const info = db.prepare(
    `INSERT INTO fb_content (page_id, title, caption, format, status, published_at, fb_post_id, permalink, published_as,
       link_url, source, origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, 'facebook', 'imported', ?, ?)`,
  ).run(input.pageId, input.title, input.caption, input.format, input.publishedAt, input.fbPostId, input.permalink, input.format,
    input.linkUrl ?? '', now, now);
  return { id: Number(info.lastInsertRowid), created: true };
}

export interface FbPostMetricsRow {
  post_id: string;
  page_id: string;
  milestone: string;
  captured_at: number;
  reach: number | null;
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  video_views_3s: number | null;
  avg_watch_s: number | null;
  video_length_s: number | null;
  follows: number | null;
  saves: number | null;
  raw_json: string;
}

export function upsertFbPostMetrics(row: FbPostMetricsRow): void {
  db.prepare(
    `INSERT INTO fb_post_metrics (post_id, page_id, milestone, captured_at, reach, impressions, reactions, comments, shares,
       clicks, video_views_3s, avg_watch_s, video_length_s, follows, saves, raw_json)
     VALUES (@post_id, @page_id, @milestone, @captured_at, @reach, @impressions, @reactions, @comments, @shares,
       @clicks, @video_views_3s, @avg_watch_s, @video_length_s, @follows, @saves, @raw_json)
     ON CONFLICT(post_id, milestone) DO UPDATE SET
       captured_at = excluded.captured_at, reach = excluded.reach, impressions = excluded.impressions,
       reactions = excluded.reactions, comments = excluded.comments, shares = excluded.shares, clicks = excluded.clicks,
       video_views_3s = excluded.video_views_3s, avg_watch_s = excluded.avg_watch_s, video_length_s = excluded.video_length_s,
       follows = excluded.follows, saves = excluded.saves, raw_json = excluded.raw_json`,
  ).run(row);
}

/** Every snapshot of the Page's posts published at or after `sinceSec`. */
export function listFbPostMetrics(pageId: string, sinceSec: number): FbPostMetricsRow[] {
  return db.prepare(
    `SELECT m.* FROM fb_post_metrics m
     JOIN fb_content c ON c.fb_post_id = m.post_id
     WHERE m.page_id = ? AND c.published_at >= ?`,
  ).all(pageId, sinceSec) as FbPostMetricsRow[];
}

export function listFbPostMetricsForPost(postId: string): FbPostMetricsRow[] {
  return db.prepare(`SELECT * FROM fb_post_metrics WHERE post_id = ? ORDER BY captured_at`).all(postId) as FbPostMetricsRow[];
}

export function getLastFbSnapshotAt(pageId: string): number | null {
  const a = db.prepare(`SELECT MAX(captured_at) AS t FROM fb_post_metrics WHERE page_id = ?`).get(pageId) as { t: number | null };
  const b = db.prepare(`SELECT MAX(captured_at) AS t FROM fb_page_daily WHERE page_id = ?`).get(pageId) as { t: number | null };
  const t = Math.max(a.t ?? 0, b.t ?? 0);
  return t > 0 ? t : null;
}

export interface FbPageDailyRow {
  page_id: string;
  day: string;
  reach: number | null;
  impressions: number | null;
  engaged_users: number | null;
  new_follows: number | null;
  unfollows: number | null;
  followers_total: number | null;
  link_clicks: number | null;
  messages: number | null;
  raw_json: string;
  captured_at: number;
}

/** Merges per column: a metric that did not come back this time keeps its earlier value. */
export function upsertFbPageDaily(row: FbPageDailyRow): void {
  db.prepare(
    `INSERT INTO fb_page_daily (page_id, day, reach, impressions, engaged_users, new_follows, unfollows, followers_total,
       link_clicks, messages, raw_json, captured_at)
     VALUES (@page_id, @day, @reach, @impressions, @engaged_users, @new_follows, @unfollows, @followers_total,
       @link_clicks, @messages, @raw_json, @captured_at)
     ON CONFLICT(page_id, day) DO UPDATE SET
       reach = COALESCE(excluded.reach, reach), impressions = COALESCE(excluded.impressions, impressions),
       engaged_users = COALESCE(excluded.engaged_users, engaged_users), new_follows = COALESCE(excluded.new_follows, new_follows),
       unfollows = COALESCE(excluded.unfollows, unfollows), followers_total = COALESCE(excluded.followers_total, followers_total),
       link_clicks = COALESCE(excluded.link_clicks, link_clicks), messages = COALESCE(excluded.messages, messages),
       raw_json = excluded.raw_json, captured_at = excluded.captured_at`,
  ).run(row);
}

export function listFbPageDaily(pageId: string, fromDay: string, toDay: string): FbPageDailyRow[] {
  return db.prepare(
    `SELECT * FROM fb_page_daily WHERE page_id = ? AND day >= ? AND day <= ? ORDER BY day`,
  ).all(pageId, fromDay, toDay) as FbPageDailyRow[];
}

export interface FbInsightRow {
  id: number;
  page_id: string;
  kind: string;
  subject_id: string;
  period_days: number;
  body_json: string;
  model: string;
  created_at: number;
}

export function insertFbInsight(input: {
  pageId: string; kind: 'channel' | 'post'; subjectId?: string; periodDays: number; body: unknown; model: string;
}): number {
  const info = db.prepare(
    `INSERT INTO fb_insights (page_id, kind, subject_id, period_days, body_json, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.pageId, input.kind, input.subjectId ?? '', input.periodDays, JSON.stringify(input.body), input.model, nowSec());
  return Number(info.lastInsertRowid);
}

export function getLatestFbInsight(pageId: string, kind: 'channel' | 'post', subjectId = ''): FbInsightRow | undefined {
  return db.prepare(
    `SELECT * FROM fb_insights WHERE page_id = ? AND kind = ? AND subject_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(pageId, kind, subjectId) as FbInsightRow | undefined;
}

/**
 * Comment counts for the "answered by AI" rate: comments from other people
 * that needed an answer (not skipped, not hidden spam) and how many were sent.
 */
export function countFbCommentsAnswered(pageId: string, sinceSec: number): { needed: number; answered: number } {
  const row = db.prepare(
    `SELECT COUNT(*) AS needed, COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS answered
     FROM fb_comments
     WHERE page_id = ? AND from_page = 0 AND created_time >= ? AND status NOT IN ('skipped', 'hidden')`,
  ).get(pageId, sinceSec) as { needed: number; answered: number };
  return row;
}

/** Comments on one post: total from other people and how many got a sent reply. */
export function countFbPostCommentsAnswered(postId: string): { total: number; answered: number } {
  const row = db.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS answered
     FROM fb_comments WHERE post_id = ? AND from_page = 0`,
  ).get(postId) as { total: number; answered: number };
  return row;
}


/** Published posts since sinceSec with their latest metrics snapshot (feeds provides.topPosts). */
export interface FbAdsOrganicRow {
  post_id: string;
  page_name: string;
  title: string;
  caption: string;
  format: string;
  published_at: number | null;
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
}

/** Published posts since `sinceSec` with their latest metrics snapshot (reads fb_content + fb_post_metrics). */
export function listFbAdsOrganicRows(sinceSec: number): FbAdsOrganicRow[] {
  return db.prepare(
    `SELECT c.fb_post_id AS post_id, COALESCE(p.name, '') AS page_name, c.title, c.caption, c.format,
            c.published_at, m.reach, m.reactions, m.comments, m.shares
     FROM fb_content c
     JOIN fb_post_metrics m ON m.post_id = c.fb_post_id
       AND m.captured_at = (SELECT MAX(captured_at) FROM fb_post_metrics WHERE post_id = c.fb_post_id)
     LEFT JOIN fb_pages p ON p.id = c.page_id
     WHERE c.status = 'published' AND c.fb_post_id IS NOT NULL AND c.published_at >= ?`,
  ).all(sinceSec) as FbAdsOrganicRow[];
}


// ── Overview (Tổng quan) read side ──────────────────────────────────────────

export interface FbOverviewPostRow {
  fb_post_id: string;
  page_id: string;
  page_name: string | null;
  title: string;
  caption: string;
  permalink: string;
  published_at: number;
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  captured_at: number | null;
}

/** Published posts of every Page in [fromSec, toSec) with their 'latest' metric snapshot (null columns when none). */
export function listFbOverviewPosts(fromSec: number, toSec: number): FbOverviewPostRow[] {
  return db.prepare(
    `SELECT c.fb_post_id, c.page_id, p.name AS page_name, c.title, c.caption, c.permalink, c.published_at,
            m.reach, m.reactions, m.comments, m.shares, m.clicks, m.captured_at
     FROM fb_content c
     LEFT JOIN fb_pages p ON p.id = c.page_id
     LEFT JOIN fb_post_metrics m ON m.post_id = c.fb_post_id AND m.milestone = 'latest'
     WHERE c.status = 'published' AND c.fb_post_id IS NOT NULL AND c.page_id IS NOT NULL
       AND c.published_at >= ? AND c.published_at < ?
     ORDER BY c.published_at`,
  ).all(fromSec, toSec) as FbOverviewPostRow[];
}

/** Comments from other people in the window, and how many got a sent AI reply. `synced` = the table has any comment at all. */
export function countFbOverviewComments(fromSec: number, toSec: number): { received: number; replied: number; synced: boolean } {
  const row = db.prepare(
    `SELECT COUNT(*) AS received, COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS replied
     FROM fb_comments WHERE from_page = 0 AND created_time >= ? AND created_time < ?`,
  ).get(fromSec, toSec) as { received: number; replied: number };
  const any = db.prepare(`SELECT 1 AS x FROM fb_comments LIMIT 1`).get() as { x: number } | undefined;
  return { ...row, synced: any !== undefined };
}

export function getFbOverviewLastFetchAt(): number | null {
  const row = db.prepare(`SELECT MAX(captured_at) AS t FROM fb_post_metrics`).get() as { t: number | null };
  return row.t;
}

/** Pages shown as zero-post rows in the overview: the connected ones. */
export function listFbOverviewPages(): { id: string; name: string; enabled: number }[] {
  return db.prepare(`SELECT id, name, enabled FROM fb_pages ORDER BY name`).all() as { id: string; name: string; enabled: number }[];
}
