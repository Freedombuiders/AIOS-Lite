// Đội AI · Bot screen: empty state, add a bot with a probe before saving, key status, card actions.
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenbotBot, GenbotOverview } from '@/lib/genbot';

const api = vi.hoisted(() => ({
  overview: vi.fn(),
  guide: vi.fn(async () => ({ markdown: '# Hướng dẫn' })),
  saveConnection: vi.fn(),
  checkConnection: vi.fn(),
  probe: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  setKey: vi.fn(),
  check: vi.fn(),
  pause: vi.fn(),
  remove: vi.fn(),
  convert: vi.fn(),
}));
const pushToast = vi.hoisted(() => vi.fn());

vi.mock('@/lib/genbot', async (orig) => ({ ...(await orig<typeof import('@/lib/genbot')>()), genbotApi: api }));
vi.mock('@/lib/toasts', () => ({ pushToast }));

import BotsPage from './BotsPage';

const TEMPLATES: GenbotOverview['templates'] = [
  { id: 'cskh', label: 'CSKH Zalo', hint: 'Soạn trả lời khách.', context: 'lean', brain: { read: ['san-pham/**', 'chinh-sach/**', 'giong-noi.md'], write: [] }, memory: { team: false, private: false }, modules: { care: ['reply.draft', 'reply.send'] } },
  { id: 'noi-dung', label: 'Nội dung', hint: 'Viết bài.', context: 'standard', brain: { read: ['giong-noi.md', 'noi-dung/**'], write: [] }, memory: { team: true, private: true }, modules: {} },
  { id: 'tro-ly', label: 'Trợ lý', hint: 'Trợ lý của chủ.', context: 'standard', brain: { read: ['**'], write: ['nho/**'] }, memory: { team: true, private: true }, modules: {} },
];

const bot = (over: Partial<GenbotBot> = {}): GenbotBot => ({
  id: 'bot-cskh', name: 'Bot CSKH', role: 'Trực Zalo', enabled: true, botId: 'bot_cskh', baseUrl: 'http://127.0.0.1:8800', connected: true,
  key: { hasKey: true, last4: 'WXYZ', source: 'store', updatedAt: null }, lastCheck: null, runsToday: 3, maxRunsDay: 500, context: 'lean',
  usedBy: ['Chăm khách: 2 phân công'], brain: [{ folder: 'tra-sen-viet', read: ['san-pham/**'], write: [] }], modules: { care: ['reply.draft'] },
  ...over,
});

const overview = (bots: GenbotBot[], legacy: GenbotOverview['legacy'] = []): GenbotOverview => ({
  baseUrl: 'http://127.0.0.1:8800', defaultBaseUrl: 'http://127.0.0.1:8800', bots, legacy, templates: TEMPLATES, brainFolders: [{ id: 'tra-sen-viet', name: 'Trà Sen Việt' }],
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

async function mount() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(() => render(<BotsPage />, el));
  await flush();
  return el;
}

const buttons = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim().includes(text));
const button = (root: ParentNode, text: string) => {
  const b = buttons(root, text)[0];
  if (!b) throw new Error(`no button "${text}"`);
  return b as HTMLButtonElement;
};
const click = async (b: HTMLElement) => { await act(() => { b.click(); }); await flush(); };
function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const dialog = () => document.body.querySelector('[role="dialog"]') ?? document.body;

describe('Đội AI · Bot screen', () => {
  beforeEach(() => {
    for (const f of Object.values(api)) f.mockReset();
    api.guide.mockResolvedValue({ markdown: '# Hướng dẫn' });
    pushToast.mockClear();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('empty state: the how-to, the one-bot-per-company line and "Thêm bot GenBot"', async () => {
    api.overview.mockResolvedValue(overview([]));
    const el = await mount();
    const empty = el.querySelector('[data-testid="bots-empty"]')!;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain('Chưa có bot GenBot nào');
    expect(empty.textContent).toContain('Nâng cao › Truy cập');
    expect(empty.textContent).toContain('Bật Bot API');
    expect(buttons(empty, 'Thêm bot GenBot')).toHaveLength(1);
    expect(el.querySelector('[data-testid="one-bot-per-company"]')!.textContent).toMatch(/bot GenBot riêng.*ngoài quyền brain/);
    expect((el.querySelector('input[aria-label="Địa chỉ GenBot"]') as HTMLInputElement).value).toBe('http://127.0.0.1:8800');
  });

  it('adds a bot from a template: probes first, shows the reply, then saves with the key', async () => {
    api.overview.mockResolvedValue(overview([]));
    api.probe.mockResolvedValue({ status: 'pass', checks: [{ code: 'genbot.probe', level: 'info', message: 'Gửi "ping" thành công: pong' }], summary: { ok: true, message: 'Gửi "ping" thành công: pong', at: new Date().toISOString() } });
    api.create.mockResolvedValue(bot());
    const el = await mount();
    await click(button(el.querySelector('[data-testid="bots-empty"]')!, 'Thêm bot GenBot'));
    const d = dialog();
    // the template pre-fills brain access and module scopes from the default team
    expect(d.textContent).toContain('tra-sen-viet/san-pham/**');
    expect(d.textContent).toContain('care: reply.draft');
    await click(button(d, 'Trợ lý'));
    expect((d.querySelector('input[aria-label="Tên bot"]') as HTMLInputElement).value).toBe('Bot Trợ lý');
    expect(d.textContent).toContain('tra-sen-viet/nho/**');
    await click(button(d, 'CSKH Zalo'));
    type(d.querySelector('input[aria-label="Tên bot"]') as HTMLInputElement, 'Bot CSKH');
    type(d.querySelector('input[aria-label="Mã bot GenBot"]') as HTMLInputElement, 'bot_cskh');
    const keyInput = d.querySelector('input[aria-label="Khoá Bot API"]') as HTMLInputElement;
    expect(keyInput.type).toBe('password');
    type(keyInput, 'gbk_secret_value_1234WXYZ');
    await flush();
    await click(button(d, 'Kiểm tra rồi lưu'));
    expect(api.probe).toHaveBeenCalledWith({ botId: 'bot_cskh', key: 'gbk_secret_value_1234WXYZ', baseUrl: 'http://127.0.0.1:8800' });
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Bot CSKH', botId: 'bot_cskh', key: 'gbk_secret_value_1234WXYZ', template: 'cskh', brainFolder: 'tra-sen-viet' }));
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success', title: 'Đã thêm Bot CSKH' }));
  });

  it('a failed probe shows GenBot\'s answer and does not save until the owner insists', async () => {
    api.overview.mockResolvedValue(overview([]));
    api.probe.mockResolvedValue({ status: 'fail', checks: [{ code: 'genbot.probe', level: 'error', message: 'GenBot 401: Khoá Bot API sai hoặc đã bị thay.' }], summary: { ok: false, message: 'GenBot 401: Khoá Bot API sai hoặc đã bị thay.', at: new Date().toISOString() } });
    api.create.mockResolvedValue(bot());
    const el = await mount();
    await click(button(el, 'Thêm bot GenBot'));
    const d = dialog();
    type(d.querySelector('input[aria-label="Mã bot GenBot"]') as HTMLInputElement, 'bot_cskh');
    type(d.querySelector('input[aria-label="Khoá Bot API"]') as HTMLInputElement, 'gbk_wrong_key_value_000');
    await flush();
    await click(button(d, 'Kiểm tra rồi lưu'));
    expect(d.querySelector('[data-testid="probe-result"]')!.textContent).toContain('Khoá Bot API sai');
    expect(api.create).not.toHaveBeenCalled();
    await click(button(d, 'Vẫn lưu'));
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it('shows each bot with its key status (never the key), runs, modules and brain access', async () => {
    api.overview.mockResolvedValue(overview([
      bot(),
      bot({ id: 'bot-nd', name: 'Bot Nội dung', botId: '', connected: false, key: { hasKey: false, last4: '', source: null, updatedAt: null }, usedBy: [], lastCheck: null }),
      bot({ id: 'bot-tl', name: 'Bot Trợ lý', key: { hasKey: true, last4: '', source: 'env', keyEnv: 'GENBOT_KEY_TRO_LY', updatedAt: null }, lastCheck: { ok: false, message: 'GenBot 403', at: new Date().toISOString() } }),
    ]));
    const el = await mount();
    const card = (id: string) => el.querySelector(`[data-bot="${id}"]`)!;
    expect(card('bot-cskh').querySelector('[data-testid="key-status"]')!.textContent).toBe('Đã có khoá ••••WXYZ');
    expect(card('bot-cskh').textContent).toContain('3 / 500 lượt');
    expect(card('bot-cskh').textContent).toContain('Chăm khách: 2 phân công');
    expect(card('bot-cskh').textContent).toContain('tra-sen-viet/san-pham/**');
    expect(card('bot-cskh').textContent).toContain('care: reply.draft');
    expect(card('bot-cskh').textContent).toContain('Đang trực');
    expect(card('bot-nd').querySelector('[data-testid="key-status"]')!.textContent).toBe('Chưa có khoá');
    expect(card('bot-nd').textContent).toContain('Chưa nối GenBot');
    expect(button(card('bot-nd'), 'Kiểm tra').disabled).toBe(true);
    expect(card('bot-tl').querySelector('[data-testid="key-status"]')!.textContent).toBe('Khoá trong .env (GENBOT_KEY_TRO_LY)');
    expect(card('bot-tl').textContent).toContain('Lỗi kết nối');
  });

  it('card actions: check, rotate key, pause, delete with confirmation; a legacy agent moves to GenBot on request', async () => {
    api.overview.mockResolvedValue(overview([bot()], [{ id: 'old', name: 'Trợ lý cũ', runtime: 'claude', enabled: true }]));
    api.check.mockResolvedValue({ status: 'pass', checks: [], summary: { ok: true, message: 'pong', at: new Date().toISOString() }, bot: bot() });
    api.setKey.mockResolvedValue(bot({ key: { hasKey: true, last4: 'QQQQ', source: 'store', updatedAt: null } }));
    api.pause.mockResolvedValue(bot({ enabled: false }));
    api.remove.mockResolvedValue({ ok: true });
    api.convert.mockResolvedValue(bot({ id: 'old' }));
    const el = await mount();
    const card = el.querySelector('[data-bot="bot-cskh"]')!;

    await click(button(card, 'Kiểm tra'));
    expect(api.check).toHaveBeenCalledWith('bot-cskh');
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success', title: 'Bot CSKH: GenBot trả lời' }));

    await click(button(card, 'Đổi khoá'));
    const kd = dialog();
    expect(kd.textContent).toContain('Đã có khoá ••••WXYZ');
    type(kd.querySelector('input[aria-label="Khoá Bot API mới"]') as HTMLInputElement, 'gbk_rotated_key_QQQQ');
    await flush();
    await click(button(kd, 'Lưu khoá'));
    expect(api.setKey).toHaveBeenCalledWith('bot-cskh', 'gbk_rotated_key_QQQQ');

    await click(button(el.querySelector('[data-bot="bot-cskh"]')!, 'Tạm dừng'));
    expect(api.pause).toHaveBeenCalledWith('bot-cskh', true);

    await click(button(el.querySelector('[data-bot="bot-cskh"]')!, 'Xoá'));
    expect(api.remove).not.toHaveBeenCalled(); // asks first
    await click(button(dialog(), 'Xoá bot'));
    expect(api.remove).toHaveBeenCalledWith('bot-cskh');

    const legacy = el.querySelector('[data-testid="legacy-agents"]')!;
    expect(legacy.textContent).toContain('Trợ lý cũ');
    await click(button(legacy, 'Chuyển sang GenBot'));
    expect(api.convert).toHaveBeenCalledWith('old');
  });

  it('checks and saves the GenBot connection', async () => {
    api.overview.mockResolvedValue(overview([bot()]));
    api.checkConnection.mockResolvedValue({ ok: false, baseUrl: 'http://127.0.0.1:8800', checks: [{ code: 'genbot.host', level: 'error', message: 'Không kết nối được tới http://127.0.0.1:8800 (ECONNREFUSED).' }] });
    api.saveConnection.mockResolvedValue({ ...overview([bot()]), updated: 1 });
    const el = await mount();
    await click(button(el, 'Kiểm tra'));
    expect(api.checkConnection).toHaveBeenCalledWith('http://127.0.0.1:8800');
    expect(el.textContent).toContain('Chưa thấy GenBot');
    expect(el.textContent).toContain('ECONNREFUSED');
    type(el.querySelector('input[aria-label="Địa chỉ GenBot"]') as HTMLInputElement, 'https://genbot.shop.vn');
    await flush();
    await click(button(el, 'Lưu'));
    expect(api.saveConnection).toHaveBeenCalledWith('https://genbot.shop.vn', false);
  });
});
