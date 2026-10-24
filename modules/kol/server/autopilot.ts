/**
 * Autopilot: keeps each persona's calendar filled `leadDays` ahead.
 *
 * Hourly tick (settings.autopilotEnabled, persona active with
 * autopilot.enabled):
 *  1. advance: autopilot drafts whose generations finished get their best
 *     asset (highest consistency score, verdict not 'fail'), captions in the
 *     persona's voice, and move to 'review' — or to 'scheduled' when the
 *     persona's autopilot does not require approval and every target account
 *     has autoPublish on (then autopilot approves its own chosen assets and
 *     the schedule rules still apply). Video
 *     formats generate an image first and animate it on a later tick.
 *  2. plan (once per persona per local day): counts planned posts per
 *     platform against postsPerWeek, asks the strategist for exactly the
 *     missing ideas, creates the posts (source 'autopilot', status 'draft',
 *     a proposed time that respects every account's rules) and requests
 *     media while the persona's weekly autopilot budget allows it.
 */

import { isValidTimezone, localParts, startOfLocalWeek, zonedTimeToEpoch } from './time.js';
import { logger } from './compat.js';
import { accountLabel, getAccountRow, isAccountReady, listAccountRows, notifyOwner, sameChannelAccountIds, type AccountRow } from './accounts.js';
import { runKolAgent, type AgentRunner } from './agent-turn.js';
import { listAssetsByIds, patchAsset } from './assets.js';
import { writeCaptionVariants } from './captions.js';
import { KolError, kolDb, loadSettings, nowSec } from './core.js';
import { listGenerationsForPost, requestGeneration } from './generations.js';
import { getPersona, listPersonaIds, requirePersona } from './personas.js';
import {
  approvePost,
  createPost,
  listPosts,
  requirePost,
  rulesOf,
  setPostAssets,
  setPostFeedback,
  setPostVariants,
  submitPost,
} from './posts.js';
import { listRadarIdeas } from './radar-ideas.js';
import { PLATFORM_LABEL, PLATFORMS, proposeSlot } from './schedule-rules.js';
import { personaSpendSince } from './spend.js';
import { lastInsightSince, personaTimezone, planIdeas, saveInsight, setInsightPosts, type PlannedIdea } from './strategist.js';
import type { Aspect, AssetDto, AutopilotConfig, GenerationDto, InsightDto, PersonaDto, Platform, PostDto, PostFormat } from './types.js';

const TICK_MS = 60 * 60_000;
const DAY = 86_400;
/** Planning starts at least this far ahead so the owner has time to review. */
const MIN_LEAD_SEC = 2 * 3600;

/** Rough per-unit estimates used to keep the weekly budget before a generation has its own price. */
export const IMAGE_ESTIMATE_USD = 0.05;
export const VIDEO_ESTIMATE_USD = 1.0;

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  enabled: false,
  postsPerWeek: {},
  leadDays: 3,
  requireApproval: true,
  imagesPerPost: 2,
  generateMedia: false,
  weeklyBudgetUsd: 0,
};

export function normalizeAutopilot(a: Partial<AutopilotConfig> | null | undefined): AutopilotConfig {
  const x = { ...DEFAULT_AUTOPILOT, ...(a ?? {}) };
  const ppw: Partial<Record<Platform, number>> = {};
  for (const p of PLATFORMS) {
    const n = Number(x.postsPerWeek?.[p]);
    if (Number.isFinite(n) && n > 0) ppw[p] = Math.min(28, Math.round(n));
  }
  return {
    enabled: !!x.enabled,
    postsPerWeek: ppw,
    leadDays: Math.min(14, Math.max(1, Math.round(Number(x.leadDays) || 3))),
    requireApproval: x.requireApproval !== false,
    imagesPerPost: Math.min(4, Math.max(1, Math.round(Number(x.imagesPerPost) || 1))),
    generateMedia: !!x.generateMedia,
    weeklyBudgetUsd: Math.max(0, Number(x.weeklyBudgetUsd) || 0),
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────

/** Posts each platform still needs in the next leadDays: ceil(postsPerWeek × leadDays / 7) − already planned. */
export function missingPerPlatform(
  postsPerWeek: Partial<Record<Platform, number>>,
  leadDays: number,
  existing: Partial<Record<Platform, number>>,
  available: Platform[],
): Partial<Record<Platform, number>> {
  const out: Partial<Record<Platform, number>> = {};
  for (const p of available) {
    const ppw = postsPerWeek[p] ?? 0;
    if (ppw <= 0) continue;
    const need = Math.ceil((ppw * leadDays) / 7) - (existing[p] ?? 0);
    if (need > 0) out[p] = need;
  }
  return out;
}

/** Aspect for generated media: vertical 9:16 for reels/videos, 4:5 (Instagram feed) for photos and carousels. */
export function aspectFor(format: PostFormat): Aspect {
  return format === 'reel' || format === 'video' ? '9:16' : '4:5';
}

/** Images to generate for a post. */
export function imageCountFor(format: PostFormat, imagesPerPost: number): number {
  return format === 'carousel' ? Math.min(4, Math.max(2, imagesPerPost)) : Math.min(4, Math.max(1, imagesPerPost));
}

/** Best usable images first: verdict not 'fail', not rejected, highest consistency score. */
export function rankAssets(assets: AssetDto[], kind: 'image' | 'video'): AssetDto[] {
  return assets
    .filter((a) => a.kind === kind && a.status !== 'rejected' && a.consistency?.verdict !== 'fail')
    .sort((a, b) => (b.consistency?.score ?? -1) - (a.consistency?.score ?? -1) || a.createdAt - b.createdAt);
}

// ── Budget ───────────────────────────────────────────────────────────

interface Budget {
  limit: number;
  /** This week's autopilot spend, unfinished jobs included (personaSpendSince), plus what this run requested. */
  used: number;
}

function budgetFor(persona: PersonaDto, ap: AutopilotConfig, now: number): Budget {
  const weekStart = startOfLocalWeek(now, personaTimezone(persona.id));
  return { limit: ap.weeklyBudgetUsd, used: personaSpendSince(persona.id, weekStart, 'autopilot') };
}

/** Requests a generation when the weekly budget allows it; returns null (with a Vietnamese reason) otherwise. */
function generateWithin(budget: Budget, estimate: number, run: () => GenerationDto): { gen: GenerationDto | null; reason: string } {
  if (budget.used + estimate > budget.limit + 1e-9) {
    return { gen: null, reason: `Autopilot dừng tạo media vì sẽ vượt ngân sách tuần ($${budget.limit.toFixed(2)}).` };
  }
  try {
    const gen = run();
    budget.used += gen.estimateUsd || estimate;
    return { gen, reason: '' };
  } catch (err) {
    const msg = err instanceof KolError ? err.message : String((err as Error)?.message ?? err).slice(0, 200);
    return { gen: null, reason: `Không tạo được media tự động: ${msg}` };
  }
}

// ── Slots ────────────────────────────────────────────────────────────

/** Times already taken on an account, including proposed times of drafts and posts in review. */
function takenTimes(accountId: string, from: number, to: number): number[] {
  const ids = sameChannelAccountIds(accountId);
  const rows = kolDb().prepare(
    `SELECT COALESCE(t.published_at, t.next_attempt_at, p.scheduled_at) AS at
     FROM kol_post_targets t JOIN kol_posts p ON p.id = t.post_id
     WHERE t.account_id IN (${ids.map(() => '?').join(',')}) AND t.status IN ('pending','scheduled','publishing','processing','published')
       AND p.status NOT IN ('cancelled','idea')
       AND COALESCE(t.published_at, t.next_attempt_at, p.scheduled_at) BETWEEN ? AND ?`,
  ).all(...ids, from, to) as { at: number | null }[];
  return rows.map((r) => r.at).filter((x): x is number => typeof x === 'number');
}

function countPlanned(personaId: string, platform: Platform, from: number, to: number): number {
  const r = kolDb().prepare(
    `SELECT COUNT(DISTINCT p.id) AS n FROM kol_posts p JOIN kol_post_targets t ON t.post_id = p.id
     WHERE p.persona_id = ? AND t.platform = ? AND t.status <> 'skipped'
       AND p.status IN ('draft','review','approved','scheduled','publishing','published','partial')
       AND COALESCE(t.published_at, t.next_attempt_at, p.scheduled_at) BETWEEN ? AND ?`,
  ).get(personaId, platform, from, to) as { n: number };
  return r.n;
}

// ── Finalising a post ────────────────────────────────────────────────

type Finish = 'review' | 'scheduled';

/**
 * Captions, then review — or scheduled when approval is not required, the
 * media is complete and the rules allow the proposed time.
 */
async function finalizePost(postId: string, persona: PersonaDto, ap: AutopilotConfig, runner: AgentRunner, problem: string, now: number): Promise<Finish> {
  const notes: string[] = problem ? [problem] : [];
  try {
    setPostVariants(postId, await writeCaptionVariants(requirePost(postId), persona, {}, runner));
  } catch (err) {
    notes.push(`Chưa viết được chú thích tự động: ${err instanceof KolError ? err.message : 'agent lỗi'}`);
  }
  const post = requirePost(postId);
  const needsMedia = post.format !== 'text';
  if (needsMedia && post.assetIds.length === 0 && !problem) notes.push('Bài chưa có ảnh/video: tạo trong Studio rồi gắn vào bài.');

  // Skipping the owner also needs every target account to allow it (AccountDto.autoPublish).
  const manual = !ap.requireApproval
    ? post.targets.map((t) => getAccountRow(t.accountId)).filter((a) => a && a.auto_publish !== 1).map((a) => accountLabel(a!))
    : [];
  if (manual.length && notes.length === 0) notes.push(`Chờ duyệt vì ${manual.join(', ')} chưa bật "Tự đăng không cần duyệt" ở tab Kênh.`);

  if (!ap.requireApproval && notes.length === 0 && post.scheduledAt && post.scheduledAt > now) {
    // Approval is off: autopilot approves the media it picked itself, then schedules within the rules.
    approveOwnAssets(post);
    try {
      approvePost(postId, post.scheduledAt, now);
      return 'scheduled';
    } catch (err) {
      notes.push(`Không tự lên lịch được: ${err instanceof KolError ? err.message : String(err)}`);
    }
  }
  if (notes.length) setPostFeedback(postId, notes.join(' '));
  submitPost(postId);
  return 'review';
}

/**
 * Marks the post's 'new' assets approved. Only used when the persona's
 * autopilot runs without approval, for the assets autopilot picked for this
 * very post.
 */
function approveOwnAssets(post: PostDto): void {
  for (const a of post.assets) if (a.status === 'new') patchAsset(a.id, { status: 'approved' });
}

// ── Advance (attach media when generations finish) ───────────────────

const isBusy = (g: GenerationDto) => g.status === 'queued' || g.status === 'running';

function assetsOf(gens: GenerationDto[]): AssetDto[] {
  const ids = [...new Set(gens.filter((g) => g.status === 'succeeded').flatMap((g) => g.assetIds))];
  return ids.length ? listAssetsByIds(ids) : [];
}

/** One autopilot draft: returns how it ended, or null when it is still waiting. */
async function advancePost(post: PostDto, persona: PersonaDto, ap: AutopilotConfig, runner: AgentRunner, budget: Budget, now: number): Promise<Finish | null> {
  const gens = listGenerationsForPost(post.id);
  if (!gens.length || gens.some(isBusy)) return null;
  const video = post.format === 'reel' || post.format === 'video';
  const imageGens = gens.filter((g) => g.kind === 'image');
  const videoGens = gens.filter((g) => g.kind === 'video' || g.mode === 'animate');

  if (video) {
    const clips = rankAssets(assetsOf(videoGens), 'video');
    if (clips.length) {
      setPostAssets(post.id, [clips[0].id]);
      return finalizePost(post.id, persona, ap, runner, '', now);
    }
    if (videoGens.length) {
      return finalizePost(post.id, persona, ap, runner, `Tạo video thất bại${videoGens[0].error ? `: ${videoGens[0].error.slice(0, 160)}` : ''}. Hãy tạo lại trong Studio.`, now);
    }
    const best = rankAssets(assetsOf(imageGens), 'image')[0];
    if (!best) return finalizePost(post.id, persona, ap, runner, 'Ảnh tạo ra không đạt độ giống nhân vật nên chưa làm được video. Hãy tạo lại trong Studio.', now);
    const { gen, reason } = generateWithin(budget, VIDEO_ESTIMATE_USD, () => requestGeneration({
      personaId: persona.id,
      mode: 'animate',
      selection: { sourceAssetId: best.id },
      params: { aspect: '9:16' },
      postId: post.id,
    }, 'autopilot'));
    if (gen) return null; // the clip arrives on a later tick
    return finalizePost(post.id, persona, ap, runner, reason, now);
  }

  const ranked = rankAssets(assetsOf(imageGens), 'image');
  if (post.format === 'carousel') {
    if (ranked.length < 2) return finalizePost(post.id, persona, ap, runner, 'Chưa đủ 2 ảnh đạt độ giống nhân vật cho carousel. Hãy tạo thêm trong Studio.', now);
    setPostAssets(post.id, ranked.slice(0, 10).map((a) => a.id));
    return finalizePost(post.id, persona, ap, runner, '', now);
  }
  if (!ranked.length) return finalizePost(post.id, persona, ap, runner, 'Ảnh tạo ra không đạt độ giống nhân vật. Hãy tạo lại trong Studio.', now);
  setPostAssets(post.id, [ranked[0].id]);
  return finalizePost(post.id, persona, ap, runner, '', now);
}

/** Moves finished autopilot drafts on. Returns how many went to review / scheduled. */
export async function advanceAutopilotPosts(persona: PersonaDto, runner: AgentRunner = runKolAgent, now = nowSec()): Promise<{ review: number; scheduled: number }> {
  const ap = normalizeAutopilot(persona.autopilot);
  const budget = budgetFor(persona, ap, now);
  const out = { review: 0, scheduled: 0 };
  // Drafts the owner returned carry feedback and already have media: autopilot leaves them alone.
  for (const post of listPosts({ personaId: persona.id, source: 'autopilot', status: 'draft' })) {
    if (post.feedback || post.assetIds.length) continue;
    try {
      const r = await advancePost(post, persona, ap, runner, budget, now);
      if (r) out[r]++;
    } catch (err) {
      logger.warn({ postId: post.id, err: String(err).slice(0, 200) }, 'kol autopilot: advancing a post failed');
    }
  }
  return out;
}

// ── Plan ─────────────────────────────────────────────────────────────

function startOfLocalDay(now: number, tz: string): number {
  const p = localParts(now, tz);
  return zonedTimeToEpoch(p.year, p.month, p.day, 0, 0, tz);
}

export interface PlanResult {
  insight: InsightDto | null;
  created: string[];
  review: number;
  scheduled: number;
}

/**
 * Plans the missing posts for one persona and creates them. `manual` (the
 * route) always returns an insight, even when nothing is missing.
 */
export async function planForPersona(persona: PersonaDto, opts: { runner?: AgentRunner; now?: number; manual?: boolean } = {}): Promise<PlanResult> {
  const runner = opts.runner ?? runKolAgent;
  const now = opts.now ?? nowSec();
  const ap = normalizeAutopilot(persona.autopilot);
  const tz = personaTimezone(persona.id);
  const leadDays = ap.leadDays;
  const from = now + MIN_LEAD_SEC;
  const to = now + leadDays * DAY;

  const accounts = listAccountRows(persona.id).filter(isAccountReady);
  const byPlatform = new Map<Platform, AccountRow[]>();
  for (const a of accounts) byPlatform.set(a.platform as Platform, [...(byPlatform.get(a.platform as Platform) ?? []), a]);
  const available = [...byPlatform.keys()];
  const existing: Partial<Record<Platform, number>> = {};
  for (const p of available) existing[p] = countPlanned(persona.id, p, now, to);
  const quotas = missingPerPlatform(ap.postsPerWeek, leadDays, existing, available);

  if (!Object.keys(quotas).length) {
    if (!opts.manual) return { insight: null, created: [], review: 0, scheduled: 0 };
    const why = available.length
      ? `Lịch ${leadDays} ngày tới đã đủ bài theo số bài/tuần đã đặt; không cần thêm.`
      : 'KOL chưa có tài khoản nào đang bật để lên kế hoạch.';
    return { insight: saveInsight({ personaId: persona.id, kind: 'plan', periodStart: from, summary: why, ideas: [] }, now), created: [], review: 0, scheduled: 0 };
  }

  const windows: Partial<Record<Platform, string>> = {};
  for (const [p, list] of byPlatform) windows[p] = `${list[0].window_start}–${list[0].window_end}`;
  const { summary, ideas } = await planIdeas(persona, { quotas, from, to, timezone: tz, windows, radarIdeas: listRadarIdeas(10) }, runner, now);
  const insight = saveInsight({ personaId: persona.id, kind: 'plan', periodStart: from, summary, ideas }, now);

  const budget = budgetFor(persona, ap, now);
  const taken = new Map<string, number[]>();
  const created: string[] = [];
  const notes: string[] = [];
  let review = 0;
  let scheduled = 0;

  for (const idea of ideas) {
    const accs = idea.platforms.flatMap((p) => byPlatform.get(p) ?? []);
    if (!accs.length) continue;
    const slots = accs.map((a) => {
      if (!taken.has(a.id)) taken.set(a.id, takenTimes(a.id, from - 2 * DAY, to + 2 * DAY));
      return { rules: rulesOf(a), others: taken.get(a.id)! };
    });
    const at = proposeSlot(slots, from, to, now, idea.at);
    if (!at) {
      notes.push(`Không còn giờ trống hợp lệ cho "${idea.title}" (${idea.platforms.map((p) => PLATFORM_LABEL[p]).join(', ')}).`);
      continue;
    }
    for (const a of accs) taken.get(a.id)!.push(at);
    const post = createPost(persona.id, {
      title: idea.title,
      pillar: idea.pillar,
      format: idea.format,
      caption: idea.caption,
      brief: idea.brief,
      accountIds: accs.map((a) => a.id),
      scheduledAt: at,
    }, { source: 'autopilot', sourceRef: insight.id });
    created.push(post.id);

    const r = await startMedia(post, idea, persona, ap, budget, runner, now);
    if (r === 'review') review++;
    if (r === 'scheduled') scheduled++;
  }
  setInsightPosts(insight.id, created);
  if (notes.length) kolDb().prepare('UPDATE kol_insights SET summary = summary || ? WHERE id = ?').run(`\n\n${notes.join(' ')}`, insight.id);
  return { insight: { ...insight, postIds: created, summary: notes.length ? `${insight.summary}\n\n${notes.join(' ')}` : insight.summary }, created, review, scheduled };
}

/** Requests the first media for a new post, or finalises it at once when no media will be generated. */
async function startMedia(post: PostDto, idea: PlannedIdea, persona: PersonaDto, ap: AutopilotConfig, budget: Budget, runner: AgentRunner, now: number): Promise<Finish | null> {
  if (idea.format === 'text') return finalizePost(post.id, persona, ap, runner, '', now);
  if (!ap.generateMedia) return finalizePost(post.id, persona, ap, runner, '', now);
  const count = imageCountFor(idea.format, ap.imagesPerPost);
  const { gen, reason } = generateWithin(budget, count * IMAGE_ESTIMATE_USD, () => requestGeneration({
    personaId: persona.id,
    mode: 'compose',
    selection: idea.selection,
    params: { count, aspect: aspectFor(idea.format) },
    postId: post.id,
  }, 'autopilot'));
  if (gen) return null;
  return finalizePost(post.id, persona, ap, runner, reason, now);
}

// ── Worker ───────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** True when a 'plan' insight already exists for the persona's current local day. */
export function plannedToday(personaId: string, now = nowSec()): boolean {
  const tz = personaTimezone(personaId);
  return !!lastInsightSince(personaId, 'plan', startOfLocalDay(now, isValidTimezone(tz) ? tz : 'Asia/Ho_Chi_Minh'));
}

export async function autopilotTick(now = nowSec(), runner: AgentRunner = runKolAgent): Promise<void> {
  if (ticking) return;
  const s = loadSettings();
  if (!s.enabled || !s.autopilotEnabled) return;
  ticking = true;
  try {
    for (const id of listPersonaIds()) {
      const persona = getPersona(id);
      if (!persona || persona.status !== 'active' || !persona.autopilot?.enabled) continue;
      try {
        const adv = await advanceAutopilotPosts(persona, runner, now);
        let review = adv.review;
        let scheduled = adv.scheduled;
        if (!plannedToday(persona.id, now)) {
          const plan = await planForPersona(persona, { runner, now });
          review += plan.review;
          scheduled += plan.scheduled;
        }
        if (review) await notifyOwner(`${persona.name}: ${review} bài mới chờ duyệt`);
        if (scheduled) await notifyOwner(`${persona.name}: ${scheduled} bài autopilot đã tự lên lịch`);
      } catch (err) {
        logger.warn({ personaId: id, err: String((err as Error)?.message ?? err).slice(0, 200) }, 'kol autopilot failed for persona');
      }
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'kol autopilot tick failed');
  } finally {
    ticking = false;
  }
}

/** POST /personas/:id/autopilot/run: plan now (manual), then return the insight. */
export async function runAutopilotNow(personaId: string, runner: AgentRunner = runKolAgent, now = nowSec()): Promise<InsightDto> {
  const persona = requirePersona(personaId);
  const adv = await advanceAutopilotPosts(persona, runner, now);
  const plan = await planForPersona(persona, { runner, now, manual: true });
  const review = adv.review + plan.review;
  if (review) await notifyOwner(`${persona.name}: ${review} bài mới chờ duyệt`);
  return plan.insight!;
}

export function startAutopilot(): void {
  if (timer) return;
  timer = setInterval(() => void autopilotTick(), TICK_MS);
  timer.unref?.();
  const first = setTimeout(() => void autopilotTick(), 3 * 60_000);
  first.unref?.();
}

export function stopAutopilot(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
