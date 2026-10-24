/**
 * Scheduled publisher. Every 60 s it claims posts that are due, publishes
 * them through Composio and records the outcome. It never posts late (a post
 * whose first attempt would run after the grace window becomes 'missed') and
 * never re-posts on its own after an interruption (risk of duplicates).
 */

import {
  claimFbContent,
  getFbContent,
  getFbPage,
  getFbSetting,
  insertFbPublishLog,
  listDueFbContent,
  listStuckFbPublishing,
  releaseFbContentClaim,
  setFbPageStatus,
  updateFbContentFields,
  type FbContentRow,
  type FbPageRow,
} from '../store.js';
import { isEnabled, isFbStudioEnabled } from '../settings.js';
import { logger } from '../compat.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  FbBudgetExceeded,
  execute,
  graphAsPage,
  hasComposioKey,
  type FbCallTarget,
} from '../../../_lib/composio.js';
import { notifyOwner } from '../notify.js';
import type { FbContentDto, FbContentStatus, FbFormat, FbMedia } from '../types.js';
import { contentToDto, parseJson } from './dto.js';
import { FbError } from './errors.js';
import { assertMediaReadable } from './media.js';
import { extractPhotoIds, extractPostId } from './response.js';
import {
  PUBLISH_NOW_FROM,
  completenessProblems,
  STUCK_AFTER_SEC,
  STUCK_MESSAGE,
  isPastGrace,
  isTransientMessage,
  nextAfterTransientFailure,
} from './state.js';
import { formatLocalShort } from './time.js';

const TICK_MS = 60_000;
const MAX_PER_TICK = 20;

const nowSec = (): number => Math.floor(Date.now() / 1000);

const studioEnabled = isFbStudioEnabled;

// ── Worker state (read by GET /status) ────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let firstTick: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let lastTickAt: number | null = null;
/** Rows this process is publishing right now; the stuck-row sweep leaves them alone. */
const inFlight = new Set<number>();

export function getPublisherState(): { running: boolean; lastTickAt: number | null } {
  return { running: timer !== null && studioEnabled() && isEnabled('FB_PUBLISH_ENABLED'), lastTickAt };
}

export function startPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void publisherTick(), TICK_MS);
  timer.unref?.();
  firstTick = setTimeout(() => void publisherTick(), 5_000);
  firstTick.unref?.();
}

export function stopPublisher(): void {
  if (timer) clearInterval(timer);
  if (firstTick) clearTimeout(firstTick);
  timer = null;
  firstTick = null;
}

/** Test hook: stops the interval and clears worker state. */
export function _resetPublisher(): void {
  if (timer) clearInterval(timer);
  timer = null;
  ticking = false;
  lastTickAt = null;
  inFlight.clear();
}

// ── Publishing a post ────────────────────────────────────────────────

export interface PublishResult {
  postId: string | null;
  permalink: string;
  publishedAs: string;
  tool: string;
}

function targetOf(page: FbPageRow): FbCallTarget {
  return { area: 'publish', connectionId: page.connection_id, entityId: page.entity_id };
}

export function permalinkFor(pageId: string, postId: string | null, publishedAs: string): string {
  if (!postId) return '';
  const [first, second] = postId.split('_');
  if (second) return `https://www.facebook.com/${first}/posts/${second}`;
  if (publishedAs === 'video') return `https://www.facebook.com/${pageId}/videos/${postId}`;
  return `https://www.facebook.com/${postId}`;
}

export interface PublishCall {
  tool: string;
  args: Record<string, unknown>;
  publishedAs: string;
}

/**
 * The single Composio call for formats that need only one (everything except
 * a multi-photo album). Media is passed as a local path: the SDK uploads
 * file_uploadable params at call time. Always `published: true` — the app
 * publishes at the scheduled minute itself.
 */
export function buildPublishCall(content: { pageId: string; format: FbFormat; caption: string; linkUrl: string; media: FbMedia[] }): PublishCall {
  const { pageId, caption, linkUrl, media } = content;
  const images = media.filter((m) => m.kind === 'image');
  const videos = media.filter((m) => m.kind === 'video');
  switch (content.format) {
    case 'text':
    case 'link': {
      const args: Record<string, unknown> = { page_id: pageId, published: true };
      if (caption.trim()) args.message = caption;
      if (linkUrl.trim()) args.link = linkUrl.trim();
      return { tool: 'FACEBOOK_CREATE_POST', args, publishedAs: content.format };
    }
    case 'photo':
    case 'album': {
      const args: Record<string, unknown> = { page_id: pageId, photo: images[0]?.path, published: true };
      if (caption.trim()) args.message = caption;
      return { tool: 'FACEBOOK_CREATE_PHOTO_POST', args, publishedAs: 'photo' };
    }
    case 'video':
    case 'reel': {
      // Composio has no Reels tool: a vertical video goes out as a normal video.
      const args: Record<string, unknown> = { page_id: pageId, video: videos[0]?.path, published: true };
      if (caption.trim()) args.description = caption;
      return { tool: 'FACEBOOK_CREATE_VIDEO_POST', args, publishedAs: 'video' };
    }
  }
}

/**
 * Multi-photo album post: FACEBOOK_UPLOAD_PHOTOS_BATCH takes local files but
 * has no caption and, published, would create one post per photo. So the
 * photos are uploaded unpublished and a single feed post attaches them.
 * Nothing is public until the second call succeeds.
 */
async function publishAlbum(page: FbPageRow, caption: string, images: FbMedia[]): Promise<PublishResult> {
  const target = targetOf(page);
  const upload = await execute(
    'FACEBOOK_UPLOAD_PHOTOS_BATCH',
    { page_id: page.id, photos: images.map((m) => m.path), published: false },
    target,
  );
  const ids = extractPhotoIds(upload);
  if (ids.length !== images.length) {
    throw new FbError(502, `Tải ảnh lên xong nhưng không đọc được đủ ID ảnh (${ids.length}/${images.length}), album chưa được đăng.`);
  }
  const body: Record<string, unknown> = { attached_media: ids.map((id) => ({ media_fbid: id })), published: true };
  if (caption.trim()) body.message = caption;
  const res = await graphAsPage<Record<string, unknown>>(page.id, { path: `/${page.id}/feed`, method: 'POST', body }, target);
  const postId = extractPostId(res.data);
  return { postId, permalink: permalinkFor(page.id, postId, 'album'), publishedAs: 'album', tool: 'FACEBOOK_UPLOAD_PHOTOS_BATCH+feed' };
}

export async function publishToFacebook(row: FbContentRow, page: FbPageRow, media: FbMedia[]): Promise<PublishResult> {
  const format = row.format as FbFormat;
  const images = media.filter((m) => m.kind === 'image');
  if (format === 'album' && images.length >= 2) return publishAlbum(page, row.caption, images);

  const call = buildPublishCall({ pageId: page.id, format, caption: row.caption, linkUrl: row.link_url, media });
  const data = await execute(call.tool, call.args, targetOf(page));
  const postId = extractPostId(data);
  return { postId, permalink: permalinkFor(page.id, postId, call.publishedAs), publishedAs: call.publishedAs, tool: call.tool };
}

// ── Errors ───────────────────────────────────────────────────────────

/** Short, token-free text safe to store and show. */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/EAA[A-Za-z0-9]{20,}/g, '[token]')
    .replace(/(access_token["'=:\s]+)[^"'&\s,}]+/gi, '$1[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

type Failure =
  | { kind: 'defer'; message: string }
  | { kind: 'retryable'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'fatal'; message: string };

export function classifyFailure(err: unknown): Failure {
  if (err instanceof FbBudgetExceeded) return { kind: 'defer', message: 'Đã hết ngân sách gọi API trong giờ này, sẽ thử lại ở lượt sau.' };
  if (err instanceof ComposioConnectionExpiredError) return { kind: 'expired', message: 'Kết nối Facebook đã hết hạn, hãy kết nối lại trong Cài đặt.' };
  if (err instanceof ComposioAuthError) return { kind: 'fatal', message: 'Khóa Composio thiếu hoặc không hợp lệ.' };
  if (err instanceof ComposioRateLimitError) return { kind: 'retryable', message: `Facebook giới hạn tần suất: ${sanitizeError(err)}` };
  const text = sanitizeError(err);
  if (err instanceof FbError) return { kind: 'fatal', message: text };
  if (isTransientMessage(text)) return { kind: 'retryable', message: `Facebook lỗi tạm thời: ${text}` };
  return { kind: 'fatal', message: text };
}

// ── One attempt ──────────────────────────────────────────────────────

function title(row: FbContentRow): string {
  return row.title.trim() || row.caption.trim().slice(0, 40) || `#${row.id}`;
}

async function expirePage(page: FbPageRow | undefined): Promise<void> {
  if (!page) return;
  if (setFbPageStatus(page.id, 'EXPIRED')) {
    await notifyOwner(`Kết nối Facebook của Fanpage "${page.name}" đã hết hạn. Vào Cài đặt › Content Studio để kết nối lại; các bài đang chờ sẽ không được đăng.`);
  }
}

/**
 * Runs one publish attempt for a row that is already claimed ('publishing',
 * attempts counted). `backTo` is where a claim that never reached Facebook
 * (budget spent) is released to.
 */
export async function runAttempt(id: number, backTo: FbContentStatus = 'scheduled'): Promise<void> {
  const row = getFbContent(id);
  if (!row || row.status !== 'publishing') return;
  const page = row.page_id ? getFbPage(row.page_id) : undefined;
  const started = Date.now();
  let tool = '';
  try {
    if (!page || !page.connection_id) throw new FbError(400, 'Fanpage chưa có kết nối Facebook, hãy đồng bộ Fanpage.');
    const media = parseJson<FbMedia[]>(row.media_json, []);
    const problems = completenessProblems({ pageId: row.page_id, format: row.format as FbFormat, caption: row.caption, linkUrl: row.link_url, media });
    if (problems.length) throw new FbError(400, problems.join(' '));
    assertMediaReadable(media);

    const result = await publishToFacebook(row, page, media);
    tool = result.tool;
    const done = {
      status: 'published',
      published_at: nowSec(),
      fb_post_id: result.postId,
      permalink: result.permalink,
      published_as: result.publishedAs,
      next_attempt_at: null,
      last_error: result.postId ? '' : 'Đã đăng nhưng không đọc được ID bài từ Facebook, kiểm tra trên Fanpage.',
    };
    let saved = false;
    try {
      saved = updateFbContentFields(id, done, ['publishing']);
    } catch (err) {
      // fb_post_id is unique: if analytics imported this very post first, keep the row without the id.
      logger.warn({ err: String(err), id }, 'fbstudio: saving fb_post_id failed, retrying without it');
      saved = updateFbContentFields(id, { ...done, fb_post_id: null }, ['publishing']);
    }
    if (!saved) logger.warn({ id }, 'fbstudio: published post but the row was no longer publishing');
    insertFbPublishLog({ content_id: id, page_id: row.page_id, action: 'publish', tool, ok: true, detail: result.postId ?? '', duration_ms: Date.now() - started });
    logger.info({ id, tool, durationMs: Date.now() - started }, 'fbstudio post published');
  } catch (err) {
    await handleFailure(err, row, page, tool, Date.now() - started, backTo);
  }
}

async function handleFailure(
  err: unknown,
  row: FbContentRow,
  page: FbPageRow | undefined,
  tool: string,
  durationMs: number,
  backTo: FbContentStatus,
): Promise<void> {
  const failure = classifyFailure(err);
  const now = nowSec();
  insertFbPublishLog({ content_id: row.id, page_id: row.page_id, action: 'publish', tool, ok: false, detail: failure.message, duration_ms: durationMs });

  if (failure.kind === 'defer') {
    // Nothing was sent: put the claim back, no attempt counted.
    releaseFbContentClaim(row.id, backTo, backTo === 'scheduled' ? now + 60 : null);
    updateFbContentFields(row.id, { last_error: failure.message, ...(backTo === 'approved' ? { scheduled_at: null } : {}) });
    return;
  }

  if (failure.kind === 'retryable') {
    const next = nextAfterTransientFailure(row.attempts);
    if (next.kind === 'retry') {
      updateFbContentFields(row.id, { status: 'scheduled', next_attempt_at: now + next.delayMin * 60, last_error: failure.message }, ['publishing']);
      logger.warn({ id: row.id, attempts: row.attempts, retryInMin: next.delayMin }, 'fbstudio publish failed, will retry');
      return;
    }
  }

  updateFbContentFields(row.id, { status: 'failed', next_attempt_at: null, last_error: failure.message }, ['publishing']);
  logger.warn({ id: row.id, attempts: row.attempts, kind: failure.kind }, 'fbstudio publish failed');
  if (failure.kind === 'expired') await expirePage(page);
  await notifyOwner(`Bài "${title(row)}"${page ? ` (Fanpage ${page.name})` : ''} đăng thất bại: ${failure.message} Mở Content Studio để kiểm tra và đăng lại.`);
}

// ── The tick ─────────────────────────────────────────────────────────

async function markMissed(row: FbContentRow, page: FbPageRow | undefined, now: number): Promise<void> {
  const late = Math.round((now - (row.scheduled_at ?? now)) / 60);
  const tz = page?.timezone ?? 'Asia/Ho_Chi_Minh';
  const message = `Quá giờ đăng ${late} phút (hạn cho phép ${page?.grace_minutes ?? 30} phút) nên không đăng muộn.`;
  if (!updateFbContentFields(row.id, { status: 'missed', next_attempt_at: null, last_error: message }, ['scheduled'])) return;
  insertFbPublishLog({ content_id: row.id, page_id: row.page_id, action: 'missed', ok: false, detail: message });
  await notifyOwner(`Bài "${title(row)}"${page ? ` (Fanpage ${page.name})` : ''} lỡ giờ đăng ${row.scheduled_at ? formatLocalShort(row.scheduled_at, tz) : ''} và không được đăng muộn. Mở lịch để đặt lại giờ.`);
}

async function recoverStuck(now: number): Promise<void> {
  for (const row of listStuckFbPublishing(now - STUCK_AFTER_SEC)) {
    if (inFlight.has(row.id)) continue;
    if (!updateFbContentFields(row.id, { status: 'failed', next_attempt_at: null, last_error: STUCK_MESSAGE }, ['publishing'])) continue;
    insertFbPublishLog({ content_id: row.id, page_id: row.page_id, action: 'recover', ok: false, detail: STUCK_MESSAGE });
    const page = row.page_id ? getFbPage(row.page_id) : undefined;
    await notifyOwner(`Bài "${title(row)}"${page ? ` (Fanpage ${page.name})` : ''} bị gián đoạn khi đang đăng. Kiểm tra Facebook trước khi đăng lại để tránh đăng trùng.`);
  }
}

async function processDue(row: FbContentRow, now: number): Promise<void> {
  const page = row.page_id ? getFbPage(row.page_id) : undefined;
  const ready = !!page && page.enabled === 1 && page.status === 'ACTIVE';
  const late = row.scheduled_at !== null && isPastGrace(row.scheduled_at, page?.grace_minutes ?? 30, now);
  // Never post late: a first attempt past the grace window is dropped, and so is any post whose Page is off or expired.
  if (late && (row.attempts === 0 || !ready)) {
    await markMissed(row, page, now);
    return;
  }
  // A Page that is off or expired keeps its posts waiting until the grace window ends.
  if (!page || !ready) return;
  if (!claimFbContent(row.id, ['scheduled'], now)) return;
  inFlight.add(row.id);
  try {
    await runAttempt(row.id, 'scheduled');
  } finally {
    inFlight.delete(row.id);
  }
}

/** One pass of the worker. Exported for tests. */
export async function publisherTick(now: number = nowSec()): Promise<void> {
  if (ticking) return;
  if (!studioEnabled() || !isEnabled('FB_PUBLISH_ENABLED')) return;
  ticking = true;
  try {
    lastTickAt = now;
    await recoverStuck(now);
    if (!hasComposioKey()) return;
    for (const row of listDueFbContent(now, MAX_PER_TICK)) {
      if (!studioEnabled() || !isEnabled('FB_PUBLISH_ENABLED')) break;
      await processDue(row, now);
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'fbstudio publisher tick failed');
  } finally {
    ticking = false;
  }
}

// ── Manual actions ───────────────────────────────────────────────────

function requireRow(id: number): FbContentRow {
  const row = Number.isInteger(id) ? getFbContent(id) : undefined;
  if (!row) throw new FbError(404, 'Không tìm thấy bài.');
  return row;
}

function requireReadyPage(row: FbContentRow): FbPageRow {
  const page = row.page_id ? getFbPage(row.page_id) : undefined;
  if (!page) throw new FbError(400, 'Chưa chọn Fanpage.');
  if (page.enabled !== 1) throw new FbError(409, `Fanpage "${page.name}" chưa được bật.`);
  if (page.status !== 'ACTIVE') throw new FbError(409, `Kết nối Facebook của Fanpage "${page.name}" đã hết hạn, hãy đồng bộ lại.`);
  if (!page.connection_id) throw new FbError(409, `Fanpage "${page.name}" chưa có kết nối Facebook.`);
  return page;
}

/**
 * Publishes now: claims the row and returns straight away with status
 * 'publishing'; the upload continues in the background.
 */
export async function publishNow(id: number): Promise<FbContentDto> {
  if (!isEnabled('FB_PUBLISH_ENABLED')) throw new FbError(409, 'Việc đăng bài đang bị tắt (FB_PUBLISH_ENABLED=false trong .env).');
  if (!hasComposioKey()) throw new FbError(503, 'Chưa cấu hình khóa Composio.');
  const row = requireRow(id);
  const status = row.status as FbContentStatus;
  if (!PUBLISH_NOW_FROM.includes(status)) {
    throw new FbError(409, status === 'publishing' ? 'Bài đang được đăng.' : `Không thể đăng ngay bài ở trạng thái "${status}". Hãy duyệt bài trước.`);
  }
  requireReadyPage(row);
  const problems = completenessProblems({
    pageId: row.page_id,
    format: row.format as FbFormat,
    caption: row.caption,
    linkUrl: row.link_url,
    media: parseJson<FbMedia[]>(row.media_json, []),
  });
  if (problems.length) throw new FbError(400, problems.join(' '));
  assertMediaReadable(parseJson<FbMedia[]>(row.media_json, []));

  // A fresh start: previous failed attempts do not count against this one.
  if (!updateFbContentFields(id, { attempts: 0, next_attempt_at: null, last_error: '' }, [status]) || !claimFbContent(id, [status])) {
    throw new FbError(409, 'Trạng thái bài vừa thay đổi, hãy tải lại rồi thử lại.');
  }
  // From here on a retry is due at once, so the schedule moves to now.
  updateFbContentFields(id, { scheduled_at: nowSec() }, ['publishing']);
  inFlight.add(id);
  void runAttempt(id, status)
    .catch((err) => logger.error({ err: String(err), id }, 'fbstudio publish-now failed unexpectedly'))
    .finally(() => inFlight.delete(id));
  return contentToDto(requireRow(id));
}

const ALREADY_GONE = /does not exist|has been deleted|unsupported delete|not found|cannot be loaded/i;

/** Deletes the post on Facebook (as the Page, via graphAsPage) and marks the row 'deleted'. */
export async function deleteRemote(id: number): Promise<FbContentDto> {
  if (!hasComposioKey()) throw new FbError(503, 'Chưa cấu hình khóa Composio.');
  const row = requireRow(id);
  if (row.status !== 'published') throw new FbError(409, 'Chỉ xóa được bài đã đăng trên Facebook.');
  if (!row.fb_post_id) throw new FbError(409, 'Bài này không có ID trên Facebook nên không xóa từ xa được. Hãy xóa trực tiếp trên Fanpage.');
  const page = row.page_id ? getFbPage(row.page_id) : undefined;
  if (!page || !page.connection_id) throw new FbError(409, 'Fanpage chưa có kết nối Facebook.');

  const started = Date.now();
  let detail = row.fb_post_id;
  try {
    // FACEBOOK_DELETE_POST runs with the connection's user token and Facebook
    // refuses it ("(#10) Application does not have permission"); deleting as
    // the Page works (verified live 2026-10-07).
    await graphAsPage(page.id, { method: 'DELETE', path: `/${row.fb_post_id}` }, targetOf(page));
  } catch (err) {
    const text = sanitizeError(err);
    if (err instanceof ComposioConnectionExpiredError) {
      await expirePage(page);
      insertFbPublishLog({ content_id: id, page_id: page.id, action: 'delete_remote', tool: 'graph DELETE /{post-id}', ok: false, detail: text, duration_ms: Date.now() - started });
      throw new FbError(409, 'Kết nối Facebook đã hết hạn, hãy kết nối lại trong Cài đặt.');
    }
    if (!ALREADY_GONE.test(text) || err instanceof ComposioRateLimitError) {
      insertFbPublishLog({ content_id: id, page_id: page.id, action: 'delete_remote', tool: 'graph DELETE /{post-id}', ok: false, detail: text, duration_ms: Date.now() - started });
      if (err instanceof FbBudgetExceeded || err instanceof ComposioRateLimitError) throw new FbError(503, 'Đã chạm giới hạn gọi API, thử lại sau ít phút.');
      throw new FbError(502, `Facebook không xóa được bài: ${text}`);
    }
    detail = `${row.fb_post_id} (đã không còn trên Facebook)`;
  }
  updateFbContentFields(id, { status: 'deleted', next_attempt_at: null }, ['published']);
  insertFbPublishLog({ content_id: id, page_id: page.id, action: 'delete_remote', tool: 'graph DELETE /{post-id}', ok: true, detail, duration_ms: Date.now() - started });
  return contentToDto(requireRow(id));
}
