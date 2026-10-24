/**
 * KOL posts and their targets (kol_posts, kol_post_targets): CRUD, the state
 * machine (rules in schedule-rules.ts), per-account scheduling checks and the
 * status a post derives from its targets.
 *
 * A post holds the master caption, platform variants and media; each target
 * is that post on one account. Targets wait as 'pending' until the post is
 * scheduled; the publisher (publisher.ts) moves them on from 'scheduled'.
 * A target is due at COALESCE(next_attempt_at, post.scheduled_at):
 * next_attempt_at overrides the post time for retries and publish-now.
 */

import { randomUUID } from 'crypto';

import { z } from 'zod';

import { fbBridge, getFbPage } from './fb-bridge.js';
import { isEnabled } from './compat.js';
import {
  accountLabel,
  getAccountRow,
  listAccountRows,
  sameChannelAccountIds,
  type AccountRow,
} from './accounts.js';
import { listAssetsByIds } from './assets.js';
import { normalizeHashtags } from './captions.js';
import { KolError, kolDb, loadSettings, nowSec, parseJson } from './core.js';
import { getPersona, requirePersona } from './personas.js';
import {
  PLATFORMS,
  POST_FORMATS,
  canApprove,
  canCancel,
  canEdit,
  canPublishNow,
  canReturn,
  canSubmit,
  checkSchedule,
  derivePostStatus,
  formatProblems,
  type AccountRules,
  type ScheduleCheckOptions,
} from './schedule-rules.js';
import type {
  AssetDto,
  Platform,
  PlatformVariant,
  PostDto,
  PostFormat,
  PostInput,
  PostMetricsDto,
  PostSource,
  PostStatus,
  PostTargetDto,
  TargetStatus,
} from './types.js';

// ── Rows ─────────────────────────────────────────────────────────────

export interface PostRow {
  id: string;
  persona_id: string;
  title: string;
  pillar: string;
  format: string;
  caption: string;
  hashtags_json: string;
  variants_json: string;
  asset_ids_json: string;
  status: string;
  scheduled_at: number | null;
  published_at: number | null;
  brief: string;
  source: string;
  source_ref: string;
  feedback: string;
  created_at: number;
  updated_at: number;
}

export interface TargetRow {
  id: string;
  post_id: string;
  account_id: string;
  platform: string;
  status: string;
  external_id: string | null;
  permalink: string;
  fb_content_id: number | null;
  publish_ref: string | null;
  error: string;
  attempts: number;
  next_attempt_at: number | null;
  published_at: number | null;
  updated_at: number;
}

interface MetricsRow {
  id: number;
  target_id: string;
  captured_at: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
}

export function getPostRow(id: string): PostRow | null {
  return (kolDb().prepare('SELECT * FROM kol_posts WHERE id = ?').get(id) as PostRow | undefined) ?? null;
}

export function requirePostRow(id: string): PostRow {
  const row = getPostRow(id);
  if (!row) throw new KolError(404, 'Không tìm thấy bài.');
  return row;
}

export function listTargetRows(postId: string): TargetRow[] {
  return kolDb().prepare('SELECT * FROM kol_post_targets WHERE post_id = ? ORDER BY platform, id').all(postId) as TargetRow[];
}

export function getTargetRow(id: string): TargetRow | null {
  return (kolDb().prepare('SELECT * FROM kol_post_targets WHERE id = ?').get(id) as TargetRow | undefined) ?? null;
}

export const postAssetIds = (row: Pick<PostRow, 'asset_ids_json'>): string[] => parseJson<string[]>(row.asset_ids_json, []).filter((x) => typeof x === 'string');
export const postVariants = (row: Pick<PostRow, 'variants_json'>): Partial<Record<Platform, PlatformVariant>> =>
  parseJson<Partial<Record<Platform, PlatformVariant>>>(row.variants_json, {});
export const postHashtags = (row: Pick<PostRow, 'hashtags_json'>): string[] => parseJson<string[]>(row.hashtags_json, []).filter((x) => typeof x === 'string');

/** When a scheduled target is due. */
export function dueAtOf(target: Pick<TargetRow, 'next_attempt_at'>, post: Pick<PostRow, 'scheduled_at'>): number | null {
  return target.next_attempt_at ?? post.scheduled_at;
}

// ── DTOs ─────────────────────────────────────────────────────────────

/** Latest metrics snapshot per target. */
export function latestTargetMetrics(targetIds: string[]): Map<string, PostMetricsDto> {
  const out = new Map<string, PostMetricsDto>();
  if (!targetIds.length) return out;
  const db = kolDb();
  for (let i = 0; i < targetIds.length; i += 400) {
    const chunk = targetIds.slice(i, i + 400);
    const rows = db.prepare(
      `SELECT m.* FROM kol_metrics m
       JOIN (SELECT target_id, MAX(captured_at) AS c FROM kol_metrics WHERE target_id IN (${chunk.map(() => '?').join(',')}) GROUP BY target_id) x
         ON x.target_id = m.target_id AND x.c = m.captured_at
       ORDER BY m.id`,
    ).all(...chunk) as MetricsRow[];
    for (const m of rows) {
      out.set(m.target_id, { capturedAt: m.captured_at, views: m.views, likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves, reach: m.reach });
    }
  }
  return out;
}

export function targetToDto(t: TargetRow, account: AccountRow | null, metrics: PostMetricsDto | null): PostTargetDto {
  return {
    id: t.id,
    accountId: t.account_id,
    platform: t.platform as Platform,
    handle: account ? (account.handle || account.display_name) : '',
    status: t.status as TargetStatus,
    externalId: t.external_id,
    permalink: t.permalink,
    error: t.error,
    attempts: t.attempts,
    publishedAt: t.published_at,
    metrics,
  };
}

function rowsToDtos(rows: PostRow[]): PostDto[] {
  if (!rows.length) return [];
  const db = kolDb();
  const ids = rows.map((r) => r.id);
  const targets: TargetRow[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    targets.push(...(db.prepare(`SELECT * FROM kol_post_targets WHERE post_id IN (${chunk.map(() => '?').join(',')}) ORDER BY platform, id`).all(...chunk) as TargetRow[]));
  }
  const accounts = new Map<string, AccountRow>();
  for (const personaId of new Set(rows.map((r) => r.persona_id))) for (const a of listAccountRows(personaId)) accounts.set(a.id, a);
  const metrics = latestTargetMetrics(targets.map((t) => t.id));
  const allAssetIds = [...new Set(rows.flatMap((r) => postAssetIds(r)))];
  const assets = new Map<string, AssetDto>(allAssetIds.length ? listAssetsByIds(allAssetIds).map((a) => [a.id, a]) : []);
  const byPost = new Map<string, TargetRow[]>();
  for (const t of targets) byPost.set(t.post_id, [...(byPost.get(t.post_id) ?? []), t]);

  return rows.map((r) => {
    const assetIds = postAssetIds(r);
    return {
      id: r.id,
      personaId: r.persona_id,
      title: r.title,
      pillar: r.pillar,
      format: r.format as PostFormat,
      caption: r.caption,
      hashtags: postHashtags(r),
      variants: postVariants(r),
      assetIds,
      assets: assetIds.map((id) => assets.get(id)).filter((a): a is AssetDto => !!a),
      status: r.status as PostStatus,
      scheduledAt: r.scheduled_at,
      publishedAt: r.published_at,
      brief: r.brief,
      source: r.source as PostSource,
      sourceRef: r.source_ref,
      feedback: r.feedback,
      targets: (byPost.get(r.id) ?? []).map((t) => targetToDto(t, accounts.get(t.account_id) ?? null, metrics.get(t.id) ?? null)),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export function getPost(id: string): PostDto | null {
  const row = getPostRow(id);
  return row ? rowsToDtos([row])[0] : null;
}

export function requirePost(id: string): PostDto {
  return rowsToDtos([requirePostRow(id)])[0];
}

export interface PostFilter {
  personaId?: string;
  /** One status or a comma-separated list. */
  status?: string;
  from?: number;
  to?: number;
  source?: PostSource;
  limit?: number;
}

const POST_STATUSES: PostStatus[] = ['idea', 'draft', 'review', 'approved', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled'];

export function listPosts(f: PostFilter = {}): PostDto[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.personaId) { where.push('persona_id = ?'); params.push(f.personaId); }
  if (f.status) {
    const list = f.status.split(',').map((s) => s.trim()).filter((s): s is PostStatus => (POST_STATUSES as string[]).includes(s));
    if (!list.length) return [];
    where.push(`status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (f.source) { where.push('source = ?'); params.push(f.source); }
  const when = 'COALESCE(scheduled_at, published_at, created_at)';
  if (f.from !== undefined) { where.push(`${when} >= ?`); params.push(f.from); }
  if (f.to !== undefined) { where.push(`${when} < ?`); params.push(f.to); }
  const limit = Math.min(Math.max(1, f.limit ?? 500), 1000);
  const rows = kolDb().prepare(
    `SELECT * FROM kol_posts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${when} DESC LIMIT ${limit}`,
  ).all(...params) as PostRow[];
  return rowsToDtos(rows);
}

// ── Input validation ─────────────────────────────────────────────────

const variantSchema = z.object({
  caption: z.string().max(5000, 'Chú thích tối đa 5.000 ký tự.').default(''),
  title: z.string().max(100, 'Tiêu đề YouTube tối đa 100 ký tự.').optional(),
  hashtags: z.array(z.string().max(100)).max(30, 'Tối đa 30 hashtag.').optional(),
});

export const postInputSchema = z.object({
  title: z.string().max(200, 'Tiêu đề tối đa 200 ký tự.').optional(),
  pillar: z.string().max(100, 'Trụ cột nội dung tối đa 100 ký tự.').optional(),
  format: z.enum(POST_FORMATS as [PostFormat, ...PostFormat[]], { message: 'Định dạng bài không hợp lệ.' }).optional(),
  caption: z.string().max(5000, 'Chú thích tối đa 5.000 ký tự.').optional(),
  hashtags: z.array(z.string().max(100)).max(30, 'Tối đa 30 hashtag.').optional(),
  variants: z.partialRecord(z.enum(PLATFORMS as [Platform, ...Platform[]]), variantSchema).optional(),
  assetIds: z.array(z.string().min(1).max(100)).max(20, 'Tối đa 20 tệp mỗi bài.').optional(),
  brief: z.string().max(4000, 'Yêu cầu tối đa 4.000 ký tự.').optional(),
  scheduledAt: z.number().int().positive().nullable().optional(),
  accountIds: z.array(z.string().min(1).max(100)).max(20).optional(),
});

function normalizeVariants(v: PostInput['variants']): Partial<Record<Platform, PlatformVariant>> {
  const out: Partial<Record<Platform, PlatformVariant>> = {};
  for (const p of PLATFORMS) {
    const x = v?.[p];
    if (!x) continue;
    const item: PlatformVariant = { caption: String(x.caption ?? '').trim() };
    if (x.title !== undefined && String(x.title).trim()) item.title = String(x.title).trim().slice(0, 100);
    if (x.hashtags !== undefined) item.hashtags = normalizeHashtags(x.hashtags);
    out[p] = item;
  }
  return out;
}

function checkAssets(personaId: string, ids: string[]): AssetDto[] {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = listAssetsByIds(unique);
  const byId = new Map(found.map((a) => [a.id, a]));
  for (const id of unique) {
    const a = byId.get(id);
    if (!a) throw new KolError(400, 'Có ảnh/video không tồn tại, hãy chọn lại.');
    if (a.personaId !== personaId) throw new KolError(400, 'Chỉ dùng được ảnh/video của chính KOL này.');
  }
  return unique.map((id) => byId.get(id)!);
}

function checkAccounts(personaId: string, ids: string[]): AccountRow[] {
  const unique = [...new Set(ids)];
  return unique.map((id) => {
    const a = getAccountRow(id);
    if (!a || a.persona_id !== personaId) throw new KolError(400, 'Có tài khoản đăng không thuộc KOL này.');
    return a;
  });
}

function inferFormat(assets: AssetDto[]): PostFormat {
  if (assets.some((a) => a.kind === 'video')) return 'reel';
  const images = assets.filter((a) => a.kind === 'image').length;
  if (images >= 2) return 'carousel';
  return 'photo';
}

// ── Create / update / cancel ─────────────────────────────────────────

export interface CreateOptions {
  source?: PostSource;
  sourceRef?: string;
  status?: Extract<PostStatus, 'idea' | 'draft'>;
}

export function createPost(personaId: string, input: PostInput, opts: CreateOptions = {}): PostDto {
  requirePersona(personaId);
  const assets = checkAssets(personaId, input.assetIds ?? []);
  const accounts = checkAccounts(personaId, input.accountIds ?? []);
  const id = randomUUID();
  const now = nowSec();
  const db = kolDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO kol_posts (id, persona_id, title, pillar, format, caption, hashtags_json, variants_json, asset_ids_json, status,
         scheduled_at, brief, source, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, personaId, (input.title ?? '').trim(), (input.pillar ?? '').trim(), input.format ?? inferFormat(assets), (input.caption ?? '').trim(),
      JSON.stringify(normalizeHashtags(input.hashtags ?? [])), JSON.stringify(normalizeVariants(input.variants)),
      JSON.stringify(assets.map((a) => a.id)), opts.status ?? 'draft', input.scheduledAt ?? null, (input.brief ?? '').trim(),
      opts.source ?? 'owner', opts.sourceRef ?? '', now, now,
    );
    const ins = db.prepare(`INSERT INTO kol_post_targets (id, post_id, account_id, platform, status, updated_at) VALUES (?, ?, ?, ?, 'pending', ?)`);
    for (const a of accounts) ins.run(randomUUID(), id, a.id, a.platform, now);
  })();
  return requirePost(id);
}

/** Applies a PATCH. Only before 'publishing'; a scheduled post is re-checked against every rule. */
export function updatePost(id: string, input: PostInput, now = nowSec()): PostDto {
  const row = requirePostRow(id);
  const status = row.status as PostStatus;
  if (!canEdit(status)) {
    throw new KolError(409, status === 'publishing' ? 'Bài đang được đăng, không sửa được.' : 'Bài đã đăng hoặc đã hủy, không sửa được nữa.');
  }
  const next: PostRow = { ...row };
  if (input.title !== undefined) next.title = input.title.trim();
  if (input.pillar !== undefined) next.pillar = input.pillar.trim();
  if (input.format !== undefined) next.format = input.format;
  if (input.caption !== undefined) next.caption = input.caption.trim();
  if (input.hashtags !== undefined) next.hashtags_json = JSON.stringify(normalizeHashtags(input.hashtags));
  if (input.variants !== undefined) next.variants_json = JSON.stringify(normalizeVariants(input.variants));
  if (input.assetIds !== undefined) next.asset_ids_json = JSON.stringify(checkAssets(row.persona_id, input.assetIds).map((a) => a.id));
  if (input.brief !== undefined) next.brief = input.brief.trim();
  if (input.scheduledAt !== undefined) next.scheduled_at = input.scheduledAt;

  const current = listTargetRows(id);
  let keep = current;
  let add: AccountRow[] = [];
  if (input.accountIds !== undefined) {
    const wanted = checkAccounts(row.persona_id, input.accountIds);
    const wantedIds = new Set(wanted.map((a) => a.id));
    keep = current.filter((t) => wantedIds.has(t.account_id) || t.status === 'published');
    const have = new Set(current.map((t) => t.account_id));
    add = wanted.filter((a) => !have.has(a.id));
  }

  if (status === 'scheduled') {
    if (!next.scheduled_at) throw new KolError(400, 'Bài đã lên lịch cần có giờ đăng. Muốn bỏ lịch, hãy trả bài về nháp.');
    const candidates: TargetRow[] = [
      ...keep.filter((t) => t.status !== 'published' && t.status !== 'skipped'),
      ...add.map((a) => ({ account_id: a.id, platform: a.platform } as TargetRow)),
    ];
    assertSchedulable(next, candidates, next.scheduled_at, now);
  }

  const db = kolDb();
  const removed = current.filter((t) => !keep.includes(t));
  db.transaction(() => {
    db.prepare(
      `UPDATE kol_posts SET title = ?, pillar = ?, format = ?, caption = ?, hashtags_json = ?, variants_json = ?, asset_ids_json = ?,
         brief = ?, scheduled_at = ?, updated_at = ? WHERE id = ?`,
    ).run(next.title, next.pillar, next.format, next.caption, next.hashtags_json, next.variants_json, next.asset_ids_json, next.brief, next.scheduled_at, now, id);
    for (const t of removed) db.prepare('DELETE FROM kol_post_targets WHERE id = ?').run(t.id);
    const ins = db.prepare(`INSERT INTO kol_post_targets (id, post_id, account_id, platform, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const a of add) ins.run(randomUUID(), id, a.id, a.platform, status === 'scheduled' ? 'scheduled' : 'pending', now);
  })();
  recomputePostStatus(id);
  return requirePost(id);
}

/**
 * DELETE: the post becomes 'cancelled'; waiting targets are skipped. Nothing
 * is removed from the platforms. A Facebook hand-off that Content Studio has
 * not started yet is withdrawn; anything else in flight blocks the cancel.
 */
export function cancelPost(id: string): void {
  const row = requirePostRow(id);
  if (row.status === 'cancelled') return;
  if (!canCancel(row.status as PostStatus)) throw new KolError(409, 'Bài đang được đăng, chờ xong rồi hủy.');
  const targets = listTargetRows(id);
  const busy = targets.filter((t) => t.status === 'publishing' || t.status === 'processing');
  for (const t of busy) {
    if (t.platform === 'facebook' && t.status === 'processing' && t.fb_content_id && withdrawFbContent(t.fb_content_id)) continue;
    throw new KolError(409, 'Bài đang được đăng, chờ xong rồi hủy.');
  }
  const db = kolDb();
  const now = nowSec();
  db.transaction(() => {
    db.prepare(
      `UPDATE kol_post_targets SET status = 'skipped', next_attempt_at = NULL, error = '', updated_at = ?
       WHERE post_id = ? AND (status IN ('pending','scheduled') OR (status = 'processing' AND platform = 'facebook'))`,
    ).run(now, id);
    db.prepare(`UPDATE kol_posts SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, id);
  })();
}

// ── Status changes ───────────────────────────────────────────────────

function setPostStatus(id: string, status: PostStatus, extra: Record<string, unknown> = {}): void {
  const keys = Object.keys(extra);
  kolDb()
    .prepare(`UPDATE kol_posts SET status = ?, ${keys.map((k) => `${k} = ?, `).join('')}updated_at = ? WHERE id = ?`)
    .run(status, ...keys.map((k) => extra[k]), nowSec(), id);
}

/** Moves every target that has not been published (or skipped) back to 'pending'. */
function resetTargetsToPending(postId: string): void {
  kolDb().prepare(
    `UPDATE kol_post_targets SET status = 'pending', next_attempt_at = NULL, publish_ref = NULL, fb_content_id = NULL, attempts = 0, error = '', updated_at = ?
     WHERE post_id = ? AND status IN ('pending','scheduled','failed','missed')`,
  ).run(nowSec(), postId);
}

export function submitPost(id: string): PostDto {
  const row = requirePostRow(id);
  if (row.status === 'review') return requirePost(id);
  if (!canSubmit(row.status as PostStatus)) throw new KolError(409, `Không gửi duyệt được bài ở trạng thái "${row.status}".`);
  if (!row.caption.trim() && !row.title.trim() && postAssetIds(row).length === 0) throw new KolError(400, 'Bài chưa có nội dung để duyệt.');
  setPostStatus(id, 'review');
  return requirePost(id);
}

export function returnPost(id: string, feedback: string): PostDto {
  const row = requirePostRow(id);
  if (!canReturn(row.status as PostStatus)) throw new KolError(409, `Không trả về nháp được bài ở trạng thái "${row.status}".`);
  const text = feedback.trim();
  if (!text) throw new KolError(400, 'Hãy ghi nhận xét để KOL/agent biết cần sửa gì.');
  const db = kolDb();
  db.transaction(() => {
    resetTargetsToPending(id);
    setPostStatus(id, 'draft', { feedback: text.slice(0, 2000) });
  })();
  return requirePost(id);
}

/** approve: → scheduled when a time is given (or a future time is kept), else → approved. */
export function approvePost(id: string, scheduledAt?: number | null, now = nowSec()): PostDto {
  const row = requirePostRow(id);
  if (!canApprove(row.status as PostStatus)) throw new KolError(409, `Không duyệt được bài ở trạng thái "${row.status}".`);
  const at = scheduledAt ?? (row.scheduled_at && row.scheduled_at > now ? row.scheduled_at : null);
  if (at) {
    scheduleTargets(row, at, now, {});
  } else {
    const db = kolDb();
    db.transaction(() => {
      resetTargetsToPending(id);
      setPostStatus(id, 'approved', { feedback: '' });
    })();
  }
  return requirePost(id);
}

/** Gates every path that makes something publish right away. */
export function assertPublishingOn(): void {
  if (!isEnabled('KOL_PUBLISH_ENABLED')) throw new KolError(409, 'Việc đăng bài KOL đang bị tắt (công tắc "Cho phép đăng bài của KOL" của module KOL Studio đang tắt).');
  const s = loadSettings();
  if (!s.enabled) throw new KolError(409, 'KOL Studio đang tắt. Bật lại trong KOL Studio › Cài đặt.');
  if (!s.publishEnabled) throw new KolError(409, 'Chưa bật đăng bài. Vào KOL Studio › Cài đặt và bật "Cho phép đăng bài".');
}

/** publish-now: due immediately; the posting window and the gap do not apply, format and daily cap still do. */
export function publishNowPost(id: string, now = nowSec()): PostDto {
  assertPublishingOn();
  const row = requirePostRow(id);
  if (!canPublishNow(row.status as PostStatus)) {
    throw new KolError(409, row.status === 'publishing' ? 'Bài đang được đăng.' : `Không đăng ngay được bài ở trạng thái "${row.status}". Hãy duyệt bài trước.`);
  }
  scheduleTargets(row, now, now, { publishNow: true });
  return requirePost(id);
}

/** A failed or missed target is scheduled again, due now. Never used automatically. */
export function retryTarget(postId: string, targetId: string, now = nowSec()): PostDto {
  assertPublishingOn();
  const row = requirePostRow(postId);
  const t = getTargetRow(targetId);
  if (!t || t.post_id !== postId) throw new KolError(404, 'Không tìm thấy kênh đăng của bài.');
  if (t.status !== 'failed' && t.status !== 'missed') throw new KolError(409, 'Chỉ thử lại được kênh đăng thất bại hoặc lỡ giờ.');
  if (row.status === 'cancelled') throw new KolError(409, 'Bài đã hủy.');
  assertTargetsReady(row, [t]);
  kolDb().prepare(
    `UPDATE kol_post_targets SET status = 'scheduled', next_attempt_at = ?, attempts = 0, error = '', publish_ref = NULL, fb_content_id = NULL,
       external_id = NULL, permalink = '', updated_at = ? WHERE id = ? AND status IN ('failed','missed')`,
  ).run(now, now, targetId);
  recomputePostStatus(postId);
  return requirePost(postId);
}

// ── Scheduling ───────────────────────────────────────────────────────

export function rulesOf(a: AccountRow): AccountRules {
  return {
    label: accountLabel(a),
    timezone: a.timezone,
    maxPostsPerDay: a.max_posts_per_day,
    minGapMinutes: a.min_gap_minutes,
    windowStart: a.window_start,
    windowEnd: a.window_end,
  };
}

/** Times of the channel's other scheduled / in-flight / published targets within [from, to], across every KOL sharing it. */
export function otherTimesForAccount(accountId: string, excludePostId: string, from: number, to: number): number[] {
  const ids = sameChannelAccountIds(accountId);
  const rows = kolDb().prepare(
    `SELECT COALESCE(t.published_at, t.next_attempt_at, p.scheduled_at) AS at
     FROM kol_post_targets t JOIN kol_posts p ON p.id = t.post_id
     WHERE t.account_id IN (${ids.map(() => '?').join(',')}) AND t.post_id <> ? AND t.status IN ('scheduled','publishing','processing','published')
       AND COALESCE(t.published_at, t.next_attempt_at, p.scheduled_at) BETWEEN ? AND ?`,
  ).all(...ids, excludePostId, from, to) as { at: number | null }[];
  return rows.map((r) => r.at).filter((x): x is number => typeof x === 'number');
}

const DAY = 86_400;

/** Persona disclosure, approved media, ready accounts and per-platform format checks. Throws KolError. */
function assertTargetsReady(row: PostRow, targets: Pick<TargetRow, 'account_id' | 'platform'>[]): { account: AccountRow }[] {
  const persona = getPersona(row.persona_id);
  if (!persona) throw new KolError(404, 'Không tìm thấy KOL của bài này.');
  if (!persona.disclosureText.trim()) {
    throw new KolError(409, 'KOL chưa có dòng công bố nội dung AI (disclosure). Thêm ở tab Hồ sơ trước khi đăng.');
  }
  const ids = postAssetIds(row);
  const assets = ids.length ? listAssetsByIds(ids) : [];
  if (assets.length !== new Set(ids).size) throw new KolError(400, 'Có ảnh/video trong bài không còn tồn tại, hãy chọn lại.');
  const unapproved = assets.filter((a) => a.status !== 'approved').length;
  if (unapproved) throw new KolError(409, `Chỉ đăng được ảnh/video đã duyệt. Hãy duyệt ${unapproved} tệp trong Thư viện ảnh trước.`);
  if (!targets.length) throw new KolError(400, 'Chọn ít nhất một tài khoản để đăng.');

  return targets.map((t) => {
    const account = getAccountRow(t.account_id);
    if (!account) throw new KolError(409, 'Một tài khoản đăng của bài đã bị gỡ. Hãy chọn lại tài khoản.');
    const label = accountLabel(account);
    if (account.enabled !== 1) throw new KolError(409, `Tài khoản ${label} đang tắt. Bật lại ở tab Kênh hoặc bỏ tài khoản khỏi bài.`);
    if (account.status === 'EXPIRED') throw new KolError(409, `Kết nối ${label} đã hết hạn. Hãy kết nối lại ở tab Kênh.`);
    if (account.status !== 'ACTIVE') throw new KolError(409, `Tài khoản ${label} đang lỗi. Bấm Làm mới ở tab Kênh để kiểm tra.`);
    if (account.platform === 'facebook') {
      const page = getFbPage(account.external_id);
      if (!page || !page.enabled) throw new KolError(409, `Fanpage ${label} chưa được bật trong Marketing › Pages.`);
      if (page.status !== 'ACTIVE') throw new KolError(409, `Kết nối Facebook của Fanpage ${label} đã hết hạn. Đồng bộ lại ở Marketing › Pages.`);
    }
    const problems = formatProblems(account.platform as Platform, row.format as PostFormat, assets, row.caption);
    if (problems.length) throw new KolError(400, problems.join(' '));
    return { account };
  });
}

/** Full schedule check for a (possibly unsaved) post state. Throws KolError(400/409) with a Vietnamese reason. */
export function assertSchedulable(row: PostRow, targets: Pick<TargetRow, 'account_id' | 'platform'>[], at: number, now: number, opts: ScheduleCheckOptions = {}): void {
  for (const { account } of assertTargetsReady(row, targets)) {
    const others = otherTimesForAccount(account.id, row.id, at - 2 * DAY, at + 2 * DAY);
    const verdict = checkSchedule(rulesOf(account), at, now, others, opts);
    if (!verdict.ok) throw new KolError(409, verdict.reason);
  }
}

/** Schedules every unpublished target of the post at `at` (publish-now: due now). */
function scheduleTargets(row: PostRow, at: number, now: number, opts: ScheduleCheckOptions): void {
  const targets = listTargetRows(row.id).filter((t) => t.status !== 'published' && t.status !== 'skipped');
  if (targets.some((t) => t.status === 'publishing' || t.status === 'processing')) throw new KolError(409, 'Bài đang được đăng.');
  assertSchedulable(row, targets, at, now, opts);
  const db = kolDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE kol_post_targets SET status = 'scheduled', next_attempt_at = ?, attempts = 0, error = '', publish_ref = NULL, fb_content_id = NULL,
         external_id = NULL, permalink = '', updated_at = ?
       WHERE post_id = ? AND status IN ('pending','scheduled','failed','missed')`,
    ).run(opts.publishNow ? now : null, now, row.id);
    setPostStatus(row.id, 'scheduled', { scheduled_at: at, feedback: '' });
  })();
  recomputePostStatus(row.id);
}

// ── Derived status ───────────────────────────────────────────────────

/** Recomputes the post status from its targets (and published_at). Returns the change. */
export function recomputePostStatus(postId: string): { before: PostStatus; after: PostStatus } {
  const row = getPostRow(postId);
  if (!row) return { before: 'cancelled', after: 'cancelled' };
  const targets = listTargetRows(postId);
  const before = row.status as PostStatus;
  const after = derivePostStatus(before, targets.map((t) => t.status as TargetStatus));
  const times = targets.filter((t) => t.status === 'published' && t.published_at).map((t) => t.published_at as number);
  const publishedAt = times.length ? Math.min(...times) : row.published_at;
  if (after !== before || publishedAt !== row.published_at) {
    kolDb().prepare('UPDATE kol_posts SET status = ?, published_at = ?, updated_at = ? WHERE id = ?').run(after, publishedAt, nowSec(), postId);
  }
  return { before, after };
}

// ── Used by captions / autopilot ─────────────────────────────────────

export function setPostVariants(postId: string, variants: Partial<Record<Platform, PlatformVariant>>): PostDto {
  const row = requirePostRow(postId);
  if (!canEdit(row.status as PostStatus)) throw new KolError(409, 'Bài đã đăng hoặc đang đăng, không sửa chú thích được.');
  const merged = { ...postVariants(row), ...normalizeVariants(variants) };
  kolDb().prepare('UPDATE kol_posts SET variants_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), nowSec(), postId);
  return requirePost(postId);
}

export function setPostAssets(postId: string, assetIds: string[]): void {
  const row = requirePostRow(postId);
  const ids = checkAssets(row.persona_id, assetIds).map((a) => a.id);
  kolDb().prepare('UPDATE kol_posts SET asset_ids_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(ids), nowSec(), postId);
}

export function setPostFeedback(postId: string, feedback: string): void {
  kolDb().prepare('UPDATE kol_posts SET feedback = ?, updated_at = ? WHERE id = ?').run(feedback.slice(0, 2000), nowSec(), postId);
}

/**
 * Withdraws a Marketing row that a target handed off and that has not
 * started publishing. False when Marketing already claimed or finished it.
 */
export function withdrawFbContent(fbContentId: number): boolean {
  const bridge = fbBridge();
  return bridge ? bridge.withdrawContent(fbContentId) : true;
}
