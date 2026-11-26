import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { memoryLocation } from 'wouter-preact/memory-location';
import { Route } from 'wouter-preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { invalidateFetchCache } from '@/lib/useFetch';
import { ContentLab } from './ContentLab';
import { ContentNote } from './ContentNote';
import type { ContentLabDto, PostDto } from '../lib/types';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cell = (o: Partial<{ n: number; posts: number; medianEr: number | null; lowSample: boolean; notTried: boolean; unmeasured: boolean }>) => ({
  n: 0, posts: 0, medianEr: null, lowSample: false, notTried: false, unmeasured: false, ...o,
});
const status = { state: 'ok' as const, folder: 'b1', cursor: 4, backfilledFolder: 'b1', notes: 3, lastRunAt: 1, lastError: null };

function serve(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
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

describe('Phân tích nội dung', () => {
  it('shows medians with counts, low-sample and untried cells, and the posts', async () => {
    const dto: ContentLabDto = {
      status, dir: 'noi-dung/bai/', mocs: [{ value: '24h', label: '24 giờ' }, { value: '7d', label: '7 ngày' }],
      stats: {
        moc: '24h', days: 90, platform: 'facebook', totals: { posts: 3, measured: 2 },
        matrix: {
          rows: [{ key: 'video-ngan', label: 'Video ngắn' }], cols: [{ key: 'A', label: 'Cách pha' }, { key: 'B', label: 'Quà Tết' }, { key: 'C', label: 'Đại lý' }],
          cells: [[cell({ n: 3, posts: 3, medianEr: 6.5 }), cell({ n: 1, posts: 1, medianEr: 4.2, lowSample: true }), cell({ notTried: true })]],
        },
        byHook: [{ key: 'cau-hoi', label: 'Câu hỏi', ...cell({ n: 2, posts: 2, medianEr: 5, lowSample: true }) }],
        byLength: [],
        posts: [{ path: 'noi-dung/bai/a.md', title: 'Cách ướp trà', format: 'video-ngan', formatLabel: 'Video ngắn', pillar: 'Cách pha', hook: 'cau-hoi', hookLabel: 'Câu hỏi', length: '38 giây', publishedAt: '2026-11-24T19:00:00+07:00', reach: 6200, er: 7.1, measured: ['24h'] }],
      },
    };
    serve({ '/api/m/learn/content-lab': dto });
    const el = await mount(<Router><ContentLab /></Router>);
    const text = el.textContent ?? '';
    expect(text).toMatch(/6,5%/);
    expect(text).toMatch(/3 bài/);
    expect(text).toMatch(/1 bài · ít mẫu/);
    expect(text).toMatch(/Chưa thử/);
    expect(text).toMatch(/Mạnh nhất: video ngắn về cách pha \(6,5%, 3 bài\)/);
    expect(text).toMatch(/6\.200/);
    expect(el.querySelector(`a[href="/m/learn/posts/${encodeURIComponent('noi-dung/bai/a.md')}"]`)).not.toBeNull();
  });

  it('asks for a brain folder when none is chosen', async () => {
    serve({
      '/api/m/learn/content-lab': { status: { ...status, state: 'no-folder', folder: '', notes: 0 }, dir: 'noi-dung/bai/', mocs: [], stats: null },
      '/brain/folders': { items: [{ id: 'b1', name: 'Trà sen', path: '/x' }] },
    });
    const el = await mount(<Router><ContentLab /></Router>);
    expect(el.textContent).toMatch(/Chưa chọn thư mục Second Brain/);
    expect(el.textContent).toMatch(/Ghi bài vào thư mục này/);
  });
});

describe('Phân tích một bài', () => {
  it('shows properties, milestones and the comparison', async () => {
    const dto: PostDto = {
      folder: 'b1', path: 'noi-dung/bai/a.md', days: 90, mocs: [{ value: '24h', label: '24 giờ' }],
      data: {
        loai: 'bai-dang', id: 7, nen_tang: 'facebook', tieu_de: 'Cách ướp trà sen', tru_cot: 'Cách pha', dang_luc: '2026-11-24T19:00:00+07:00',
        so_do: [{ moc: '1h', reach: 640, er: 9 }, { moc: '24h', reach: 4300, er: 7.1, tb_xem: 21 }],
      },
      body: '# Cách ướp trà sen\n\nBạn có biết?\n\n<!-- aios:begin so-do -->\n| bảng |\n<!-- aios:end so-do -->\n',
      comparison: { moc: '24h', mocLabel: '24 giờ', er: 7.1, reach: 4300, others: { n: 23, medianEr: 4.2, lowSample: false }, sameFormat: { n: 5, medianEr: 6, lowSample: false, label: 'Video ngắn' }, diffPct: 69 },
    };
    serve({ '/api/m/learn/posts/': dto, '/brain/folders': { items: [] } });
    const { hook } = memoryLocation({ path: `/m/learn/posts/${encodeURIComponent('noi-dung/bai/a.md')}` });
    const el = await mount(<Router hook={hook}><Route path="/m/learn/posts/:path" component={ContentNote} /></Router>);
    const text = el.textContent ?? '';
    expect(text).toMatch(/Cách ướp trà sen/);
    expect(text).toMatch(/Cao hơn trung vị 69%/);
    expect(text).toMatch(/4\.300/);
    expect(text).toMatch(/Trung vị 23 bài Facebook khác/);
    expect(text).toMatch(/Bạn có biết\?/);
    expect(text).not.toMatch(/\| bảng \|/);
  });
});
