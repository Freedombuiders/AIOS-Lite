import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Route, Router } from 'wouter-preact';
import { memoryLocation } from 'wouter-preact/memory-location';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { invalidateFetchCache } from '@/lib/useFetch';
import { ScoreBox } from '../components/ScoreBox';
import type { LessonView, LoopDto, PlaybookDto, ProposalView, ScoreDto, WeeklyNoteDto } from '../lib/types';
import { LoopOverview } from './LoopOverview';
import { Pending } from './Pending';
import { Playbook } from './Playbook';
import { Weekly, sectionLines } from './Weekly';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls: Array<{ url: string; method: string; body: unknown }> = [];

function serve(routes: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => String(url).includes(k));
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function mount(node: preact.ComponentChildren) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(() => render(node, el));
  for (let i = 0; i < 30 && /Đang tải/.test(el.textContent ?? ''); i++) await act(async () => { await wait(30); });
  await act(async () => { await wait(30); });
  return el;
}

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateFetchCache();
  document.body.innerHTML = '';
});

const lesson = (o: Partial<LessonView>): LessonView => ({
  path: 'bai-hoc/x.md', title: 'X', summary: '', state: 'gia-thuyet', stateLabel: '', area: 'noi-dung', areaLabel: 'Nội dung', platform: 'facebook',
  usedBy: [], evidence: [], liveEvidence: 0, ruleText: [], trial: null, ownerVerified: false, proposedBy: null, changedAt: null, ...o,
});

describe('Sổ bài học', () => {
  it('lays lessons out by state with evidence and trial numbers', async () => {
    const dto: PlaybookDto = {
      folder: 'b1', dir: 'bai-hoc/', moc: '24h', minEvidence: 3, agents: [],
      states: [],
      lessons: [
        lesson({ path: 'bai-hoc/a.md', title: 'Bài chính sách đại lý kéo tin Zalo', liveEvidence: 2, proposedBy: 'noi-dung', evidence: [{ link: '[[a]]', path: 'noi-dung/bai/a.md', title: 'Bài A', live: true, er: 4 }, { link: '[[mat]]', path: null, title: null, live: false, er: null }] }),
        lesson({ path: 'bai-hoc/b.md', title: 'Mở đầu bằng câu hỏi', state: 'dang-thu', trial: { posts: 3, measured: 3, threshold: 4, medianEr: 6, channelMedian: 4, channelN: 20, moc: '24h', label: 'thăm dò', verdict: 'chua-du', recent: [] } }),
        lesson({ path: 'bai-hoc/c.md', title: 'Đăng lúc 19 giờ', state: 'da-kiem-chung', ownerVerified: true, usedBy: ['noi-dung'], liveEvidence: 6 }),
      ],
    };
    serve({ '/api/m/learn/playbook': dto, '/api/m/learn/pending': { items: [] } });
    const el = await mount(<Router><Playbook /></Router>);
    const text = el.textContent ?? '';
    expect(text).toMatch(/2 bằng chứng · cần thêm 1 nữa mới thử/);
    expect(text).toMatch(/Đã thử 3\/4 bài · thăm dò · 6% so với trung vị kênh 4%/);
    expect(text).toMatch(/Dùng bởi noi-dung/);
    expect(text).not.toMatch(/chứng minh/);
    // open the first card: the dead link is shown as not counted
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Bài chính sách đại lý kéo tin Zalo')!;
    await act(async () => { btn.click(); await wait(10); });
    expect(el.textContent).toMatch(/không còn, không tính/);
    const move = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Bỏ')!;
    await act(async () => { move.click(); await wait(30); });
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/m/learn/playbook/transition', body: { path: 'bai-hoc/a.md', to: 'bi-bac-bo' } });
  });
});

describe('Chờ duyệt', () => {
  it('lists proposals and accepts one', async () => {
    const items: ProposalView[] = [
      { id: 7, kind: 'transition', path: 'bai-hoc/b.md', title: 'Mở đầu bằng câu hỏi', from: 'dang-thu', to: 'da-kiem-chung', reason: 'ER trung vị 6% trên 4 bài thử (thăm dò)', proposedBy: 'module:learn', createdAt: 1, lesson: null },
      { id: 8, kind: 'new', path: 'bai-hoc/n.md', title: 'Bài hỏi đáp kéo tin Zalo', from: 'gia-thuyet', to: null, reason: '', proposedBy: 'agent:noi-dung', createdAt: 1, lesson: null },
    ];
    serve({ '/api/m/learn/pending': { items } });
    const el = await mount(<Router><Pending /></Router>);
    expect(el.textContent).toMatch(/Đề xuất kiểm chứng/);
    expect(el.textContent).toMatch(/Bot noi-dung/);
    const ok = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Duyệt: đã kiểm chứng')!;
    await act(async () => { ok.click(); await wait(30); });
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/m/learn/pending/7/accept')).toBe(true);
  });
});

describe('Tổng kết tuần', () => {
  it('shows the numbers and words, and approves the chosen lines', async () => {
    const note: WeeklyNoteDto = {
      year: 2026, week: 47, path: 'tong-ket/2026-tuan-47.md', from: '2026-11-16', to: '2026-11-22', approved: false, tasks: [],
      data: { so_lieu: { bai_dang: 2, bai_da_do: 2, er_trung_vi: 4, er_tuan_truoc: 3.8, nhap_gui_nguyen: 15, nhap_da_xu_ly: 19 } },
      body: '# Tuần 47\n\n## Cái được\n\n- Video ướp trà cao hơn trung vị\n\n## Cái hỏng\n\n- Bài chữ thứ Bảy thấp\n\n## Học được\n\n- Giả thuyết: [[bai-hoc/x|Bài đại lý]]\n',
      plan: [{ viec: 'Làm 2 video ngắn', ly_do: 'Theo bài học' }, { viec: 'Bổ sung phí ship', ly_do: 'Khách hỏi' }],
    };
    serve({
      '/api/m/learn/weekly/2026/47': note,
      '/api/m/learn/weekly': { folder: 'b1', dir: 'tong-ket/', items: [{ year: 2026, week: 47, path: note.path, from: note.from, to: note.to, medianEr: 4, posts: 2, newLessons: 1, approved: false }] },
      '/api/m/learn/pending': { items: [] },
    });
    const { hook } = memoryLocation({ path: '/m/learn/weekly' });
    const el = await mount(<Router hook={hook}><Route path="/m/learn/weekly" component={Weekly} /></Router>);
    for (let i = 0; i < 10 && !/Cái được/.test(el.textContent ?? ''); i++) await act(async () => { await wait(30); });
    const text = el.textContent ?? '';
    expect(text).toMatch(/Tuần 47 · 16\/11 đến 22\/11/);
    expect(text).toMatch(/79%/);
    expect(text).toMatch(/Video ướp trà cao hơn trung vị/);
    expect(text).toMatch(/Bài đại lý/);
    const boxes = el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    await act(async () => { boxes[1]!.click(); await wait(10); });
    const approve = [...el.querySelectorAll('button')].find((b) => /Duyệt kế hoạch tuần/.test(b.textContent ?? ''))!;
    expect(approve.textContent).toMatch(/1 việc/);
    await act(async () => { approve.click(); await wait(30); });
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/m/learn/weekly/2026/47/approve', body: { lines: [0] } });
  });

  it('reads the bullet lines of a section', () => {
    expect(sectionLines('## A\n- x\n- [[p|y]]\n## B\n- z\n', 'A')).toEqual(['x', 'y']);
    expect(sectionLines('## A\n\n_Chưa chọn agent._\n', 'A')).toEqual(['Chưa chọn agent.']);
  });
});

describe('Vòng học · Tổng quan', () => {
  it('shows the four steps and the two weekly measures', async () => {
    const week = (w: number, er: number | null, rate: number | null) => ({ year: 2026, week: w, from: '', to: '', posts: 1, measured: 1, medianEr: er, drafts: rate === null ? null : { botDrafts: 10, sentUnchanged: 5, sentEdited: 3, discarded: 2, notDelivered: 0, open: 0, unchangedRate: rate }, running: w === 48 });
    const dto: LoopDto = {
      folder: 'b1', moc: '24h', mocLabel: '24 giờ', careEnabled: true,
      weeks: [week(47, 2.9, 0.52), week(48, 4.2, 0.79)],
      counts: { 'gia-thuyet': 2, 'dang-thu': 2, 'da-kiem-chung': 3, 'bi-bac-bo': 1 }, lessons: 8, inUse: 3, measuredPosts: 9, posts: 9,
      changes: [{ path: 'bai-hoc/c.md', title: 'Đăng lúc 19 giờ', from: 'dang-thu', to: 'da-kiem-chung', actor: 'owner', reason: '', at: 1 }],
      testing: [{ path: 'bai-hoc/b.md', title: 'Mở đầu bằng câu hỏi', measured: 2, threshold: 4, label: 'ít mẫu' }],
      pending: 1,
    };
    serve({ '/api/m/learn/loop': dto, '/api/m/learn/pending': { items: [{}] } });
    const el = await mount(<Router><LoopOverview /></Router>);
    const text = el.textContent ?? '';
    expect(text).toMatch(/3 đã kiểm chứng, 2 đang thử, 2 giả thuyết, 1 bị bác bỏ/);
    expect(text).toMatch(/Từ 2,9% đến 4,2%/);
    expect(text).toMatch(/Từ 52% đến 79%/);
    expect(text).toMatch(/2\/4 bài đã đo · ít mẫu/);
    expect(text).toMatch(/Chờ duyệt1/);
  });
});

describe('Khớp sổ bài học (composer)', () => {
  it('scores as you type without the agent, and asks for the opening on request', async () => {
    const dto: ScoreDto = {
      state: 'ok', matched: 1, checkable: 2, unchecked: [], needsHook: true,
      hook: { moDau: null, label: null, source: 'none', note: null },
      lessons: [
        { path: 'bai-hoc/a.md', title: 'A', result: 'khop', checks: [{ rule: 'gio_dang', ok: true, text: 'Đúng giờ đăng (19–21 giờ)' }] },
        { path: 'bai-hoc/b.md', title: 'B', result: 'chua-khop', checks: [{ rule: 'dinh_dang', ok: false, text: 'Bài này là ảnh, bài học nói video ngắn' }] },
      ],
    };
    serve({ '/api/m/learn/score-draft': dto });
    const el = await mount(<Router><ScoreBox text="Ảnh trà sen" format="photo" scheduledAt={1795000000} hasVideo={false} /></Router>);
    await act(async () => { await wait(800); });
    expect(el.textContent).toMatch(/1\/2Khớp sổ bài học/);
    expect(el.textContent).toMatch(/Chưa khớp: Bài này là ảnh, bài học nói video ngắn/);
    expect(calls[0]).toMatchObject({ url: '/api/m/learn/score-draft', body: { text: 'Ảnh trà sen', format: 'photo', hook: false } });
    const ask = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Chấm cả kiểu mở đầu')!;
    await act(async () => { ask.click(); await wait(30); });
    expect(calls.at(-1)!.body).toMatchObject({ hook: true });
  });
});
