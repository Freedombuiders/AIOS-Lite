import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_TURN_REASONS } from '@modules/care/server/application/agent-reasons';
import { DRAFT_STOP_CODES } from '@modules/care/server/api/draft-stop';
import { ELIGIBILITY_REASONS } from '@modules/care/server/policy/eligibility';
import en from '@/locales/en.json';
import vi from '@/locales/vi.json';
import { bot, panel, run } from './bot.test-util';
import {
  ACCOUNT_MODES, CONVERSATION_MODES, PAUSE_CHOICES, draftStopText, handoffText, modeLabel, modeNote, ruleLines, runLine, skipReasonText, stateChip, yieldText,
} from './botView';
import { defaultScope, ruleBody } from './useBotPanel';

const lookup = (dict: unknown, path: string): unknown => path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), dict);

describe('state label', () => {
  it('names each of the five server labels in Vietnamese', () => {
    expect(stateChip('review')?.text).toBe('Chờ bạn duyệt');
    expect(stateChip('active')?.text).toBe('Bot đang chăm');
    expect(stateChip('yielded')?.text).toBe('Bot nhường bạn');
    expect(stateChip('handoff')?.text).toBe('Chuyển cho bạn');
    expect(stateChip('none')?.text).toBe('Chưa gán bot');
    expect(stateChip(undefined)).toBeNull(); // an older server sends no label: no chip, nothing computed here
  });
});

describe('modes keep the backend names', () => {
  it('rule modes are observe / draft / auto, the per-conversation switch is off / draft / auto', () => {
    expect(ACCOUNT_MODES).toEqual(['observe', 'draft', 'auto']);
    expect(CONVERSATION_MODES).toEqual(['off', 'draft', 'auto']);
  });

  it('one Vietnamese word per mode, shared by both scopes', () => {
    expect(modeLabel('observe')).toBe('Chỉ theo dõi');
    expect(modeLabel('draft')).toBe('Soạn nháp');
    expect(modeLabel('auto')).toBe('Tự trả lời');
    expect(modeLabel('off')).toBe('Tắt bot');
    for (const m of ACCOUNT_MODES) expect(modeNote('account', m)).not.toMatch(/^bot\.modeNote/);
    for (const m of CONVERSATION_MODES) expect(modeNote('conversation', m)).not.toMatch(/^bot\.modeNote/);
  });

  it('the three pause buttons: 30 phút, 2 giờ, đến khi bật lại', () => {
    expect(PAUSE_CHOICES.map((c) => c.minutes)).toEqual([30, 120, null]);
  });
});

describe('rule bodies written from the panel', () => {
  it('updates the existing nick rule in place with its config version, changing only the mode', () => {
    const b = ruleBody('account', panel(), { mode: 'auto' });
    expect(b).toMatchObject({ scope: 'account', accountId: 'a1', scopeTarget: null, mode: 'auto', agentId: 'cskh', enabled: true, priority: 100, expectedConfigVersion: 3 });
  });
  it('a new conversation rule targets the conversation key and starts as a draft', () => {
    const b = ruleBody('conversation', panel(), { agentId: 'tro-ly' });
    expect(b).toMatchObject({ scope: 'conversation', scopeTarget: 'peer:1', mode: 'draft', agentId: 'tro-ly', enabled: true });
    expect(b.expectedConfigVersion).toBeUndefined();
  });
  it('opens on this conversation when it already has its own rule or switch', () => {
    expect(defaultScope(panel())).toBe('account');
    expect(defaultScope(panel({ aiMode: 'off' }))).toBe('conversation');
    expect(defaultScope(panel({ aiMode: 'auto' }))).toBe('account'); // auto = follows the nick
  });
});

describe('handoff and pause wording', () => {
  it('names the keyword and says only the owner hands back', () => {
    const t = handoffText({ atMs: Date.UTC(2026, 10, 26, 2, 30), keyword: 'gặp nhân viên' });
    expect(t).toContain('“gặp nhân viên”');
    expect(t).toContain('Chỉ bạn trả lại được cho bot');
  });
  it('explains why the bot stepped back', () => {
    expect(yieldText(bot({ label: 'yielded', yieldReason: 'human_reply', humanPauseMinutes: 30 }))).toBe('Bạn vừa nhắn, bot nhường cuộc chat này 30 phút.');
    expect(yieldText(bot({ label: 'yielded', yieldReason: 'taken_over' }))).toContain('tiếp quản');
    expect(yieldText(bot({ label: 'yielded', yieldReason: 'paused', paused: true, pausedUntilMs: null }))).toContain('đến khi bạn bật lại');
    expect(yieldText(bot())).toBeNull();
  });
});

describe('rules come from the real settings', () => {
  it('lists debounce, human window, handoff phrases, daily cap, quiet hours and the auto-send switch', () => {
    const ids = ruleLines(panel()).map((l) => l.id);
    expect(ids).toEqual(['debounce', 'human', 'handoff', 'cap', 'quiet', 'auto']);
    const text = ruleLines(panel()).map((l) => l.text).join('\n');
    expect(text).toContain('Chờ 3 giây');
    expect(text).toContain('nhường 30 phút');
    expect(text).toContain('“gặp nhân viên”, “khiếu nại”');
    expect(text).toContain('dừng 60 phút');
    expect(text).toContain('Tối đa 30 câu');
    expect(text).toContain('22:00 đến 07:00');
    expect(text).toContain('Tự động gửi đang tắt');
  });
  it('turns the lines around when the settings are the other way', () => {
    const p = panel({ rules: { settings: { aiEnabled: false, autoSendEnabled: true, handoffKeywords: [], handoffPauseMinutes: 60, turnDebounceSeconds: 0, quietHoursStart: '23:00', quietHoursEnd: '06:00' }, maxRepliesPerThreadDay: null, humanPauseMinutes: null } });
    const lines = ruleLines(p);
    expect(lines.map((l) => l.id)).toEqual(['aiOff', 'debounce', 'handoff', 'quiet', 'auto']);
    expect(lines.find((l) => l.id === 'auto')?.text).toBe('Tự động gửi đang bật.');
  });
  it('says so when the settings could not be read', () => {
    expect(ruleLines(panel({ rules: { settings: null } }))[0]?.id).toBe('unreadable');
  });
});

describe('skip reasons are all translated (T07)', () => {
  // Every reason an agent run can store in skip_reason: the agent turn's own list (typed there: a new reason does not
  // compile until it is added to agent-reasons.ts) plus the eligibility reasons (which include the message gates).
  const REASONS = [...new Set<string>([...AGENT_TURN_REASONS, ...ELIGIBILITY_REASONS.filter((r) => (r as string) !== 'eligible')])];

  it('enumerates the reasons that exist in code', () => {
    expect(REASONS.length).toBeGreaterThanOrEqual(50);
    expect(REASONS).toEqual(expect.arrayContaining(['noise', 'media_needs_owner', 'conversation_paused', 'human_active', 'thread_quota', 'conversation_taken_over', 'agent_scope_missing', 'invalid_output']));
  });

  it('has a Vietnamese line, and an English one, for every reason', () => {
    const missing = REASONS.filter((r) => typeof lookup(vi, `care.skip.${r}`) !== 'string' || typeof lookup(en, `care.skip.${r}`) !== 'string');
    expect(missing).toEqual([]);
    const raw = REASONS.filter((r) => skipReasonText(r) === r);
    expect(raw).toEqual([]);
  });

  it('keeps no line for a reason the code no longer has', () => {
    const dict = Object.keys((vi as unknown as { care: { skip: Record<string, string> } }).care.skip);
    expect(dict.filter((k) => !REASONS.includes(k))).toEqual([]);
  });

  it('every reason literal passed to skip(), fail() or finishSkip() in the agent turn is in the lists', () => {
    // The lists are enforced by the compiler, this reads the source so a loosened type still fails here.
    const src = readFileSync(join(process.cwd(), 'modules/care/server/application/agent-turn.ts'), 'utf8');
    const found = new Set<string>();
    for (const m of src.matchAll(/\b(?:skip|fail)\(\s*'([a-z_]+)'/g)) found.add(m[1]!);
    for (const m of src.matchAll(/finishSkip\(\s*finish,\s*'([a-z_]+)'/g)) found.add(m[1]!);
    for (const m of src.matchAll(/\?\s*'([a-z_]+)'\s*:\s*(?:controlAfter|null)/g)) found.add(m[1]!);
    expect(found.size).toBeGreaterThan(10);
    expect([...found].filter((r) => !REASONS.includes(r))).toEqual([]);
  });

  it('a code this build does not know is shown as the code, never as a blank', () => {
    expect(skipReasonText('brand_new_reason')).toBe('brand_new_reason');
    expect(skipReasonText(null)).toBe('');
  });

  it('draft stop codes are all translated too', () => {
    const missing = DRAFT_STOP_CODES.filter((c) => typeof lookup(vi, `care.bot.draftStop.${c}`) !== 'string' || typeof lookup(en, `care.bot.draftStop.${c}`) !== 'string');
    expect(missing).toEqual([]);
    expect(draftStopText({ codes: ['review_keyword'], detail: 'giảm giá' })).toBe('câu có từ khoá cần duyệt “giảm giá”');
    expect(draftStopText({ codes: ['needs_review'], detail: 'có con số giảm giá' })).toBe('bot thấy câu này cần bạn xem trước “có con số giảm giá”');
    expect(draftStopText({ codes: ['draft_mode'], detail: null })).toContain('Soạn nháp');
    expect(draftStopText(null)).toBeNull();
  });
});

describe('run log lines', () => {
  it('puts the translated reason in a skipped or failed run', () => {
    expect(runLine(run({ status: 'skipped', skipReason: 'media_needs_owner' })).text).toBe('Bỏ qua: Khách chỉ gửi ảnh hoặc PDF mà bot không đọc được, để bạn xử lý.');
    expect(runLine(run({ status: 'failed', skipReason: 'timeout' }))).toEqual({ text: 'Lỗi: Bot trả lời quá lâu.', tone: 'error' });
  });
  it('says what a drafted run means for each mode and trigger', () => {
    expect(runLine(run({ status: 'drafted', skipReason: null, mode: 'draft' })).text).toBe('Soạn nháp, chờ bạn duyệt');
    expect(runLine(run({ status: 'drafted', skipReason: null, mode: 'auto' })).text).toContain('tự gửi');
    expect(runLine(run({ status: 'drafted', skipReason: null, triggerKind: 'manual' })).text).toBe('Soạn nháp theo lời nhờ của bạn');
    expect(runLine(run({ status: 'running', skipReason: null })).text).toBe('Đang soạn…');
  });
});
