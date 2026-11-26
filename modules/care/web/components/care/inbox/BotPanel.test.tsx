import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toasts } from '@/lib/toasts';
import { bot, panel, run } from '@modules/care/web/lib/care/bot.test-util';
import { convWithBot } from '@modules/care/web/lib/care/bot.test-util';
import type { CareBotPanelDto } from '@modules/care/server/api/dto-inbox';

const api = vi.hoisted(() => ({
  botPanel: vi.fn(), runs: vi.fn(), setAiMode: vi.fn(), saveRule: vi.fn(), deleteRule: vi.fn(), setPause: vi.fn(), resume: vi.fn(), setTakeover: vi.fn(),
}));
vi.mock('@modules/care/web/lib/care/client', () => ({ careApi: api, CARE_API_BASE: '/api/m/care' }));

import { BotPanel } from './BotPanel';

const host = document.createElement('div'); document.body.append(host);
const AGENTS = [
  { id: 'cskh', name: 'Bot CSKH', enabled: true, careScopes: ['inbox.read', 'reply.draft'] },
  { id: 'tro-ly', name: 'Bot Trợ lý', enabled: true, careScopes: ['reply.draft', 'reply.send'] },
  { id: 'no-scope', name: 'Không có quyền', enabled: true, careScopes: ['inbox.read'] },
  { id: 'off', name: 'Đã tắt', enabled: false, careScopes: ['reply.draft'] },
];
const ACCOUNTS = [{ id: 'a1', label: 'Nick Trà Sen Việt' }] as never;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const onConversation = vi.fn();

async function open(p: CareBotPanelDto = panel(), runs = [run()]) {
  api.botPanel.mockResolvedValue(p);
  api.runs.mockResolvedValue({ items: runs, nextCursor: null });
  act(() => render(<BotPanel conversationId="c1" accounts={ACCOUNTS} agents={AGENTS} convTick={0} resyncTick={0} onConversation={onConversation} />, host));
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  toasts.value = [];
  const conv = convWithBot('active');
  for (const k of ['setAiMode', 'setPause', 'resume', 'setTakeover']) (api as Record<string, ReturnType<typeof vi.fn>>)[k]!.mockResolvedValue(conv);
  api.saveRule.mockResolvedValue({ id: 'r-acct' });
  api.deleteRule.mockResolvedValue({ ok: true });
});
afterEach(() => { act(() => render(null, host)); });

describe('BotPanel: bot, scope and modes', () => {
  it('offers only enabled agents that hold the care scope reply.draft', async () => {
    await open();
    const options = [...(q('care-bot-agent') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(['Bot CSKH', 'Bot Trợ lý', 'Không gán bot']);
  });

  it('whole nick: the three modes are the rule modes (Chỉ theo dõi / Soạn nháp / Tự trả lời) and a pick updates the nick rule', async () => {
    await open();
    expect(q('care-bot-scope-account')?.getAttribute('aria-pressed')).toBe('true');
    expect(['observe', 'draft', 'auto'].map((m) => q(`care-bot-mode-${m}`)?.textContent)).toEqual(['Chỉ theo dõi', 'Soạn nháp', 'Tự trả lời']);
    expect(q('care-bot-mode-draft')?.getAttribute('aria-pressed')).toBe('true');
    act(() => q('care-bot-mode-auto')!.click());
    await flush();
    expect(api.saveRule).toHaveBeenCalledWith('r-acct', expect.objectContaining({ scope: 'account', accountId: 'a1', mode: 'auto', agentId: 'cskh', expectedConfigVersion: 3 }));
    expect(api.setAiMode).not.toHaveBeenCalled();
  });

  it('this conversation: the modes are the per-conversation switch (Tắt bot / Soạn nháp / Tự trả lời) on PUT /ai', async () => {
    await open();
    act(() => q('care-bot-scope-conversation')!.click());
    expect(['off', 'draft', 'auto'].map((m) => q(`care-bot-mode-${m}`)?.textContent)).toEqual(['Tắt bot', 'Soạn nháp', 'Tự trả lời']);
    act(() => q('care-bot-mode-off')!.click());
    await flush();
    expect(api.setAiMode).toHaveBeenCalledWith('c1', 'off');
    expect(api.saveRule).not.toHaveBeenCalled();
  });

  it('every mode change toasts "Hoàn tác" for five seconds, and Hoàn tác puts the old mode back', async () => {
    await open(panel({ aiMode: 'draft' })); // opens on this conversation: switch is "Soạn nháp"
    act(() => q('care-bot-mode-off')!.click());
    await flush();
    const toast = toasts.value.at(-1)!;
    expect(toast.title).toBe('Đã đổi chế độ: Tắt bot');
    expect(toast.ttlMs).toBe(5000);
    expect(toast.action?.label).toBe('Hoàn tác');
    await act(async () => { await toast.action!.onClick(); });
    expect(api.setAiMode).toHaveBeenLastCalledWith('c1', 'draft');
  });

  it('a nick-mode change can be undone by writing the old mode back', async () => {
    await open();
    act(() => q('care-bot-mode-auto')!.click());
    await flush();
    await act(async () => { await toasts.value.at(-1)!.action!.onClick(); });
    expect(api.saveRule).toHaveBeenLastCalledWith('r-acct', expect.objectContaining({ mode: 'draft', expectedConfigVersion: 4 }));
  });

  it('picking another bot for this conversation creates its own rule on the conversation key', async () => {
    await open(panel({ aiMode: 'draft' }));
    const sel = q('care-bot-agent') as HTMLSelectElement;
    await act(async () => { sel.value = 'tro-ly'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(api.saveRule).toHaveBeenCalledWith(null, expect.objectContaining({ scope: 'conversation', scopeTarget: 'peer:1', agentId: 'tro-ly', mode: 'draft' }));
  });

  it('says so when no agent can be a bot', async () => {
    api.botPanel.mockResolvedValue(panel());
    api.runs.mockResolvedValue({ items: [], nextCursor: null });
    act(() => render(<BotPanel conversationId="c1" accounts={ACCOUNTS} agents={[AGENTS[2]!]} convTick={0} resyncTick={0} onConversation={onConversation} />, host));
    await flush();
    expect(q('care-bot-noagents')?.textContent).toContain('Chưa có bot nào dùng được');
  });
});

describe('BotPanel: timed pause', () => {
  it('has 30 phút, 2 giờ and Đến khi bật lại, each calling the pause route with its length', async () => {
    await open();
    expect(['30', '120', 'open'].map((m) => q(`care-pause-${m}`)?.textContent?.trim())).toEqual(['Dừng 30 phút', 'Dừng 2 giờ', 'Đến khi bật lại']);
    act(() => q('care-pause-30')!.click()); await flush();
    expect(api.setPause).toHaveBeenLastCalledWith('c1', 30);
    act(() => q('care-pause-120')!.click()); await flush();
    expect(api.setPause).toHaveBeenLastCalledWith('c1', 120);
    act(() => q('care-pause-open')!.click()); await flush();
    expect(api.setPause).toHaveBeenLastCalledWith('c1', null);
    expect(toasts.value.at(-1)?.action?.label).toBe('Hoàn tác');
  });

  it('while paused it says until when and offers "Bật lại bot", which resumes', async () => {
    await open(panel({ state: { label: 'yielded', yieldReason: 'paused', paused: true, pausedUntilMs: Date.now() + 25 * 60_000 } }));
    expect(q('care-pause-status')?.textContent).toMatch(/Tạm dừng đến \d{2}:\d{2}/);
    act(() => q('care-pause-resume')!.click()); await flush();
    expect(api.resume).toHaveBeenCalledWith('c1');
    expect(q('care-bot-state')?.textContent).toBe('Bot nhường bạn');
  });

  it('there is no resume button while the bot is not paused', async () => {
    await open();
    expect(q('care-pause-resume')).toBeNull();
  });
});

describe('BotPanel: handoff banner', () => {
  const handedOff = () => panel({ state: { label: 'handoff', paused: true, pausedUntilMs: Date.now() + 40 * 60_000, handoff: { atMs: Date.now() - 20 * 60_000, keyword: 'khiếu nại' } }, takenOver: true });

  it('is clear about the customer asking for a person and that only the owner hands the chat back', async () => {
    await open(handedOff());
    const banner = q('care-handoff-banner')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('Khách đòi gặp người thật');
    expect(banner.textContent).toContain('“khiếu nại”');
    expect(banner.textContent).toContain('Chỉ bạn trả lại được cho bot');
    expect(q('care-bot-state')?.textContent).toBe('Chuyển cho bạn');
  });

  it('"Giao lại cho bot" uses the owner take-over switch (off), which also lifts the pause the handoff set', async () => {
    await open(handedOff());
    act(() => q('care-handoff-giveback')!.click()); await flush();
    expect(api.setTakeover).toHaveBeenCalledWith('c1', false);
    expect(toasts.value.at(-1)?.title).toBe('Đã giao lại cho bot');
  });

  it('there is no banner without a handoff', async () => {
    await open();
    expect(q('care-handoff-banner')).toBeNull();
  });
});

describe('BotPanel: rules, run log, group', () => {
  it('lists the rules read from the settings', async () => {
    await open();
    const ids = [...host.querySelectorAll('[data-testid="care-bot-rules"] li')].map((li) => li.getAttribute('data-rule'));
    expect(ids).toEqual(['debounce', 'human', 'handoff', 'cap', 'quiet', 'auto']);
  });

  it('the run log writes each skip reason in Vietnamese, never the code', async () => {
    await open(panel(), [
      run({ id: 'r1', skipReason: 'media_needs_owner' }),
      run({ id: 'r2', skipReason: 'human_active' }),
      run({ id: 'r3', status: 'drafted', skipReason: null }),
    ]);
    const text = q('care-run-log')!.textContent!;
    expect(text).toContain('Bỏ qua: Khách chỉ gửi ảnh hoặc PDF mà bot không đọc được, để bạn xử lý.');
    expect(text).toContain('Bỏ qua: Bạn vừa trả lời nên bot nhường.');
    expect(text).toContain('Soạn nháp, chờ bạn duyệt');
    expect(text).not.toContain('media_needs_owner');
    expect(text).not.toContain('human_active');
  });

  it('a group conversation: history only, the panel is replaced by "Bot không trả lời trong nhóm"', async () => {
    await open(panel({ kind: 'group', state: bot({ label: 'none' }) }));
    expect(q('care-bot-group')?.textContent).toContain('Bot không trả lời trong nhóm');
    expect(q('care-bot-modes')).toBeNull();
    expect(q('care-bot-agent')).toBeNull();
  });
});
