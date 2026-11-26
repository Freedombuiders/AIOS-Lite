// T07: pure presentation logic of the bot column and the list rows. No DOM, no fetch (botView.test.ts covers it).
//
// Two sets of modes exist on purpose and are named once here, in Vietnamese, for the whole screen:
//   - the rules (`care_assignments.mode`, "cả nick" and the per-conversation rule): observe / draft / auto
//   - the per-conversation switch (`PUT /conversations/:id/ai`):                      off / draft / auto

import type { CareAiMode, CareAssignmentMode, CareBotLabel, CareBotPanelDto, CareBotSettingsDto, CareBotStateDto } from '@modules/care/server/api/dto-inbox';
import type { CareRunDto } from '@modules/care/server/api/dto-ops';
import { clockTime } from './timeFormat';
import { ct } from './i18n';

export type BotTone = 'review' | 'active' | 'yielded' | 'handoff' | 'none';

/** The one state label of a list row: its words and tone (the server decides which; the browser only names it). */
export function stateChip(label: CareBotLabel | undefined): { text: string; tone: BotTone } | null {
  if (!label) return null;
  return { text: ct(`bot.state.${label}`), tone: label };
}

// ── modes ─────────────────────────────────────────────────────────────────────────────────────
export type PanelScope = 'account' | 'conversation';
/** Whole nick: the rule's own modes. */
export const ACCOUNT_MODES: readonly CareAssignmentMode[] = ['observe', 'draft', 'auto'];
/** This conversation: the per-conversation switch. */
export const CONVERSATION_MODES: readonly CareAiMode[] = ['off', 'draft', 'auto'];

export type AnyMode = CareAssignmentMode | CareAiMode;

export function modeLabel(mode: AnyMode): string {
  return ct(`bot.mode.${mode}`);
}

/** One sentence under the mode switch: what the chosen mode does, in this scope. */
export function modeNote(scope: PanelScope, mode: AnyMode): string {
  return ct(`bot.modeNote.${scope}.${mode}`);
}

export function modesFor(scope: PanelScope): readonly AnyMode[] {
  return scope === 'account' ? ACCOUNT_MODES : CONVERSATION_MODES;
}

/** The mode currently set in a scope, as the switch shows it (null = the scope has no setting of its own). */
export function currentMode(scope: PanelScope, panel: CareBotPanelDto): AnyMode | null {
  if (scope === 'account') return panel.accountRule?.mode ?? null;
  return panel.aiMode;
}

// ── pause ─────────────────────────────────────────────────────────────────────────────────────
export const PAUSE_CHOICES: ReadonlyArray<{ minutes: 30 | 120 | null; key: string }> = [
  { minutes: 30, key: 'bot.pause.m30' },
  { minutes: 120, key: 'bot.pause.h2' },
  { minutes: null, key: 'bot.pause.open' },
];

export function pauseText(state: Pick<CareBotStateDto, 'paused' | 'pausedUntilMs'>): string | null {
  if (!state.paused) return null;
  return state.pausedUntilMs === null ? ct('bot.pause.openEnded') : ct('bot.pause.until', { time: clockTime(state.pausedUntilMs) });
}

// ── handoff ───────────────────────────────────────────────────────────────────────────────────
export function handoffText(h: NonNullable<CareBotStateDto['handoff']>): string {
  return h.keyword ? ct('bot.handoff.body', { keyword: h.keyword, time: clockTime(h.atMs) }) : ct('bot.handoff.bodyNoKeyword', { time: clockTime(h.atMs) });
}

export function yieldText(state: CareBotStateDto, humanPauseMinutes: number | null = state.humanPauseMinutes): string | null {
  if (state.label !== 'yielded' || !state.yieldReason) return null;
  if (state.yieldReason === 'human_reply') return ct('bot.yield.human_reply', { n: humanPauseMinutes ?? 30 });
  if (state.yieldReason === 'paused') return pauseText(state);
  return ct('bot.yield.taken_over');
}

// ── agent run log ─────────────────────────────────────────────────────────────────────────────
/** A skip / failure reason code in words. A code this build does not know is shown as the code (botView.test.ts keeps that from happening). */
export function skipReasonText(reason: string | null | undefined): string {
  if (!reason) return '';
  const key = `skip.${reason}`;
  const v = ct(key);
  return v === key ? reason : v;
}

export type RunTone = 'ok' | 'warn' | 'muted' | 'error';

export function runLine(run: Pick<CareRunDto, 'status' | 'skipReason' | 'mode' | 'triggerKind'>): { text: string; tone: RunTone } {
  switch (run.status) {
    case 'drafted':
      if (run.triggerKind === 'manual') return { text: ct('bot.log.draftedManual'), tone: 'warn' };
      return run.mode === 'auto' ? { text: ct('bot.log.draftedAuto'), tone: 'ok' } : { text: ct('bot.log.drafted'), tone: 'warn' };
    case 'skipped':
      return { text: ct('bot.log.skipped', { why: skipReasonText(run.skipReason) }), tone: 'muted' };
    case 'failed':
      return { text: ct('bot.log.failed', { why: skipReasonText(run.skipReason) }), tone: 'error' };
    default:
      return { text: ct('bot.log.running'), tone: 'muted' };
  }
}

/** Time of a run line: `09:41`. */
export const runTime = (run: Pick<CareRunDto, 'createdAtMs'>): string => clockTime(run.createdAtMs);

// ── rules read from the real settings ─────────────────────────────────────────────────────────
export interface RuleLine { id: string; text: string; tone?: 'warn' }

export function ruleLines(panel: Pick<CareBotPanelDto, 'rules'>): RuleLine[] {
  const { settings, maxRepliesPerThreadDay, humanPauseMinutes } = panel.rules;
  if (!settings) return [{ id: 'unreadable', text: ct('bot.rules.unreadable') }];
  return settingsLines(settings, maxRepliesPerThreadDay, humanPauseMinutes);
}

export function settingsLines(s: CareBotSettingsDto, maxRepliesPerThreadDay: number | null, humanPauseMinutes: number | null): RuleLine[] {
  const lines: RuleLine[] = [];
  if (!s.aiEnabled) lines.push({ id: 'aiOff', text: ct('bot.rules.aiOff'), tone: 'warn' });
  lines.push(s.turnDebounceSeconds > 0
    ? { id: 'debounce', text: ct('bot.rules.debounce', { n: s.turnDebounceSeconds }) }
    : { id: 'debounce', text: ct('bot.rules.debounceOff') });
  if (humanPauseMinutes !== null) lines.push({ id: 'human', text: humanPauseMinutes > 0 ? ct('bot.rules.human', { n: humanPauseMinutes }) : ct('bot.rules.humanOff') });
  lines.push(s.handoffKeywords.length > 0
    ? { id: 'handoff', text: ct('bot.rules.handoff', { keywords: s.handoffKeywords.map((k) => `“${k}”`).join(', '), n: s.handoffPauseMinutes }) }
    : { id: 'handoff', text: ct('bot.rules.handoffOff') });
  if (maxRepliesPerThreadDay !== null) lines.push({ id: 'cap', text: ct('bot.rules.cap', { n: maxRepliesPerThreadDay }) });
  lines.push({ id: 'quiet', text: ct('bot.rules.quiet', { start: s.quietHoursStart, end: s.quietHoursEnd }) });
  lines.push(s.autoSendEnabled ? { id: 'auto', text: ct('bot.rules.autoOn') } : { id: 'auto', text: ct('bot.rules.autoOff'), tone: 'warn' });
  return lines;
}

// ── draft: "Bot dừng lại vì ..." ──────────────────────────────────────────────────────────────
export function draftStopText(stop: { codes: string[]; detail: string | null } | null | undefined): string | null {
  if (!stop || stop.codes.length === 0) return null;
  const code = stop.codes[0]!;
  const key = `bot.draftStop.${code}`;
  const base = ct(key, { detail: stop.detail ?? '' });
  if (base === key) return null;
  return stop.detail && code === 'needs_review' ? `${base} “${stop.detail}”` : base;
}
