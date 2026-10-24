import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { ContentOverview, type MarketingOverviewDto } from './ContentOverview';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const range = { days: 2, from: '2026-10-23', to: '2026-10-24', prevFrom: '2026-10-21', prevTo: '2026-10-22' };
const period = { posts: 0, reach: null, interactions: null, engagementRate: null, clicks: null, commentsReceived: null, commentsReplied: null, postsWithMetrics: 0 };

function mount(dto: MarketingOverviewDto, key: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(dto), { status: 200, headers: { 'content-type': 'application/json' } })));
  const el = document.createElement('div');
  document.body.appendChild(el);
  // a distinct range per test keeps useFetch's module cache from leaking between tests
  return act(() => render(<Router><ContentOverview range={{ ...range, from: key }} /></Router>, el)).then(async () => {
    for (let i = 0; i < 30 && /Đang tải/.test(el.textContent ?? ''); i++) await act(async () => { await wait(50); });
    return el;
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('ContentOverview', () => {
  it('renders KPIs, top posts and per-page bars', async () => {
    const dto: MarketingOverviewDto = {
      current: { ...period, posts: 3, reach: 5000, interactions: 400, engagementRate: 0.08, commentsReceived: 12, commentsReplied: 9, postsWithMetrics: 3 },
      previous: { ...period, posts: 2, reach: 2500, interactions: 100, engagementRate: 0.04 },
      dailyBasis: 'post-publish-day',
      daily: [{ day: '2026-10-23', posts: 1, reach: 2000, interactions: 100 }, { day: '2026-10-24', posts: 2, reach: 3000, interactions: 300 }],
      topPosts: [{ postId: 'a', pageName: 'Page Một', snippet: 'Bài hay nhất', publishedAt: 1792700000, reach: 3000, interactions: 300, permalink: 'https://fb.example/a' }],
      pages: [{ pageId: 'P1', pageName: 'Page Một', posts: 3, reach: 5000, interactions: 400 }],
      metricsFetchedAt: 1792782178, hasPages: true,
    };
    const el = await mount(dto, 'a1');
    const text = el.textContent ?? '';
    expect(text).toMatch(/Bài đã đăng/);
    expect(text).toMatch(/5\.000/);
    expect(text).toMatch(/8,0%/);
    expect(text).toMatch(/12 \/ 9/);
    expect(text).toMatch(/Bài hay nhất/);
    expect(text).toMatch(/Tương tác theo Page/);
    expect(el.querySelector('a[href="https://fb.example/a"]')).not.toBeNull();
  });

  it('shows the empty state linking to Pages when no post was published', async () => {
    const dto: MarketingOverviewDto = { current: period, previous: period, dailyBasis: 'post-publish-day', daily: [], topPosts: [], pages: [], metricsFetchedAt: null, hasPages: true };
    const el = await mount(dto, 'b1');
    expect(el.textContent).toMatch(/Chưa có bài nào/);
    expect(el.querySelector('a[href="/m/marketing"]')).not.toBeNull();
  });
});
