import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoStudio } from '@modules/video/web/pages/VideoStudio';
import { playerControls, playerTime } from '@modules/video/web/lib/video-edit/editor';
import { applyOverridesPatch, type OverridesPatch, type TemplateManifest } from '@modules/video/web/lib/video-edit/editor2';
import { project, selectedProjectId } from '@modules/video/web/lib/video-edit/studio';
import type { DroppedElement, EditPlan, OverridesDoc, ProjectStep, VideoProject } from '@modules/video/web/lib/video-edit/types';

// The real player loads @hyperframes/player; the editor only needs its src and the mark button.
vi.mock('../PreviewPlayer', () => ({
  PreviewPlayer: (props: { src?: string; onMark?: () => void; markLabel?: string }) => (
    <div class="pp-stub" data-src={props.src}>
      <button type="button" onClick={() => props.onMark?.()}>{props.markLabel}</button>
    </div>
  ),
}));

const PROFILE = { id: 'pf', slug: 'kenh', name: 'Kênh thử', platform: 'tiktok', initials: 'KT', color: '#ffd23f', defaultAspect: '9:16', brand: {}, audio: { speechRate: 1, voiceLufs: -16, musicLufs: -30, finalLufs: -14 }, keepWords: [], taste: '', onboarding: {}, referenceChannels: [], autoApprovePlan: false, createdAt: '', updatedAt: '' };

const WORDS = ['có', 'gì', 'trong', 'đầu', 'là', 'nói', 'luôn', 'gửi', 'cho', 'ChatGPT'].map((text, i) => ({ i, text, start: i, end: i + 0.8 }));

const PLAN: EditPlan = {
  version: 2, createdAt: '', styleId: 'kienthuc', aspect: '9:16', summary: '', sourceDurationSec: 10, outputDurationSec: 10,
  cutWords: [], gapMs: 400, keep: [{ start: 0, end: 10 }], removed: [],
  brolls: [{ id: 'br1', anchorWord: 7, duration: 2, title: 'gõ laptop', reason: '', source: 'pexels', layout: 'full', enabled: true, assetId: 'lib-old', query: { description: 'người gõ phím laptop', keywords: ['typing', 'laptop'] } }],
  captions: { styleId: 'x', position: 'bottom', highlight: [], maxWordsPerChunk: 3 }, overlays: [],
  zooms: [{ id: 'z1', at: 6, duration: 1, scale: 1.07 }], music: { assetId: 'bgm-1', mood: 'Tập trung', gainDb: -18, duck: true },
  sfx: [], covers: [], meta: { title: '', caption: '', hashtags: [] }, author: 'agent', planFormat: 2, templateId: 'th-vang',
  beats: [
    { id: 'b1', at: 0.5, duration: 2.4, component: 'text-beat', kicker: 'BƯỚC 1', title: 'Có gì trong đầu|*nói luôn*', sub: 'không cần chuẩn bị', animIn: 'slide-up' },
    { id: 'b2', at: 4, duration: 2, component: 'text-beat', title: 'Gửi cho *ChatGPT*', animIn: 'pop' },
  ],
  scenes: [{ id: 's1', at: 7, duration: 2.5, component: 'scene-steps', props: { step: 3, title: 'Nhờ *ChatGPT* edit', items: ['Quay', 'Gửi'] } }],
};

const TEMPLATE = {
  id: 'th-vang', version: '1.0.0', name: 'Talking head vàng', description: '', tags: [], tier: 'free', aspects: ['9:16'],
  tokens: { fonts: { title: 'Anton', sub: 'Montserrat', caption: 'Montserrat' }, colors: {} },
  captions: { pos: 0.76, maxWidthPct: 84, align: 'center', font: { family: 'Montserrat', sizePct: 6, weight: 800 }, fill: '#fff', highlight: { color: '#FFD23F', mode: 'color' }, maxWordsPerChunk: 3 },
  components: {
    'text-beat': { kind: 'beat', label: 'Nhịp chữ', file: '', runtime: 'gsap', duration: { min: 1, max: 4, default: 2 }, props: {
      kicker: { type: 'text', label: 'Nhãn nhỏ', maxWords: 3 },
      title: { type: 'markup', label: 'Tiêu đề', required: true, maxWords: 6, maxLines: 2 },
      sub: { type: 'text', label: 'Chữ phụ', maxWords: 8 },
    } },
    'scene-steps': { kind: 'scene', label: 'Các bước', file: '', runtime: 'gsap', duration: { min: 2, max: 8, default: 5 }, animations: ['slide-up', 'pop', 'fade'], props: {
      step: { type: 'number', label: 'Số bước' },
      title: { type: 'markup', label: 'Tiêu đề', required: true, maxWords: 6, maxLines: 2 },
      items: { type: 'list', label: 'Các mục', required: true, maxItems: 5 },
    } },
    'broll-frame': { kind: 'broll-frame', label: 'Khung cảnh trám', file: '', runtime: 'gsap', duration: { min: 1, max: 6, default: 2 }, props: { layout: { type: 'text', label: 'Kiểu khung' } } },
  },
  animations: [
    { id: 'typewriter', label: 'Gõ chữ', sound: 'sfx:typing' }, { id: 'slide-up', label: 'Trượt lên', sound: 'sfx:whoosh' },
    { id: 'pop', label: 'Bật lên', sound: 'sfx:pop' }, { id: 'fade', label: 'Hiện mờ' },
  ],
  sounds: { density: 'low' }, rules: 'rules.md',
} as unknown as TemplateManifest;

const steps = (status: Partial<Record<ProjectStep['key'], Partial<ProjectStep>>>): ProjectStep[] =>
  (['ingest', 'transcribe', 'analyze', 'direct', 'approve', 'cut', 'captions', 'effects', 'audio', 'render', 'cover', 'deliver'] as const)
    .map((key) => ({ key, status: 'pending', ...status[key] }));

const QUICK = { mode: 'ai' as const, autoCut: true, cutLevel: 'vua' as const, templateId: 'th-vang', assets: [], music: { mode: 'ai' as const, duck: true, snapToBeat: false, endOnFinal: true }, stock: true, startedAt: '2026-10-25T02:42:00Z' };

function makeProject(patch: Partial<VideoProject> = {}): VideoProject {
  return {
    id: 'p1', code: 'VID-0001', profileId: 'pf', title: '10-5-tiktok-2', status: 'waiting_approval', aspect: '9:16', agentId: 'main',
    source: { fileName: 'clip.mp4', sizeBytes: 1000, durationSec: 10, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', hasAudio: true },
    steps: steps({ ingest: { status: 'done' }, transcribe: { status: 'done' }, analyze: { status: 'done' }, direct: { status: 'done', finishedAt: '2026-10-25T02:45:00Z' } }),
    plan: PLAN, planVersion: 2, planStatus: 'waiting_approval', quick: QUICK, outputs: {}, busy: false, createdAt: '', updatedAt: '',
    ...patch,
  };
}

let current: VideoProject;
let overrides: OverridesDoc;
let dropped: DroppedElement[];
let puts: number;
let calls: { url: string; method: string; body: unknown }[];

function api(url: string, method: string, body: unknown): unknown {
  const u = new URL(url, 'http://localhost');
  const path = u.pathname.replace('/api/m/video', '');
  if (path === '/edit/profiles') return { profiles: [PROFILE] };
  if (path === '/edit/projects') return { projects: [] };
  if (path === '/edit/projects/p1') return { project: current, messages: [] };
  if (path === '/edit/projects/p1/transcript') return { transcript: { language: 'vi', model: 'x', durationSec: 10, words: WORDS, createdAt: '' } };
  if (path === '/edit/projects/p1/plan') return { plan: PLAN, planVersion: 2 };
  if (path === '/edit/projects/p1/marks' && method === 'POST') return { mark: { id: 'm1', projectId: 'p1', planVersion: 2, status: 'draft', createdAt: '', ...(body as object) } };
  if (path === '/edit/projects/p1/marks') return { marks: [] };
  if (path === '/edit/projects/p1/marks/send') return { ok: true, sent: 1, project: { ...current, busy: true } };
  if (path === '/edit/projects/p1/overrides' && method === 'PUT') {
    puts++;
    overrides = applyOverridesPatch(overrides, body as OverridesPatch, `2026-10-25T03:00:0${puts}.000Z`);
    return { overrides, dropped };
  }
  if (path === '/edit/projects/p1/overrides') return { overrides, dropped };
  if (path === '/edit/projects/p1/plan/ops') {
    dropped = [];
    return { plan: { ...PLAN, version: 3, beats: [...PLAN.beats!, { id: 'b9', at: 8, duration: 1, component: 'text-beat', title: 'Chữ cũ', origin: 'owner' }] }, project: { ...current, planVersion: 3 } };
  }
  if (path === '/edit/templates/th-vang') return { template: TEMPLATE };
  if (path === '/edit/templates') return { templates: [], problems: [] };
  if (path === '/edit/assets/search') {
    return { candidates: [
      { ref: 'pexels:video:1', source: 'pexels', kind: 'video', caption: 'Người gõ laptop, cận cảnh', durationSec: 9, width: 1080, height: 1920, license: { name: 'Pexels', creator: 'An', attributionRequired: false }, score: 4, reason: 'Đúng hành động' },
      { ref: 'lib-old', source: 'mine', kind: 'image', caption: 'Bàn làm việc', license: { name: 'Kho của tôi', attributionRequired: false }, score: 3 },
    ], notes: ['Chưa có Pexels key cho ảnh.'] };
  }
  if (path === '/edit/assets/fetch') return { asset: { id: 'asset-px', kind: 'video', name: 'pexels-1.mp4', tags: [], source: 'library', available: true }, downloaded: true };
  if (path === '/edit/assets' && u.searchParams.get('kind') === 'bgm') {
    return { kinds: [], assets: [
      { id: 'bgm-1', kind: 'bgm', name: 'Sáng sớm', tags: [], source: 'seed', available: true, mood: 'Tập trung', durationSec: 60, beats: [1, 2, 3] },
      { id: 'bgm-2', kind: 'bgm', name: 'Chill Lofi', tags: [], source: 'seed', available: true, mood: 'Bình yên', durationSec: 90 },
    ] };
  }
  if (path === '/edit/assets') return { kinds: [], assets: [{ id: 'sfx:pop', kind: 'sfx', name: 'pop', tags: [], source: 'seed', available: true }] };
  if (path === '/edit/agents') return { agents: [{ id: 'main', name: 'main', provider: 'claude', engineLabel: 'Claude', isDefault: true }], defaultAgentId: 'main' };
  if (path === '/edit/styles') return { groups: [], styles: [] };
  if (path === '/edit/doctor') return { checks: [], ok: 0, total: 0, requiredOk: true };
  return {};
}

let host: HTMLElement;
let seek: ReturnType<typeof vi.fn>;
beforeEach(() => {
  current = makeProject();
  overrides = { version: 1, elements: {}, updatedAt: '2026-10-25T03:00:00.000Z' };
  dropped = [];
  puts = 0;
  calls = [];
  selectedProjectId.value = null;
  project.value = null;
  playerTime.value = 0;
  seek = vi.fn();
  playerControls.seek = seek as unknown as (t: number) => void;
  host = document.createElement('div');
  document.body.appendChild(host);
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    let body: unknown;
    try { body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body; } catch { body = init.body; }
    calls.push({ url: String(url), method, body });
    return Promise.resolve(new Response(JSON.stringify(api(String(url), method, body)), { status: 200, headers: { 'content-type': 'application/json' } }));
  }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} onerror = null; });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { render(null, host); host.remove(); vi.unstubAllGlobals(); });

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const flush = () => wait(30);
const buttons = () => [...host.querySelectorAll('button')];
const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const block = (label: string) => host.querySelector<HTMLButtonElement>(`.vs-dn-tl-block[aria-label^="${label}"]`)!;
const rail = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.vs-dn-rail button')].find((b) => b.textContent === label)!;
const inspector = () => host.querySelector('.vs-dn-insp')!;
const puts_ = () => calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/projects/p1/overrides'));

async function open(search: string) {
  window.history.replaceState({}, '', `/m/video${search}`);
  await act(async () => { render(<VideoStudio />, host); });
  await flush();
  await flush();
  await flush();
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click(); });
  await flush();
}

describe('Dựng nhanh › Editor v2', () => {
  it('opens from Đang dựng for a Dựng nhanh project, with the preview, layers and all ten tracks', async () => {
    await open('?tab=quick&project=p1&view=progress');
    await click(button('Mở editor')!);
    await flush();
    expect(new URLSearchParams(window.location.search).get('view')).toBe('editor');
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('quick');
    expect(button('Xuất video')).toBeTruthy();
    expect(host.querySelector('.vs-dn-ed-name')!.textContent).toContain('0:10,0 sau khi cắt · 2 nhịp chữ · 1 cảnh minh hoạ · 1 cảnh trám');
    expect(host.querySelector('.pp-stub')!.getAttribute('data-src')).toBe('/api/m/video/edit/projects/p1/composition/preview.html?v=2');
    expect([...host.querySelectorAll('.vs-dn-tl-label')].map((l) => l.textContent).filter(Boolean)).toEqual([
      'Chữ', 'Phụ đề', 'Minh hoạ', 'Cảnh trám', 'Đồ hoạ', 'Zoom', 'Nhạc', 'Tiếng động', 'Video', 'Góp ý',
    ]);
    expect(block('Nhạc').textContent).toBe('Sáng sớm · tự giảm khi đang nói');
    expect(host.querySelector('.vs-dn-layers')!.textContent).toContain('Lớp tại 00:00,0');
    // Undo/redo wait for phase 2; the draft render is not shown.
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Hoàn tác"]')!.disabled).toBe(true);
    expect(button('Dựng nháp')).toBeUndefined();
  });

  it('keeps the existing editor for a project that is not a Dựng nhanh one', async () => {
    current = makeProject({ quick: undefined, planStatus: 'approved' });
    await open('?tab=quick&project=p1&view=progress');
    await click(button('Mở editor')!);
    const q = new URLSearchParams(window.location.search);
    expect(q.get('tab')).toBe('edit');
    expect(q.get('view')).toBe('editor');
  });

  it('selecting a block on the timeline opens it in the inspector and seeks there', async () => {
    await open('?tab=quick&project=p1&view=editor');
    await click(block('Chữ “Gửi cho ChatGPT”'));
    expect(inspector().querySelector('h2')!.textContent).toBe('Chữ');
    expect(inspector().textContent).toContain('Nhịp 2/2 · 00:04,0 · 2,0 giây');
    expect(inspector().querySelector('textarea')!.value).toBe('Gửi cho *ChatGPT*');
    expect(inspector().querySelector('select')!.value).toBe('pop');
    expect(block('Chữ “Gửi cho ChatGPT”').getAttribute('aria-pressed')).toBe('true');
    expect(seek).toHaveBeenLastCalledWith(4.6);

    await click(block('Minh hoạ'));
    expect(inspector().querySelector('h2')!.textContent).toBe('Minh hoạ');
    const labels = [...inspector().querySelectorAll('.vs-dn-insp-label')].map((l) => l.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Số bước', 'Tiêu đề', 'Các mục', 'Hiệu ứng vào']));
    expect([...inspector().querySelectorAll('textarea')].map((t) => t.value)).toEqual(['Nhờ *ChatGPT* edit', 'Quay\nGửi']);
    expect(seek).toHaveBeenLastCalledWith(7.6);
  });

  it('counts words and lines of the title and saves one override 400 ms after the last edit', async () => {
    await open('?tab=quick&project=p1&view=editor');
    await click(rail('Chữ'));
    const title = inspector().querySelector('textarea')!;
    expect(title.value).toBe('Có gì trong đầu|*nói luôn*');
    expect(inspector().querySelector('.vs-dn-insp-count')!.textContent).toBe('6 từ · 2 dòng · đạt');
    expect(inspector().textContent).toContain('Tiêu đề · Anton');

    await type(title, 'Một hai ba bốn năm sáu bảy');
    expect(inspector().querySelector('.vs-dn-insp-count')!.textContent).toBe('7 từ · 1 dòng · nên 2–6 từ, tối đa 2 dòng');
    await wait(200);
    await type(inspector().querySelector('textarea')!, 'Nói *ngay*|đi');
    expect(inspector().querySelector('.vs-dn-insp-count')!.textContent).toBe('3 từ · 2 dòng · đạt');
    await wait(250);
    expect(puts_()).toHaveLength(0);
    await wait(250);
    expect(puts_()).toHaveLength(1);
    expect(puts_()[0].body).toEqual({ elements: { b1: { text: { title: 'Nói *ngay*|đi' } } } });
    // Saved: the owner's note appears and the preview reloads with the overrides stamp.
    expect(inspector().textContent).toContain('Bạn đã sửa tay phần này');
    expect(host.querySelector('.pp-stub')!.getAttribute('data-src')).toContain('&o=2026-10-25T03%3A00%3A01.000Z');
    expect(block('Chữ “Nói ngay đi”')).toBeTruthy();

    // Entrance preset and size go into the same kind of patch.
    const anim = inspector().querySelector<HTMLSelectElement>('select')!;
    await act(async () => { anim.value = 'fade'; anim.dispatchEvent(new Event('change', { bubbles: true })); });
    const size = [...inspector().querySelectorAll<HTMLInputElement>('input[type="range"]')].at(-1)!;
    await type(size, '112');
    await wait(450);
    expect(puts_()).toHaveLength(2);
    expect(puts_()[1].body).toEqual({ elements: { b1: { animIn: 'fade', s: 1.12 } } });

    await click(button('Trả về như AI dựng')!);
    expect(puts_()).toHaveLength(3);
    expect(puts_()[2].body).toEqual({ elements: { b1: null } });
    expect(inspector().querySelector('textarea')!.value).toBe('Có gì trong đầu|*nói luôn*');
    expect(inspector().textContent).not.toContain('Bạn đã sửa tay phần này');
  });

  it('shows what the AI dropped and restores it with op restore', async () => {
    overrides = { version: 1, elements: { b9: { text: { title: 'Chữ cũ của tôi' }, updatedAt: 'x' } }, updatedAt: '2026-10-25T03:00:00.000Z' };
    dropped = [{ id: 'b9', kind: 'beat', label: 'Chữ cũ', fromVersion: 1 }];
    await open('?tab=quick&project=p1&view=editor');
    const strip = host.querySelector('.vs-dn-dropped')!;
    expect(strip.textContent).toContain('Bản AI mới bỏ mất 1 phần bạn đã sửa tay.');
    expect(strip.textContent).toContain('Chữ “Chữ cũ”');
    await click([...strip.querySelectorAll('button')].find((b) => b.textContent === 'Khôi phục')!);
    await flush();
    const ops = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/projects/p1/plan/ops'));
    expect(ops).toHaveLength(1);
    expect(ops[0].body).toEqual({ baseVersion: 2, ops: [{ op: 'restore', id: 'b9', fromVersion: 1 }] });
    expect(host.querySelector('.vs-dn-dropped')).toBeNull();
    expect(block('Chữ “Chữ cũ của tôi”')).toBeTruthy();
  });

  it('"Nhờ AI sửa" sends a review mark about the selected element through the marks flow', async () => {
    await open('?tab=quick&project=p1&view=editor');
    await click(block('Chữ “Gửi cho ChatGPT”'));
    await click(button('Nhờ AI sửa')!);
    const input = host.querySelector<HTMLInputElement>('.vs-dn-ask input')!;
    expect(input.placeholder).toBe('Nhờ AI sửa chữ này: ngắn hơn, đổi thành câu hỏi…');
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('.vs-dn-ask-ctx')!.textContent).toContain('Gắn với “Gửi cho ChatGPT”');
    await type(input, 'ngắn hơn');
    await click(button('Gửi')!);
    await flush();
    const mark = calls.find((c) => c.method === 'POST' && c.url.endsWith('/projects/p1/marks'));
    expect(mark!.body).toEqual({ start: 4, end: 6, kind: 'text', note: 'Chữ “Gửi cho ChatGPT” (b2, 00:04,0–00:06,0): ngắn hơn' });
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/projects/p1/marks/send'))).toBe(true);
    expect(host.querySelector('.vs-dn-ed-banner')!.textContent).toContain('AI đang sửa theo góp ý');

    // "Ghim góp ý" ties the next request to the playhead instead.
    await click(button('Ghim góp ý')!);
    expect(host.querySelector('.vs-dn-ask-ctx')!.textContent).toContain('Gắn với thời điểm 00:00,0');
  });

  it('Thư viện swaps a B-roll for a scored suggestion with an assetId override', async () => {
    await open('?tab=quick&project=p1&view=editor');
    await click(rail('Cảnh trám'));
    expect(inspector().textContent).toContain('gõ laptop · Pexels');
    await click(button('Đổi cảnh khác')!);
    await flush();
    const search = calls.find((c) => c.url.includes('/assets/search'))!;
    expect(Object.fromEntries(new URL(search.url, 'http://x').searchParams)).toEqual({ projectId: 'p1', brollId: 'br1', aspect: '9:16', limit: '12' });
    const panel = host.querySelector('.vs-dn-lib')!;
    expect(panel.textContent).toContain('Đổi cảnh trám tại 00:07,0 – 00:09,0 · 2,0 giây');
    expect(panel.textContent).toContain('Lời nói: “gửi cho”');
    expect(panel.textContent).toContain('AI tìm theo mô tả: người gõ phím laptop');
    expect(panel.textContent).toContain('Chưa có Pexels key cho ảnh.');
    expect(panel.textContent).toContain('Hợp 4/5');
    expect(panel.textContent).toContain('Pexels · tác giả An · lưu link gốc');
    const cards = [...panel.querySelectorAll('.vs-dn-lib-card')];
    expect(cards[1].textContent).toContain('Đang dùng');

    await click([...cards[0].querySelectorAll('button')].find((b) => b.textContent === 'Dùng')!);
    await flush();
    expect(calls.find((c) => c.url.endsWith('/assets/fetch'))!.body).toEqual({ ref: 'pexels:video:1' });
    expect(puts_().at(-1)!.body).toEqual({ elements: { br1: { assetId: 'asset-px' } } });
    expect(host.querySelector('.vs-dn-lib')).toBeNull();
    expect(block('Cảnh trám “Người gõ laptop, cận cảnh · bạn chọn”')).toBeTruthy();
  });

  it('Thư viện › Nhạc picks the background music with a music override', async () => {
    await open('?tab=quick&project=p1&view=editor');
    await click(rail('Âm thanh'));
    expect(inspector().textContent).toContain('Sáng sớm');
    await click(button('Đổi nhạc nền')!);
    const tracks = [...host.querySelectorAll('.vs-dn-lib-track')];
    expect(tracks.map((t) => t.querySelector('strong')!.textContent)).toEqual(['Sáng sớm', 'Chill Lofi']);
    expect(tracks[0].querySelector('.vs-dn-lib-pickbtn')!.textContent).toBe('Đang dùng');
    await click(tracks[1].querySelector('.vs-dn-lib-pickbtn')!);
    await wait(450);
    expect(puts_().at(-1)!.body).toEqual({ music: { assetId: 'bgm-2', off: null } });
    expect(host.querySelectorAll('.vs-dn-lib-track')[1].querySelector('.vs-dn-lib-pickbtn')!.textContent).toBe('Đang dùng');
  });
});
