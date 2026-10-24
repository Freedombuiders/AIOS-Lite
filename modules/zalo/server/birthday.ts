/**
 * Birthday greetings worker (Sale › Marketing › Chúc mừng sinh nhật).
 *
 * Ported from ZaloCRM's birthday module (planner / sender / cron), minus
 * Prisma/BullMQ/multi-tenant. Three independent loops inside the Zalo daemon:
 *   - planner  (10 min): turns birth dates into pending greetings for today;
 *   - sender   (60 s):   sends due greetings, a few per tick, with random gaps;
 *   - backfill (30 min): looks up birth dates of 1-1 threads that have none.
 *
 * Greetings go out from the thread's own nick — it is already a warm 1-1 chat,
 * which is exactly what makes a birthday message safe. Every send goes through
 * ZaloSender.sendRich(bulk: true), which enforces quiet hours and the nick's
 * marketing budget; nick-level refusals leave the greeting pending (it retries
 * until TOO_LATE) instead of burning it as failed.
 */

import fs from 'fs';

import {
  countZaloBirthDateChecksSince,
  countZaloBirthdayGreetingsDueBetween,
  countZaloBirthdaySentBetween,
  findZaloBirthdayThreads,
  getZaloAccount,
  getZaloBirthdayConfig,
  getZaloBirthdayGreeting,
  getZaloBirthdayThread,
  getZaloTemplate,
  insertZaloBirthdayGreeting,
  listDueZaloBirthdayGreetings,
  listZaloAccounts,
  listZaloBirthDateBackfillCandidates,
  listZaloBirthdayGreetingsByBirthday,
  markZaloBirthDateChecked,
  noteZaloThreadBirthDate,
  retimePendingZaloBirthdayGreetings,
  updateZaloBirthdayGreeting,
  type ZaloBirthdayConfig,
  type ZaloBirthdayGreetingRow,
  type ZaloBirthdayOccasion,
} from './store.js';
import { logger } from './compat.js';
import {
  addDays,
  ageOnBirthday,
  BIRTHDAY_OCCASIONS,
  calendarDateUtc,
  celebratedOn,
  dayBoundsUtc,
  formatCalendarDate,
  isOccasionEnabled,
  isTooLate,
  isValidTimezone,
  monthDaysFor,
  occasionOffsetDays,
  parseProfileBirthDate,
  plannedOccasionsFor,
  zonedDateParts,
  type BirthdayScheduleSpec,
} from './birthday-schedule.js';
import { classifyZaloError } from './limits.js';
import type { ZaloAttachment } from './media.js';
import { DEFAULT_TIMEZONE, type MarketingDeps, type WorkerHandle } from './marketing-deps.js';
import type { ZaloStyle } from './rich-text.js';
import { buildTemplateVars, renderTemplate } from './template.js';

const PLAN_INTERVAL_MS = 10 * 60_000;
const SEND_INTERVAL_MS = 60_000;
const BACKFILL_INTERVAL_MS = 30 * 60_000;
/** Planner cap per calendar day, so a huge contact list cannot flood the queue. */
export const MAX_GREETINGS_PER_DAY = 500;
/** Greetings actually attempted per sender tick (skips and waits do not count). */
const MAX_ATTEMPTS_PER_TICK = 5;
const DUE_SCAN_LIMIT = 50;
const BACKFILL_BATCH = 20;
const BACKFILL_DAILY_CAP = 100;
const BACKFILL_GAP_MS = 1_500;
const BACKFILL_RECHECK_SEC = 30 * 86_400;
/** After a failed lookup retry in a day, not in a month. */
const BACKFILL_ERROR_RETRY_SEC = 86_400;
const MIN_DELAY_FLOOR_SEC = 5;
/** Between a greeting's text and its attachments (we send steps separately for idempotency). */
const STEP_GAP_MIN_MS = 800;
const STEP_GAP_MAX_MS = 2_500;

/** Send errors that concern the nick (or the moment), not the greeting. */
const NICK_LEVEL_CODES = new Set(['QUIET_HOURS', 'BULK_BUDGET', 'RATE_LIMITED', 'NOT_CONNECTED', 'CHAT_DISABLED', 'LOCKED']);

export interface BirthdayRuntime {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  isStopped?: () => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function specOf(c: ZaloBirthdayConfig): BirthdayScheduleSpec {
  return {
    timezone: safeTimezone(c.timezone),
    sendTime: c.sendTime,
    lateToleranceMinutes: c.lateToleranceMinutes,
    beforeEnabled: c.beforeEnabled,
    beforeDays: c.beforeDays,
    onDayEnabled: c.onDayEnabled,
    afterEnabled: c.afterEnabled,
    afterDays: c.afterDays,
  };
}

/** A bad stored timezone must not take the worker down. */
export function safeTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

export function templateIdFor(c: ZaloBirthdayConfig, occasion: ZaloBirthdayOccasion): number | null {
  if (occasion === 'before') return c.beforeTemplateId;
  if (occasion === 'after') return c.afterTemplateId;
  return c.onDayTemplateId;
}

// ── Birth dates from profiles ────────────────────────────────────────

/**
 * Called by ingest whenever a fresh getUserInfo profile of a 1-1 peer is
 * fetched. Stores the birth date if the thread has none yet. Never throws.
 */
export function noteBirthDateFromProfile(threadId: number, profile: Record<string, unknown>): void {
  try {
    noteZaloThreadBirthDate(threadId, parseProfileBirthDate(profile?.sdob, profile?.dob));
  } catch (err) {
    logger.debug({ threadId, err: String(err) }, 'birthday: noting birth date failed');
  }
}

// ── Planner ──────────────────────────────────────────────────────────

/**
 * Create today's pending greetings. Idempotent (unique thread/occasion/
 * birthday key): re-running only picks up customers whose birth date was
 * added since, and re-times still-pending rows after a send-time change.
 */
export function planBirthdayGreetings(now: Date = new Date()): { created: number; existing: number } {
  const cfg = getZaloBirthdayConfig();
  if (!cfg.enabled) return { created: 0, existing: 0 };
  const spec = specOf(cfg);
  const day = dayBoundsUtc(spec.timezone, now);
  let room = MAX_GREETINGS_PER_DAY - countZaloBirthdayGreetingsDueBetween(
    Math.floor(day.start.getTime() / 1000), Math.floor(day.end.getTime() / 1000),
  );
  let created = 0;
  let existing = 0;
  for (const occ of plannedOccasionsFor(spec, now)) {
    // No template chosen yet: planning would only breed rows that can never send.
    if (templateIdFor(cfg, occ.occasion) === null) continue;
    retimePendingZaloBirthdayGreetings(occ.occasion, occ.birthdayOn, occ.dueAt);
    for (const t of findZaloBirthdayThreads(occ.monthDays, cfg.accountIds, MAX_GREETINGS_PER_DAY)) {
      if (room <= 0) {
        logger.warn({ occasion: occ.occasion }, 'birthday planner hit the daily cap; the rest wait for tomorrow');
        return { created, existing };
      }
      const made = insertZaloBirthdayGreeting({
        threadId: t.id, accountId: t.account_id, occasion: occ.occasion, birthdayOn: occ.birthdayOn, dueAt: occ.dueAt,
      });
      if (made) { created++; room--; } else existing++;
    }
  }
  return { created, existing };
}

// ── Sender ───────────────────────────────────────────────────────────

type Outcome = 'sent' | 'failed' | 'skipped' | 'waiting';

function parseIds(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function skip(g: ZaloBirthdayGreetingRow, reason: string): Outcome {
  updateZaloBirthdayGreeting(g.id, { state: 'skipped', skipReason: reason });
  return 'skipped';
}

/** Keep the greeting pending but say why in the UI (only writes when it changes). */
function wait(g: ZaloBirthdayGreetingRow, reason: string): Outcome {
  if (g.skip_reason !== reason) updateZaloBirthdayGreeting(g.id, { skipReason: reason });
  return 'waiting';
}

function randomGapMs(cfg: ZaloBirthdayConfig, rng: () => number): number {
  const min = Math.max(MIN_DELAY_FLOOR_SEC, cfg.minDelaySec);
  const max = Math.max(min, cfg.maxDelaySec);
  return Math.round((min + rng() * (max - min)) * 1000);
}

interface Step {
  text?: string;
  styles?: ZaloStyle[];
  attachments?: ZaloAttachment[];
}

async function processGreeting(
  deps: MarketingDeps,
  cfg: ZaloBirthdayConfig,
  g: ZaloBirthdayGreetingRow,
  blockedNicks: Set<string>,
  rt: Required<Pick<BirthdayRuntime, 'sleep' | 'rng'>>,
  now: Date,
): Promise<Outcome> {
  const spec = specOf(cfg);
  const occasion = g.occasion;
  if (!BIRTHDAY_OCCASIONS.includes(occasion)) return skip(g, 'UNKNOWN_OCCASION');
  if (isTooLate(cfg.lateToleranceMinutes, g.due_at, now)) return skip(g, 'TOO_LATE');
  if (!isOccasionEnabled(spec, occasion)) return skip(g, 'OCCASION_DISABLED');
  // Feature switched off: leave the rows alone; TOO_LATE sweeps them if it stays off.
  if (!cfg.enabled) return 'waiting';

  const thread = getZaloBirthdayThread(g.thread_id);
  if (!thread) return skip(g, 'THREAD_GONE');
  if (thread.thread_type !== 'user') return skip(g, 'NOT_PRIVATE');
  if (thread.opted_out === 1) return skip(g, 'OPTED_OUT');
  if (cfg.accountIds.length > 0 && !cfg.accountIds.includes(thread.account_id)) return skip(g, 'NICK_NOT_ALLOWED');

  const templateId = templateIdFor(cfg, occasion);
  const template = templateId === null ? undefined : getZaloTemplate(templateId);
  if (!template) return skip(g, 'NO_TEMPLATE');

  const acc = getZaloAccount(thread.account_id);
  if (!acc) return skip(g, 'NICK_GONE');
  // ── nick-level gates: the greeting stays pending and retries next tick ──
  if (blockedNicks.has(acc.id)) return wait(g, 'WAIT_NICK');
  const blockNick = (reason: string): Outcome => { blockedNicks.add(acc.id); return wait(g, reason); };
  if (!acc.chat_enabled) return blockNick('WAIT_CHAT_DISABLED');
  if (!deps.pool.getApi(acc.id)) return blockNick('WAIT_NOT_CONNECTED');
  const day = dayBoundsUtc(spec.timezone, now);
  const sentToday = countZaloBirthdaySentBetween(acc.id, Math.floor(day.start.getTime() / 1000), Math.floor(day.end.getTime() / 1000));
  if (sentToday >= cfg.perNickDailyQuota) return blockNick('WAIT_QUOTA');
  if (deps.sender.bulkBudgetRemaining(acc.id) <= 0) return blockNick('WAIT_BULK_BUDGET');

  // ── content ──
  const vars = buildTemplateVars({
    threadName: thread.name,
    threadType: 'user',
    accountName: acc.display_name || acc.label,
    now,
    timezone: spec.timezone,
  });
  // Greeting for the birthday itself, so the age is the one being celebrated.
  const age = thread.birth_date ? ageOnBirthday(thread.birth_date, g.birthday_on) : null;
  if (age !== null) vars.age = String(age);
  const rendered = renderTemplate({ text: template.text, styles: template.styles }, vars, { rng: rt.rng });
  const attachments: ZaloAttachment[] = [];
  for (const a of template.attachments) {
    if (fs.existsSync(a.path)) attachments.push({ path: a.path, kind: a.kind, name: a.name });
    else logger.warn({ greetingId: g.id, path: a.path }, 'birthday template attachment missing on disk');
  }
  const steps: Step[] = [];
  if (rendered.text.trim()) steps.push({ text: rendered.text, styles: rendered.styles });
  if (attachments.length > 0) steps.push({ attachments });
  if (steps.length === 0) return skip(g, 'TEMPLATE_EMPTY');

  // ── send, resuming after the last delivered step ──
  const messageIds = parseIds(g.message_ids);
  let done = Math.min(g.sent_steps, steps.length);
  for (let i = done; i < steps.length; i++) {
    if (i > done) await rt.sleep(Math.round(STEP_GAP_MIN_MS + rt.rng() * (STEP_GAP_MAX_MS - STEP_GAP_MIN_MS)));
    try {
      const res = await deps.sender.sendRich({
        threadId: thread.id,
        text: steps[i].text,
        styles: steps[i].styles,
        attachments: steps[i].attachments,
        senderType: 'broadcast',
        bulk: true,
      });
      messageIds.push(...res.messageIds);
      done = i + 1;
      updateZaloBirthdayGreeting(g.id, { sentSteps: done, messageIds, accountId: acc.id });
    } catch (err) {
      const code = (err as { code?: string })?.code ?? '';
      if (NICK_LEVEL_CODES.has(code)) return blockNick(`WAIT_${code}`);
      const errorCode = classifyZaloError(err);
      updateZaloBirthdayGreeting(g.id, { state: 'failed', errorCode, skipReason: '' });
      logger.warn({ greetingId: g.id, threadId: thread.id, errorCode, err: String((err as Error)?.message ?? err) }, 'birthday greeting failed');
      return 'failed';
    }
  }
  updateZaloBirthdayGreeting(g.id, {
    state: 'sent', sentAt: Math.floor(now.getTime() / 1000), skipReason: '', errorCode: '',
  });
  return 'sent';
}

/** One sender pass. Exported for tests; the worker calls it every minute. */
export async function runBirthdaySenderTick(
  deps: MarketingDeps,
  rt: BirthdayRuntime = {},
): Promise<{ sent: number; failed: number; skipped: number; waiting: number }> {
  const sleep = rt.sleep ?? defaultSleep;
  const rng = rt.rng ?? Math.random;
  const result = { sent: 0, failed: 0, skipped: 0, waiting: 0 };
  const cfg = getZaloBirthdayConfig();
  const now = (rt.now ?? (() => new Date()))();
  const blocked = new Set<string>();
  let attempts = 0;
  for (const due of listDueZaloBirthdayGreetings(Math.floor(now.getTime() / 1000), DUE_SCAN_LIMIT)) {
    if (rt.isStopped?.() || attempts >= MAX_ATTEMPTS_PER_TICK) break;
    // Re-read: the dashboard may have skipped or re-queued it since the scan.
    const g = getZaloBirthdayGreeting(due.id);
    if (!g || g.state !== 'pending') continue;
    const outcome = await processGreeting(deps, cfg, g, blocked, { sleep, rng }, (rt.now ?? (() => new Date()))());
    result[outcome === 'waiting' ? 'waiting' : outcome]++;
    if (outcome === 'sent' || outcome === 'failed') {
      attempts++;
      // Random gap between recipients; the next tick is at least a minute away.
      await sleep(randomGapMs(cfg, rng));
    }
  }
  return result;
}

// ── Backfill ─────────────────────────────────────────────────────────

/** Look up birth dates of 1-1 threads that have none. Reading profiles is not sending, but still budgeted. */
export async function runBirthdayBackfill(
  deps: MarketingDeps,
  rt: BirthdayRuntime = {},
): Promise<{ looked: number; found: number }> {
  const sleep = rt.sleep ?? defaultSleep;
  const now = (rt.now ?? (() => new Date()))();
  const nowSec = Math.floor(now.getTime() / 1000);
  const dayStartSec = Math.floor(dayBoundsUtc(safeTimezone(getZaloBirthdayConfig().timezone), now).start.getTime() / 1000);
  let looked = 0;
  let found = 0;
  for (const acc of listZaloAccounts()) {
    if (rt.isStopped?.()) break;
    if (!deps.pool.getApi(acc.id)) continue;
    const budget = Math.min(BACKFILL_BATCH, BACKFILL_DAILY_CAP - countZaloBirthDateChecksSince(acc.id, dayStartSec));
    if (budget <= 0) continue;
    for (const cand of listZaloBirthDateBackfillCandidates(acc.id, nowSec - BACKFILL_RECHECK_SEC, budget)) {
      if (rt.isStopped?.()) break;
      if (!deps.sender.tryConsume(acc.id, 'query')) break;
      const api = deps.pool.getApi(acc.id);
      if (!api) break;
      try {
        const res = await api.getUserInfo(cand.external_id);
        const profiles = ((res as { changed_profiles?: Record<string, Record<string, unknown>> })?.changed_profiles) ?? {};
        const p = profiles[cand.external_id] ?? profiles[`${cand.external_id}_0`];
        const birth = p ? parseProfileBirthDate(p.sdob, p.dob, now) : null;
        if (noteZaloThreadBirthDate(cand.id, birth)) found++;
        looked++;
      } catch (err) {
        // Not "checked for a month": a network blip should retry tomorrow.
        markZaloBirthDateChecked(cand.id, nowSec - BACKFILL_RECHECK_SEC + BACKFILL_ERROR_RETRY_SEC);
        logger.warn({ accountId: acc.id, threadId: cand.id, err: String(err) }, 'birthday profile lookup failed');
      }
      await sleep(BACKFILL_GAP_MS);
    }
  }
  return { looked, found };
}

// ── Upcoming view (dashboard) ────────────────────────────────────────

export type UpcomingState = 'planned' | 'inactive' | 'missed' | 'pending' | 'sent' | 'failed' | 'skipped';

export interface UpcomingOccasion {
  occasion: ZaloBirthdayOccasion;
  /** 'YYYY-MM-DD' the greeting is (or was) due. */
  sendOn: string;
  state: UpcomingState;
  greetingId: number | null;
  skipReason: string;
}

export interface UpcomingBirthday {
  threadId: number;
  name: string;
  accountId: string;
  /** 'YYYY-MM-DD' of the birthday as celebrated this time (29 Feb → 28 Feb in common years). */
  birthdayOn: string;
  daysUntil: number;
  age: number | null;
  occasions: UpcomingOccasion[];
}

/** Birthdays from `afterDays` ago (if the "after" occasion is on) through `days` ahead, with each occasion's state. */
export function listUpcomingBirthdays(now: Date = new Date(), days = 14): UpcomingBirthday[] {
  const cfg = getZaloBirthdayConfig();
  const spec = specOf(cfg);
  const today = calendarDateUtc(zonedDateParts(now, spec.timezone));
  const todayStr = formatCalendarDate(today);
  const start = addDays(today, cfg.afterEnabled ? -cfg.afterDays : 0);
  const end = addDays(today, days - 1);
  const greetings = new Map<string, ZaloBirthdayGreetingRow>();
  for (const g of listZaloBirthdayGreetingsByBirthday(formatCalendarDate(start), formatCalendarDate(end))) {
    greetings.set(`${g.thread_id}|${g.occasion}|${g.birthday_on}`, g);
  }
  const out: UpcomingBirthday[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = addDays(d, 1)) {
    const birthdayOn = formatCalendarDate(d);
    for (const t of findZaloBirthdayThreads(monthDaysFor(d), cfg.accountIds, MAX_GREETINGS_PER_DAY)) {
      const occasions: UpcomingOccasion[] = [];
      for (const occasion of BIRTHDAY_OCCASIONS) {
        if (!isOccasionEnabled(spec, occasion)) continue;
        const sendOn = formatCalendarDate(addDays(d, -occasionOffsetDays(spec, occasion)));
        const g = greetings.get(`${t.id}|${occasion}|${birthdayOn}`);
        let state: UpcomingState;
        if (g) state = g.state;
        else if (!cfg.enabled || templateIdFor(cfg, occasion) === null) state = 'inactive';
        else state = sendOn < todayStr ? 'missed' : 'planned';
        occasions.push({ occasion, sendOn, state, greetingId: g?.id ?? null, skipReason: g?.skip_reason ?? '' });
      }
      out.push({
        threadId: t.id,
        name: t.name,
        accountId: t.account_id,
        birthdayOn,
        daysUntil: Math.round((d.getTime() - today.getTime()) / 86_400_000),
        age: t.birth_date ? ageOnBirthday(t.birth_date, birthdayOn) : null,
        occasions,
      });
    }
  }
  return out;
}

/** True when `birthdayOn` is the date `birthDate` is celebrated on in that year (routes use it to validate on-demand rows). */
export function celebratedOnFor(birthDate: string, birthdayOn: string): boolean {
  return celebratedOn(birthDate, Number(birthdayOn.slice(0, 4))) === birthdayOn;
}

// ── Worker ───────────────────────────────────────────────────────────

export function startBirthdayWorker(deps: MarketingDeps): WorkerHandle {
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  const sleepers = new Set<() => void>();
  // Interruptible, so shutdown does not wait out a 90 s gap.
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); sleepers.delete(done); resolve(); };
    const t = setTimeout(done, ms);
    sleepers.add(done);
  });
  const rt: BirthdayRuntime = { sleep, isStopped: () => stopped };

  const guarded = (name: string, fn: () => Promise<void> | void) => {
    let running = false;
    return async () => {
      if (running || stopped) return;
      running = true;
      try { await fn(); } catch (err) { logger.warn({ err: String(err) }, `birthday ${name} failed`); } finally { running = false; }
    };
  };

  const plan = guarded('planner', () => {
    const r = planBirthdayGreetings();
    if (r.created > 0) logger.info(r, 'birthday greetings planned');
  });
  const send = guarded('sender', async () => {
    const r = await runBirthdaySenderTick(deps, rt);
    if (r.sent + r.failed > 0) logger.info(r, 'birthday greetings sent');
  });
  const backfill = guarded('backfill', async () => {
    const r = await runBirthdayBackfill(deps, rt);
    if (r.looked > 0) logger.info(r, 'birthday backfill');
  });

  const every = (fn: () => Promise<void>, ms: number, firstMs: number) => {
    const first = setTimeout(() => void fn(), firstMs);
    first.unref?.();
    const iv = setInterval(() => void fn(), ms);
    iv.unref?.();
    timers.push(first, iv);
  };
  every(plan, PLAN_INTERVAL_MS, 20_000);
  every(send, SEND_INTERVAL_MS, 40_000);
  // Backfill waits for the nicks to finish reconnecting after a boot.
  every(backfill, BACKFILL_INTERVAL_MS, 3 * 60_000);

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      for (const wake of [...sleepers]) wake();
    },
  };
}
