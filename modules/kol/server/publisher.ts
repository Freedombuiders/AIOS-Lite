/**
 * KOL publisher. Every 60 s (when settings.enabled, settings.publishEnabled
 * and KOL_PUBLISH_ENABLED allow it) it claims due targets atomically, stages
 * their media, hands them to the platform adapter and records the outcome;
 * targets still processing on the platform are followed up on each tick.
 *
 * Never posts late: a first attempt more than 30 minutes after the due time
 * becomes 'missed'. Rate limits and plain 5xx errors are retried with backoff
 * (3 attempts in total). An outcome that may already be public (timeouts
 * after the upload started, interrupted runs) fails with UNCERTAIN_MESSAGE
 * and is never retried automatically.
 */

import { formatLocalShort } from './time.js';
import { isEnabled } from './compat.js';
import { logger } from './compat.js';
import {
  DEFAULT_TIMEZONE,
  accountLabel,
  getAccountRow,
  isAccountReady,
  markAccountExpired,
  notifyOwner,
  type AccountRow,
} from './accounts.js';
import { buildCaption } from './captions.js';
import {
  ComposioAuthError,
  ComposioConnectionExpiredError,
  ComposioRateLimitError,
  UncertainOutcomeError,
  hasComposioKey,
} from './composio-exec.js';
import { KolError, kolDb, loadSettings, nowSec } from './core.js';
import { getPersona } from './personas.js';
import { ADAPTERS, parseRef, serializeRef, type PublishOutcome, type PublishRef } from './platforms/index.js';
import {
  dueAtOf,
  getPostRow,
  getTargetRow,
  recomputePostStatus,
  requirePost,
  type PostRow,
  type TargetRow,
} from './posts.js';
import {
  GRACE_SEC,
  PLATFORM_LABEL,
  PROCESSING_TIMEOUT_SEC,
  STUCK_AFTER_SEC,
  UNCERTAIN_MESSAGE,
  formatProblems,
  isPastGrace,
  isTransientMessage,
  isUncertainMessage,
  nextAfterTransientFailure,
} from './schedule-rules.js';
import { cleanupStage, stageMedia } from './stage.js';
import type { Platform, PostFormat, PostStatus } from './types.js';

const TICK_MS = 60_000;
const MAX_DUE_PER_TICK = 20;
const MAX_POLLS_PER_TICK = 50;

/** Master switch + publish switch + kill switch. */
export function publishingAllowed(): boolean {
  const s = loadSettings();
  return s.enabled && s.publishEnabled && isEnabled('KOL_PUBLISH_ENABLED');
}

// ── Worker state ─────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let rerun = false;
let lastTickAt: number | null = null;
/** Targets this process is working on right now; the stuck sweep leaves them alone. */
const inFlight = new Set<string>();

export function getPublisherState(): { running: boolean; lastTickAt: number | null } {
  return { running: timer !== null && publishingAllowed(), lastTickAt };
}

export function startPublisher(): void {
  if (timer) return;
  timer = setInterval(() => void publisherTick(), TICK_MS);
  timer.unref?.();
  const first = setTimeout(() => void publisherTick(), 5_000);
  first.unref?.();
}

export function stopPublisher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Runs a tick now (publish-now, retry); when one is running, another follows right after it. */
export function kickPublisher(): void {
  void publisherTick().catch((err) => logger.error({ err: String(err) }, 'kol publisher kick failed'));
}

/** Test hook. */
export function _resetPublisher(): void {
  stopPublisher();
  ticking = false;
  rerun = false;
  lastTickAt = null;
  inFlight.clear();
}

// ── Small helpers ────────────────────────────────────────────────────

/** Short, token-free text safe to store and show. */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/EAA[A-Za-z0-9]{20,}/g, '[token]')
    .replace(/(access_token["'=:\s]+)[^"'&\s,}]+/gi, '$1[token]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function postTitle(post: Pick<PostRow, 'title' | 'caption' | 'id'>): string {
  const t = post.title.trim() || post.caption.trim().split('\n')[0].slice(0, 50);
  return t || `#${post.id.slice(0, 8)}`;
}

function personaName(personaId: string): string {
  return getPersona(personaId)?.name ?? 'KOL';
}

function labelOf(account: AccountRow | null, platform: string): string {
  return account ? accountLabel(account) : PLATFORM_LABEL[platform as Platform] ?? platform;
}

const db = () => kolDb();

function claimScheduled(id: string, now: number): boolean {
  return db().prepare(`UPDATE kol_post_targets SET status = 'publishing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'scheduled'`)
    .run(now, id).changes === 1;
}

function claimProcessing(id: string, now: number): boolean {
  return db().prepare(`UPDATE kol_post_targets SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'processing'`).run(now, id).changes === 1;
}

function finishTarget(id: string, from: string, status: 'published' | 'failed' | 'missed', patch: { error?: string; externalId?: string | null; permalink?: string; publishedAt?: number | null }, now: number): boolean {
  const changed = db().prepare(
    `UPDATE kol_post_targets SET status = ?, error = ?, external_id = COALESCE(?, external_id), permalink = COALESCE(?, permalink),
       published_at = COALESCE(?, published_at), next_attempt_at = NULL, updated_at = ?
     WHERE id = ? AND status = ?`,
  ).run(status, patch.error ?? '', patch.externalId ?? null, patch.permalink ?? null, patch.publishedAt ?? null, now, id, from).changes === 1;
  if (changed) cleanupStage(id);
  return changed;
}

// ── Outcomes ─────────────────────────────────────────────────────────

/** Writes an adapter outcome for a target currently in `from`. Returns false when the row moved meanwhile. */
function applyOutcome(t: TargetRow, outcome: PublishOutcome, from: 'publishing' | 'processing', now: number): boolean {
  switch (outcome.kind) {
    case 'published':
      return finishTarget(t.id, from, 'published', { externalId: outcome.externalId, permalink: outcome.permalink, publishedAt: now, error: outcome.note ?? '' }, now);
    case 'processing':
      return db().prepare(
        `UPDATE kol_post_targets SET status = 'processing', publish_ref = ?, fb_content_id = COALESCE(?, fb_content_id), updated_at = ? WHERE id = ? AND status = ?`,
      ).run(serializeRef(outcome.ref), outcome.fbContentId ?? null, now, t.id, from).changes === 1;
    case 'failed':
      return finishTarget(t.id, from, 'failed', { error: outcome.uncertain && !outcome.message.includes(UNCERTAIN_MESSAGE) ? UNCERTAIN_MESSAGE : outcome.message }, now);
    case 'missed':
      return finishTarget(t.id, from, 'missed', { error: outcome.message }, now);
  }
}

type Failure =
  | { kind: 'retryable'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'uncertain'; message: string }
  | { kind: 'fatal'; message: string };

/** How a thrown error is handled. `started` = the platform call had begun (staging is over). */
export function classifyPublishFailure(err: unknown, platform: Platform, started: boolean): Failure {
  const label = PLATFORM_LABEL[platform];
  if (err instanceof KolError) return { kind: 'fatal', message: err.message };
  if (err instanceof UncertainOutcomeError) return { kind: 'uncertain', message: UNCERTAIN_MESSAGE };
  if (err instanceof ComposioConnectionExpiredError) return { kind: 'expired', message: `Kết nối ${label} đã hết hạn. Hãy kết nối lại ở tab Kênh rồi thử lại.` };
  if (err instanceof ComposioAuthError) return { kind: 'fatal', message: 'Khóa Composio thiếu hoặc không hợp lệ. Kiểm tra ở Kết nối → Composio.' };
  if (err instanceof ComposioRateLimitError) return { kind: 'retryable', message: `${label} giới hạn tần suất: ${sanitizeError(err)}` };
  const text = sanitizeError(err);
  if (started && isUncertainMessage(text)) return { kind: 'uncertain', message: UNCERTAIN_MESSAGE };
  if (isTransientMessage(text)) return { kind: 'retryable', message: `${label} lỗi tạm thời: ${text}` };
  return { kind: 'fatal', message: `${label} báo lỗi: ${text}` };
}

async function handleFailure(err: unknown, t: TargetRow, account: AccountRow | null, started: boolean, now: number): Promise<void> {
  const platform = t.platform as Platform;
  const f = classifyPublishFailure(err, platform, started);
  const current = getTargetRow(t.id);
  if (!current || current.status !== 'publishing') return;

  if (f.kind === 'retryable') {
    const next = nextAfterTransientFailure(current.attempts);
    if (next.kind === 'retry') {
      db().prepare(`UPDATE kol_post_targets SET status = 'scheduled', next_attempt_at = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'publishing'`)
        .run(now + next.delayMin * 60, f.message, now, t.id);
      cleanupStage(t.id);
      logger.warn({ targetId: t.id, platform, attempts: current.attempts, retryInMin: next.delayMin }, 'kol publish failed, will retry');
      return;
    }
  }
  finishTarget(t.id, 'publishing', 'failed', { error: f.message }, now);
  logger.warn({ targetId: t.id, platform, attempts: current.attempts, kind: f.kind, detail: sanitizeError(err).slice(0, 160) }, 'kol publish failed');
  if (f.kind === 'expired' && account) await markAccountExpired(account.id);
}

// ── Notifications ────────────────────────────────────────────────────

async function notifyPostOutcome(postId: string, status: PostStatus): Promise<void> {
  const post = getPostRow(postId);
  if (!post) return;
  const targets = db().prepare(`SELECT * FROM kol_post_targets WHERE post_id = ? AND status <> 'skipped' ORDER BY platform`).all(postId) as TargetRow[];
  // Missed targets were already reported one by one.
  if (status === 'failed' && targets.every((t) => t.status === 'missed')) return;
  const lines = targets.map((t) => {
    const label = labelOf(getAccountRow(t.account_id), t.platform);
    if (t.status === 'published') return `✓ ${label}: ${t.permalink || 'đã đăng'}${t.error ? ` (${t.error})` : ''}`;
    if (t.status === 'missed') return `✗ ${label}: lỡ giờ đăng`;
    return `✗ ${label}: ${t.error || 'thất bại'}`;
  });
  const name = personaName(post.persona_id);
  const head = status === 'published'
    ? `${name}: đã đăng "${postTitle(post)}"`
    : status === 'partial'
      ? `${name}: "${postTitle(post)}" chỉ đăng được một phần`
      : `${name}: "${postTitle(post)}" đăng thất bại`;
  const tail = status === 'published' ? '' : '\nMở KOL Studio › Nội dung để kiểm tra và thử lại.';
  await notifyOwner(`${head}\n${lines.join('\n')}${tail}`);
}

/** Recomputes the post status after a target changed and tells the owner when the post is done. */
async function afterTarget(postId: string): Promise<void> {
  const { before, after } = recomputePostStatus(postId);
  if (before !== after && (after === 'published' || after === 'partial' || after === 'failed')) await notifyPostOutcome(postId, after);
}

// ── Due targets ──────────────────────────────────────────────────────

interface DueRow extends TargetRow {
  due_at: number;
}

function listDue(now: number): DueRow[] {
  return db().prepare(
    `SELECT t.*, COALESCE(t.next_attempt_at, p.scheduled_at) AS due_at
     FROM kol_post_targets t JOIN kol_posts p ON p.id = t.post_id
     WHERE t.status = 'scheduled' AND COALESCE(t.next_attempt_at, p.scheduled_at) <= ?
       AND p.status NOT IN ('cancelled','idea','draft','review','approved')
     ORDER BY due_at ASC, t.id ASC LIMIT ?`,
  ).all(now, MAX_DUE_PER_TICK) as DueRow[];
}

async function markMissed(t: TargetRow, post: PostRow, account: AccountRow | null, due: number, ready: boolean, now: number): Promise<void> {
  const label = labelOf(account, t.platform);
  const lateMin = Math.max(0, Math.round((now - due) / 60));
  const message = ready
    ? `Quá giờ đăng ${lateMin} phút (cho phép ${GRACE_SEC / 60} phút) nên không đăng muộn.`
    : isAccountReady(account)
      ? 'Chưa có khóa Composio (Kết nối → Composio) nên bài lỡ giờ đăng.'
      : `Tài khoản ${label} đang tắt, lỗi hoặc hết hạn nên bài lỡ giờ đăng.`;
  if (!finishTarget(t.id, 'scheduled', 'missed', { error: message }, now)) return;
  const tz = account?.timezone ?? DEFAULT_TIMEZONE;
  await notifyOwner(
    `${personaName(post.persona_id)}: bài "${postTitle(post)}" lỡ giờ đăng trên ${label} (${formatLocalShort(due, tz)}) và không được đăng muộn. ${message} Mở KOL Studio để đặt lại giờ.`,
  );
  await afterTarget(post.id);
}

async function runAttempt(targetId: string, now: number): Promise<void> {
  const t = getTargetRow(targetId);
  if (!t || t.status !== 'publishing') return;
  const post = getPostRow(t.post_id);
  const account = getAccountRow(t.account_id);
  const platform = t.platform as Platform;
  let started = false;
  try {
    if (!post) throw new KolError(404, 'Bài đã bị xóa.');
    if (!account) throw new KolError(409, 'Tài khoản đăng đã bị gỡ khỏi KOL.');
    const persona = getPersona(post.persona_id);
    if (!persona) throw new KolError(404, 'Không tìm thấy KOL của bài.');
    if (!persona.disclosureText.trim()) throw new KolError(409, 'KOL chưa có dòng công bố nội dung AI (disclosure) nên bài không được đăng.');
    const dto = requirePost(post.id);
    if (dto.assets.length !== new Set(dto.assetIds).size) throw new KolError(400, 'Có ảnh/video của bài đã bị xóa nên không đăng.');
    if (dto.assets.some((a) => a.status !== 'approved')) throw new KolError(409, 'Có ảnh/video chưa được duyệt nên không đăng.');
    const problems = formatProblems(platform, post.format as PostFormat, dto.assets, post.caption);
    if (problems.length) throw new KolError(400, problems.join(' '));

    const media = await stageMedia(t.id, platform, dto.assetIds);
    const caption = buildCaption(platform, dto, persona.disclosureText);
    started = true;
    const outcome = await ADAPTERS[platform].publish({ target: t, post: dto, account, persona, media, caption, now });
    if (!applyOutcome(t, outcome, 'publishing', now)) logger.warn({ targetId }, 'kol: target was no longer publishing when the outcome arrived');
    logger.info({ targetId, platform, outcome: outcome.kind }, 'kol publish attempt done');
  } catch (err) {
    await handleFailure(err, t, account, started, now);
  }
  if (post) await afterTarget(post.id);
}

async function processDue(t: DueRow, now: number): Promise<void> {
  const post = getPostRow(t.post_id);
  if (!post) return;
  const account = getAccountRow(t.account_id);
  const due = dueAtOf(t, post) ?? t.due_at ?? now;
  // Facebook hand-offs do not need Composio on the KOL side; every other platform does.
  const ready = isAccountReady(account) && (t.platform === 'facebook' || hasComposioKey());
  // Never post late: a first attempt past the grace window is dropped, and so is anything whose account is off past it.
  if (isPastGrace(due, now) && (t.attempts === 0 || !ready)) {
    await markMissed(t, post, account, due, ready, now);
    return;
  }
  if (!ready) return; // waits (until the grace window ends) for the account to come back
  if (!claimScheduled(t.id, now)) return;
  inFlight.add(t.id);
  try {
    await runAttempt(t.id, now);
  } finally {
    inFlight.delete(t.id);
  }
}

// ── Processing targets ───────────────────────────────────────────────

async function pollTarget(t: TargetRow, now: number, allowMutating: boolean): Promise<void> {
  const platform = t.platform as Platform;
  const adapter = ADAPTERS[platform];
  if (!adapter) return;
  if (adapter.pollMutates && !allowMutating) return;
  if (platform !== 'facebook' && !hasComposioKey()) return;
  const post = getPostRow(t.post_id);
  const account = getAccountRow(t.account_id);
  const ref: PublishRef | null = parseRef(t.publish_ref) ?? (t.fb_content_id ? { id: String(t.fb_content_id), since: t.updated_at } : null);
  const from = adapter.pollMutates ? 'publishing' : 'processing';

  if (!post || !account || !ref) {
    if (finishTarget(t.id, 'processing', 'failed', { error: `Mất thông tin theo dõi bài đang xử lý. ${UNCERTAIN_MESSAGE}` }, now) && post) await afterTarget(post.id);
    return;
  }
  if (adapter.pollMutates) {
    if (!claimProcessing(t.id, now)) return;
    inFlight.add(t.id);
  }
  try {
    const outcome = await adapter.poll({ target: t, post, account, ref, now });
    applyOutcome(t, outcome, from, now);
  } catch (err) {
    const f = classifyPublishFailure(err, platform, true);
    const giveUp = now - ref.since > 2 * PROCESSING_TIMEOUT_SEC;
    if (f.kind === 'expired') {
      finishTarget(t.id, from, 'failed', { error: adapter.pollMutates ? `${f.message} Bài chưa được đăng.` : UNCERTAIN_MESSAGE }, now);
      await markAccountExpired(account.id);
    } else if (err instanceof UncertainOutcomeError) {
      finishTarget(t.id, from, 'failed', { error: UNCERTAIN_MESSAGE }, now);
    } else if ((f.kind === 'retryable' || f.kind === 'uncertain') && !giveUp) {
      // A status read that failed for a passing reason: look again next tick.
      if (from === 'publishing') db().prepare(`UPDATE kol_post_targets SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'publishing'`).run(now, t.id);
    } else {
      finishTarget(t.id, from, 'failed', { error: adapter.pollMutates && !giveUp ? f.message : UNCERTAIN_MESSAGE }, now);
    }
    logger.warn({ targetId: t.id, platform, kind: f.kind, detail: sanitizeError(err).slice(0, 160) }, 'kol processing poll failed');
  } finally {
    inFlight.delete(t.id);
  }
  await afterTarget(post.id);
}

// ── Interrupted runs ─────────────────────────────────────────────────

/** Targets left 'publishing' for > 15 min by a run that is gone become failed with UNCERTAIN_MESSAGE (never re-posted). */
export async function recoverStuckTargets(now = nowSec()): Promise<number> {
  const rows = db().prepare(`SELECT * FROM kol_post_targets WHERE status = 'publishing' AND updated_at < ?`).all(now - STUCK_AFTER_SEC) as TargetRow[];
  let n = 0;
  for (const t of rows) {
    if (inFlight.has(t.id)) continue;
    if (!finishTarget(t.id, 'publishing', 'failed', { error: UNCERTAIN_MESSAGE }, now)) continue;
    n++;
    const post = getPostRow(t.post_id);
    const label = labelOf(getAccountRow(t.account_id), t.platform);
    await notifyOwner(
      `${post ? personaName(post.persona_id) : 'KOL'}: bài "${post ? postTitle(post) : t.post_id}" bị gián đoạn khi đang đăng lên ${label}. ${UNCERTAIN_MESSAGE}.`,
    );
    if (post) await afterTarget(post.id);
  }
  return n;
}

// ── The tick ─────────────────────────────────────────────────────────

/** One pass of the worker. Exported for tests. */
export async function publisherTick(now: number = nowSec()): Promise<void> {
  if (ticking) {
    rerun = true;
    return;
  }
  ticking = true;
  try {
    lastTickAt = now;
    await recoverStuckTargets(now);
    if (!loadSettings().enabled) return;
    const allowed = publishingAllowed();
    const processing = db().prepare(`SELECT * FROM kol_post_targets WHERE status = 'processing' ORDER BY updated_at ASC LIMIT ?`).all(MAX_POLLS_PER_TICK) as TargetRow[];
    for (const t of processing) {
      try {
        await pollTarget(t, now, allowed);
      } catch (err) {
        logger.error({ err: String(err), targetId: t.id }, 'kol poll crashed');
      }
    }
    if (!allowed) return;
    for (const t of listDue(now)) {
      if (!publishingAllowed()) break;
      await processDue(t, now);
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'kol publisher tick failed');
  } finally {
    ticking = false;
    if (rerun) {
      rerun = false;
      void publisherTick().catch(() => {});
    }
  }
}
