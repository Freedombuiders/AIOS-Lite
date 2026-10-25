import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoStudio } from '@modules/video/web/pages/VideoStudio';
import type { TemplateSummary } from '@modules/video/web/lib/video-edit/quick-api';
import type { ProjectStep, VideoProject } from '@modules/video/web/lib/video-edit/types';
import { progressRows, progressStage, quickReady } from './quick-model';
import { project, selectedProjectId } from '@modules/video/web/lib/video-edit/studio';
import { quickDraft } from './quick-state';

const TEMPLATES: TemplateSummary[] = [
  { id: 'style:sanpham', name: 'Giới thiệu sản phẩm', description: 'Chốt đơn trong 30–45 giây.', tags: ['Bán hàng'], tier: 'free', installed: false, legacy: true, sample: { kicker: 'ƯU ĐÃI', title: 'CHỐT ĐƠN NGAY', font: 'Montserrat', color: '#ffffff', tone: '#3a2a1f' } },
  { id: 'th-vang', name: 'Talking head vàng', description: 'Chữ Anton vàng căn giữa theo nhịp nói.', tags: ['Talking head', 'Kiến thức'], tier: 'free', installed: true, legacy: false, posterUrl: '/api/m/video/edit/templates/th-vang/files/poster.webp', sample: { kicker: 'TALKING HEAD', title: 'Talking head vàng', font: 'Anton', color: '#FFD23F', tone: '#2D2A26' } },
  { id: 'style:kienthuc', name: 'Kiến thức nhanh', description: 'Một ý trong 30–60 giây.', tags: ['Kiến thức'], tier: 'free', installed: false, legacy: true, sample: { kicker: 'MẸO NHỎ', title: 'Bạn có *biết*?', font: 'Be Vietnam Pro', color: '#FACC15', tone: '#1b2433' } },
  { id: 'bds', name: 'Chữ động bất động sản', description: 'Thông tin căn nhà xếp tầng.', tags: ['Bất động sản'], tier: 'pro', installed: false, legacy: false, sample: { title: 'Căn góc|hai mặt thoáng', font: 'Playfair Display', color: '#F5E6B8', tone: '#23302a' } },
];

const PROFILE = { id: 'pf', slug: 'kenh', name: 'Kênh thử', platform: 'tiktok', initials: 'KT', color: '#ffd23f', defaultAspect: '9:16', brand: {}, audio: { speechRate: 1, voiceLufs: -16, musicLufs: -30, finalLufs: -14 }, keepWords: [], taste: '', onboarding: {}, referenceChannels: [], autoApprovePlan: false, createdAt: '', updatedAt: '' };

const steps = (status: Partial<Record<ProjectStep['key'], Partial<ProjectStep>>>): ProjectStep[] =>
  (['ingest', 'transcribe', 'analyze', 'direct', 'approve', 'cut', 'captions', 'effects', 'audio', 'render', 'cover', 'deliver'] as const)
    .map((key) => ({ key, status: 'pending', ...status[key] }));

function makeProject(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 'p1', code: 'VID-0001', profileId: 'pf', title: '10-5-tiktok-2', status: 'working', aspect: '9:16', agentId: 'main',
    source: { fileName: '10-5-tiktok-2.mp4', sizeBytes: 1000, durationSec: 28.4, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', hasAudio: true },
    steps: steps({ ingest: { status: 'done', finishedAt: '2026-10-25T02:41:00Z', summary: '1080×1920 · đã chuẩn hoá' }, transcribe: { status: 'running', progress: 0.5 } }),
    planVersion: 0, outputs: {}, busy: false, createdAt: '2026-10-25T02:40:00Z', updatedAt: '2026-10-25T02:41:00Z',
    ...patch,
  };
}

let current: VideoProject;
let calls: { url: string; method: string; body: unknown }[];

function api(url: string, method: string): unknown {
  const u = new URL(url, 'http://localhost');
  const path = u.pathname.replace('/api/m/video', '');
  if (path === '/edit/profiles') return { profiles: [PROFILE] };
  if (path === '/edit/projects' && method === 'POST') return { project: makeProject({ id: 'p-new', title: 'clip', source: undefined, steps: steps({}) }) };
  if (path === '/edit/projects') return { projects: [{ id: 'p1', code: 'VID-0001', profileId: 'pf', title: '10-5-tiktok-2', status: 'done', aspect: '9:16', busy: false, createdAt: '', updatedAt: '', hasSource: true, durationSec: 24 }] };
  if (path === '/edit/projects/p1') return { project: current, messages: [] };
  if (path === '/edit/projects/p-new') return { project: makeProject({ id: 'p-new', title: 'clip', source: undefined, steps: steps({}) }), messages: [] };
  if (path === '/edit/projects/p1/ai-edit') return { project: { ...current, quick: { ...(calls.at(-1)!.body as object), startedAt: '2026-10-25T02:42:00Z' } }, job: { id: 'j1', projectId: 'p1', kind: 'direct', status: 'queued', createdAt: '' } };
  if (path === '/edit/projects/p1/abort') return { ok: true };
  if (path === '/edit/templates') return { templates: TEMPLATES, problems: [] };
  if (path.endsWith('/install')) return { template: { ...TEMPLATES[0], installed: true } };
  if (path === '/edit/assets/upload') return { asset: { id: 'asset-1', kind: 'image', name: 'canh-lam-viec.jpg', tags: [], source: 'library', available: true } };
  if (path === '/edit/assets' && u.searchParams.get('kind') === 'bgm') {
    return { kinds: [], assets: [
      { id: 'bgm-1', kind: 'bgm', name: 'Sáng sớm', tags: [], source: 'seed', available: true, mood: 'vui', bpm: 120, durationSec: 95 },
      { id: 'bgm-off', kind: 'bgm', name: 'Đã tắt', tags: [], source: 'seed', available: true, enabled: false },
    ] };
  }
  if (path.startsWith('/edit/assets')) return { kinds: [], assets: [] };
  if (path === '/edit/agents') return { agents: [{ id: 'main', name: 'main', provider: 'claude', engineLabel: 'Claude', isDefault: true }], defaultAgentId: 'main' };
  if (path === '/edit/styles') return { groups: [], styles: [] };
  if (path === '/edit/doctor') return { checks: [], ok: 0, total: 0, requiredOk: true };
  if (path === '/health') return { ffmpeg: true, ffprobe: true, kol: false };
  return {};
}

/** XMLHttpRequest stand-in for the raw video upload (studio.ts uploadVideo). */
const uploads: string[] = [];
class FakeXhr {
  status = 200;
  responseText = '';
  responseType = '';
  upload = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = '';
  open(_method: string, url: string) { this.url = url; }
  setRequestHeader() {}
  send() {
    uploads.push(this.url);
    this.responseText = JSON.stringify({ project: makeProject({ id: 'p-new', title: 'clip' }) });
    setTimeout(() => this.onload?.(), 0);
  }
}

let host: HTMLElement;
beforeEach(() => {
  current = makeProject();
  calls = [];
  quickDraft.value = { file: null, note: '', templateId: null, projectId: null };
  selectedProjectId.value = null;
  project.value = null;
  uploads.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    let body: unknown;
    try { body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body; } catch { body = init.body; }
    calls.push({ url: String(url), method, body });
    return Promise.resolve(new Response(JSON.stringify(api(String(url), method)), { status: 200, headers: { 'content-type': 'application/json' } }));
  }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} onerror = null; });
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { render(null, host); host.remove(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const buttons = () => [...host.querySelectorAll('button')];
const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const card = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.vs-dn-card')].find((c) => c.querySelector('.vs-dn-card-name')?.textContent === name);
const cardNames = () => [...host.querySelectorAll('.vs-dn-card-name')].map((n) => n.textContent);

async function open(search: string) {
  window.history.replaceState({}, '', `/m/video${search}`);
  await act(async () => { render(<VideoStudio />, host); });
  await flush();
  await flush();
}

function chooseFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Dựng nhanh › Trang đầu', () => {
  it('adds the Dựng nhanh tab and shows the template cards with their labels', async () => {
    await open('?tab=quick');
    expect(button('Dựng nhanh')).toBeTruthy();
    expect(host.textContent).toContain('Dựng video từ footage thô');
    // Template packs first (installed first), wrapped legacy styles after.
    expect(cardNames()).toEqual(['Talking head vàng', 'Chữ động bất động sản', 'Giới thiệu sản phẩm', 'Kiến thức nhanh']);
    expect(card('Talking head vàng')!.querySelector('.vs-dn-badge')!.textContent).toBe('Đã cài');
    expect(card('Chữ động bất động sản')!.querySelector('.vs-dn-badge')!.textContent).toBe('PRO');
    expect(card('Kiến thức nhanh')!.querySelector('.vs-dn-badge')!.textContent).toBe('Miễn phí');
    // Poster when there is one, else drawn from the sample (markup stripped, | = new line).
    expect(card('Talking head vàng')!.querySelector('img')!.getAttribute('src')).toBe('/api/m/video/edit/templates/th-vang/files/poster.webp');
    expect(card('Kiến thức nhanh')!.querySelector('.vs-dn-thumb-title')!.textContent).toBe('Bạn có biết?');
    expect(card('Chữ động bất động sản')!.querySelectorAll('.vs-dn-thumb-title br')).toHaveLength(1);
    // The first installed pack is chosen by default.
    expect(card('Talking head vàng')!.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.vs-dn-pill')!.textContent).toContain('Talking head vàng');
    expect(host.textContent).toContain('Tạo mẫu từ video tham khảo');
    expect(host.querySelector('.vs-dn-project-title')!.textContent).toBe('10-5-tiktok-2');
    expect(host.querySelector('.vs-dn-status')!.textContent).toBe('Đã xuất');
  });

  it('filters templates by Đã cài, by tag and by a search without accents', async () => {
    await open('?tab=quick');
    const chips = [...host.querySelectorAll('.vs-dn-chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Tất cả', 'Đã cài', 'Kiến thức', 'Talking head', 'Bất động sản', 'Bán hàng']);

    await act(async () => { button('Đã cài')!.click(); });
    expect(cardNames()).toEqual(['Talking head vàng']);
    expect(button('Đã cài')!.getAttribute('aria-pressed')).toBe('true');
    expect(host.textContent).not.toContain('Tạo mẫu từ video tham khảo');

    await act(async () => { button('Bán hàng')!.click(); });
    expect(cardNames()).toEqual(['Giới thiệu sản phẩm']);

    await act(async () => { button('Tất cả')!.click(); });
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => { search.value = 'kien thuc'; search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(cardNames()).toEqual(['Talking head vàng', 'Kiến thức nhanh']);
    await act(async () => { search.value = 'không có mẫu này'; search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(cardNames()).toEqual([]);
    expect(host.textContent).toContain('Không có mẫu nào khớp');

    await act(async () => { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { card('Giới thiệu sản phẩm')!.click(); });
    expect(card('Giới thiệu sản phẩm')!.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.vs-dn-pill')!.textContent).toContain('Giới thiệu sản phẩm');
  });

  it('creates a flow quick project, starts the upload and opens Thiết lập', async () => {
    await open('?tab=quick');
    const next = button('Tiếp tục thiết lập')!;
    expect(next.disabled).toBe(true);
    await act(async () => { chooseFiles(host.querySelector<HTMLInputElement>('.vs-dn-drop input[type="file"]')!, [new File(['x'], 'clip.mp4', { type: 'video/mp4' })]); });
    expect(host.textContent).toContain('clip.mp4');
    const note = host.querySelector<HTMLTextAreaElement>('.vs-dn-field textarea')!;
    await act(async () => { note.value = 'nhấn mạnh 3 bước'; note.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { button('Tiếp tục thiết lập')!.click(); });
    await flush();
    await flush();
    const create = calls.find((c) => c.method === 'POST' && c.url === '/api/m/video/edit/projects')!;
    expect(create.body).toMatchObject({ profileId: 'pf', title: 'clip', aspect: '9:16', flow: 'quick' });
    expect(uploads[0]).toContain('/api/m/video/edit/projects/p-new/upload');
    const url = new URL(window.location.href);
    expect(url.searchParams.get('tab')).toBe('quick');
    expect(url.searchParams.get('project')).toBe('p-new');
    expect(url.searchParams.get('view')).toBe('setup');
    expect(host.textContent).toContain('Thiết lập trước khi AI edit');
    expect(host.querySelector<HTMLTextAreaElement>('#vs-dn-note')!.value).toBe('nhấn mạnh 3 bước');
  });
});

describe('Dựng nhanh › Thiết lập', () => {
  it('sends the settings as the ai-edit body and opens Đang dựng', async () => {
    await open('?tab=quick&project=p1&view=setup');
    expect(host.textContent).toContain('Thiết lập trước khi AI edit');
    expect(host.textContent).toContain('10-5-tiktok-2.mp4');
    expect(host.textContent).toContain('28,4 giây · 1080×1920 · dọc 9:16');
    expect(host.textContent).toContain('Đã tải lên, máy đang chép lời trong nền');
    expect(host.querySelector('.vs-dn-template-text strong')!.textContent).toBe('Talking head vàng');
    expect(host.querySelector('.vs-dn-summary')!.textContent).toBe('không tư liệu · nhạc AI chọn · tự cắt vừa');

    // Cut level, footage with a hint, stock off, a picked track, a note.
    await act(async () => { button('Sát')!.click(); });
    expect(host.textContent).toContain('Bỏ gần hết chỗ lặng, nhịp nhanh');
    await act(async () => { chooseFiles(host.querySelector<HTMLInputElement>('.vs-dn-add + input[type="file"]')!, [new File(['x'], 'canh-lam-viec.jpg', { type: 'image/jpeg' })]); });
    await flush();
    expect(host.querySelector('.vs-dn-asset-name strong')!.textContent).toBe('canh-lam-viec.jpg');
    const hint = host.querySelector<HTMLTextAreaElement>('.vs-dn-asset-hint textarea')!;
    await act(async () => { hint.value = 'Chèn khi nói “mở ChatGPT lên”'; hint.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Tìm thêm cảnh trám khi thiếu"]')!.click(); });
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.vs-dn-radio')].find((b) => b.textContent?.includes('Chọn bài trong thư viện'))!.click(); });
    await flush();
    expect(button('AI edit')!.disabled).toBe(true);
    expect(host.textContent).toContain('Chọn một bài nhạc hoặc để AI chọn.');
    // Disabled tracks are not offered.
    expect([...host.querySelectorAll('.vs-dn-track-name')].map((n) => n.textContent)).toEqual(['Sáng sớm']);
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('.vs-dn-track')].find((b) => b.textContent?.includes('Sáng sớm'))!.click(); });
    const note = host.querySelector<HTMLTextAreaElement>('#vs-dn-note')!;
    await act(async () => { note.value = 'thêm logo cuối video'; note.dispatchEvent(new Event('input', { bubbles: true })); });

    // "AI sẽ làm" follows the form.
    const plan = [...host.querySelectorAll('.vs-dn-plan li')].map((li) => `${li.className}:${li.textContent}`);
    expect(plan).toContain('is-on:Cắt vấp và khoảng lặngMức sát');
    expect(plan).toContain('is-on:Chèn 1 tư liệu của bạn1 có mô tả');
    expect(plan).toContain('is-off:Tìm thêm cảnh trámĐã tắt');
    expect(plan).toContain('is-on:Nhạc và tiếng độngBài bạn chọn');
    expect(host.querySelector('.vs-dn-summary')!.textContent).toBe('1 tư liệu · nhạc tự chọn · tự cắt sát');

    await act(async () => { button('AI edit')!.click(); });
    await flush();
    const post = calls.find((c) => c.url === '/api/m/video/edit/projects/p1/ai-edit')!;
    expect(post.method).toBe('POST');
    expect(post.body).toEqual({
      mode: 'ai', autoCut: true, cutLevel: 'sat', templateId: 'th-vang',
      assets: [{ assetId: 'asset-1', hint: 'Chèn khi nói “mở ChatGPT lên”' }],
      music: { mode: 'pick', assetId: 'bgm-1', duck: true, snapToBeat: false, endOnFinal: true },
      stock: false, note: 'thêm logo cuối video',
    });
    // th-vang is installed: no install call.
    expect(calls.some((c) => c.url.endsWith('/install'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/edit/assets/upload?kind=image'))).toBe(true);
    expect(new URL(window.location.href).searchParams.get('view')).toBe('progress');
    expect(host.textContent).toContain('AI đang dựng video của bạn');
  });

  it('"Bỏ qua — tự chỉnh tay" sends mode manual with auto cut off, installing the chosen template first', async () => {
    await open('?tab=quick&project=p1&view=setup');
    await act(async () => { host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label^="Tự cắt"]')!.click(); });
    expect(host.textContent).not.toContain('Mức cắt');
    await act(async () => { button('Đổi mẫu')!.click(); });
    expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    await act(async () => { card('Giới thiệu sản phẩm')!.click(); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('.vs-dn-template-text strong')!.textContent).toBe('Giới thiệu sản phẩm');
    await act(async () => { button('Bỏ qua — tự chỉnh tay')!.click(); });
    await flush();
    const install = calls.findIndex((c) => c.url === '/api/m/video/edit/templates/style%3Asanpham/install');
    const post = calls.findIndex((c) => c.url === '/api/m/video/edit/projects/p1/ai-edit');
    expect(install).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(install);
    expect(calls[post].body).toEqual({
      mode: 'manual', autoCut: false, cutLevel: 'vua', templateId: 'style:sanpham', assets: [],
      music: { mode: 'ai', duck: true, snapToBeat: false, endOnFinal: true }, stock: true,
    });
  });

  it('waits for the video before AI edit', async () => {
    current = makeProject({ source: undefined, steps: steps({}) });
    await open('?tab=quick&project=p1&view=setup');
    expect(host.textContent).toContain('Chưa có video');
    expect(button('AI edit')!.disabled).toBe(true);
    expect(host.querySelector('.vs-dn-summary')!.textContent).toBe('Tải video lên trước.');
  });
});

describe('Dựng nhanh › Đang dựng', () => {
  const quick = { mode: 'ai' as const, autoCut: true, cutLevel: 'vua' as const, templateId: 'th-vang', assets: [{ assetId: 'a1', hint: 'x' }, { assetId: 'a2' }], music: { mode: 'ai' as const, duck: true, snapToBeat: false, endOnFinal: true }, stock: true, startedAt: '2026-10-25T02:42:00Z' };

  it('shows the steps with their evidence, a progress bar and Dừng', async () => {
    current = makeProject({
      quick, busy: true,
      steps: steps({
        ingest: { status: 'done', finishedAt: '2026-10-25T02:41:00Z', summary: '1080×1920 · 28,4 giây · đã chuẩn hoá' },
        transcribe: { status: 'done', finishedAt: '2026-10-25T02:42:00Z', summary: '86 từ · vi' },
        analyze: { status: 'done', finishedAt: '2026-10-25T02:42:30Z', summary: '4 lặng · 2 từ đệm · 2 nói lại · 6 khung' },
        direct: { status: 'running', progress: 0.6, log: [{ at: '2026-10-25T02:43:00Z', text: 'đang đặt 6 nhịp chữ và 1 cảnh minh hoạ' }] },
      }),
    });
    await open('?tab=quick&project=p1&view=progress');
    expect(host.textContent).toContain('AI đang dựng video của bạn');
    const rows = [...host.querySelectorAll('.vs-dn-row')];
    expect(rows.map((r) => r.querySelector('strong')!.textContent)).toEqual([
      'Nhận video', 'Chép lời tiếng Việt', 'Cắt vấp và khoảng lặng', 'Đạo diễn AI dựng theo mẫu', 'Cảnh trám', 'Nhạc và tiếng động', 'Dựng bản xem trước',
    ]);
    expect(rows.map((r) => r.className.replace('vs-dn-row is-', ''))).toEqual(['done', 'done', 'done', 'running', 'pending', 'pending', 'pending']);
    expect(rows[0].textContent).toContain('1080×1920 · 28,4 giây · đã chuẩn hoá');
    expect(rows[3].textContent).toContain('đang đặt 6 nhịp chữ và 1 cảnh minh hoạ');
    expect(rows[3].textContent).toContain('đang chạy');
    expect(rows[3].querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('60');
    expect(rows[4].textContent).toContain('2 tư liệu của bạn · tìm thêm trong Kho của tôi và Pexels nếu thiếu');
    expect(rows[5].textContent).toContain('AI chọn theo mẫu · tự giảm nhạc khi đang nói');
    expect(rows[6].textContent).toContain('Chưa xuất video');
    expect(button('Mở editor')!.disabled).toBe(true);

    await act(async () => { button('Dừng')!.click(); });
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/m/video/edit/projects/p1/abort')).toBe(true);
  });

  it('marks the build ready once the AI plan of this edit is in', () => {
    const plan = {
      version: 2, sourceDurationSec: 28.4, outputDurationSec: 24.3, cutWords: [3, 4, 9], gapMs: 400, keep: [], removed: [],
      brolls: [{ enabled: true }, { enabled: false }], captions: {}, overlays: [], zooms: [], sfx: [{}, {}], covers: [], meta: {}, author: 'agent',
      music: { assetId: 'bgm-1', mood: 'vui', gainDb: -18, duck: true },
    } as unknown as VideoProject['plan'];
    const done = (finishedAt: string) => makeProject({
      quick, plan, planVersion: 2, planStatus: 'approved',
      steps: steps({ ingest: { status: 'done' }, transcribe: { status: 'done' }, analyze: { status: 'done' }, direct: { status: 'done', finishedAt } }),
    });
    const ready = done('2026-10-25T02:45:00Z');
    expect(quickReady(ready)).toBe(true);
    const rows = progressRows(ready);
    expect(rows.every((r) => r.state === 'done')).toBe(true);
    expect(rows.find((r) => r.id === 'cut')!.evidence).toBe('28,4 giây → 24,3 giây · bỏ 3 từ');
    expect(rows.find((r) => r.id === 'broll')!.evidence).toBe('1 cảnh trám · 2 tư liệu của bạn');
    expect(rows.find((r) => r.id === 'audio')!.evidence).toBe('Có nhạc nền · tự giảm khi đang nói · 2 tiếng động');
    expect(progressStage(ready, rows)).toBe('ready');

    // A director turn from before this AI edit does not count; a live job keeps it running.
    const stale = done('2026-10-25T02:30:00Z');
    expect(quickReady(stale)).toBe(false);
    expect(progressRows(stale).find((r) => r.id === 'direct')!.state).toBe('pending');
    expect(quickReady(ready, [{ id: 'j', projectId: 'p1', kind: 'render', status: 'running', createdAt: '' }])).toBe(false);

    // Manual mode has no director turn; auto cut off shows the cut row as skipped.
    const manual = makeProject({
      quick: { ...quick, mode: 'manual', autoCut: false }, plan, planVersion: 1,
      steps: steps({ ingest: { status: 'done' }, transcribe: { status: 'done' }, analyze: { status: 'done' } }),
    });
    const manualRows = progressRows(manual);
    expect(manualRows.find((r) => r.id === 'direct')).toMatchObject({ title: 'Máy dựng theo mẫu', state: 'done' });
    expect(manualRows.find((r) => r.id === 'cut')).toMatchObject({ state: 'skipped', evidence: 'Đã tắt: giữ nguyên video' });

    const failed = makeProject({ quick, steps: steps({ ingest: { status: 'done' }, transcribe: { status: 'failed', error: 'Không nghe thấy lời nói trong video này.' } }) });
    const failedRows = progressRows(failed);
    expect(failedRows[1]).toMatchObject({ state: 'failed', evidence: 'Không nghe thấy lời nói trong video này.' });
    expect(progressStage(failed, failedRows)).toBe('failed');
  });
});
