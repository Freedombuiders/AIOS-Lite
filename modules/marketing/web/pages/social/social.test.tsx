import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Router } from 'wouter-preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { invalidateFetchCache } from '@/lib/useFetch';
import type { ChannelDashboardDto, ChannelKpi, PostsDashboardDto } from '@modules/marketing/web/lib/fbstudio';
import { SocialOverview } from './SocialOverview';
import { SocialFacebook } from './SocialFacebook';

// ── fake API ──────────────────────────────────────────────────────────────

interface Calls { gets: string[]; posts: { path: string; body: unknown }[] }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface Api {
  settings?: unknown;
  pages?: unknown;
  channel?: ChannelDashboardDto;
  posts?: (milestone: string) => PostsDashboardDto;
  refresh?: () => Response;
}

function install(api: Api): Calls {
  const calls: Calls = { gets: [], posts: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const path = url.pathname.replace(/^\/api/, '');
    if (init?.method === 'POST') {
      calls.posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
      if (path === '/m/marketing/analytics/refresh') return api.refresh?.() ?? json({ ok: true });
      return json({ error: 'không có' }, 404);
    }
    calls.gets.push(`${path}${url.search}`);
    if (path === '/m/marketing/settings') return json(api.settings ?? { composioKeyConfigured: true, enabled: true });
    if (path === '/m/marketing/pages') return json(api.pages ?? { pages: [page('P1', 'Trà Sen Việt')] });
    if (path === '/m/marketing/analytics/channel' && api.channel) return json(api.channel);
    if (path === '/m/marketing/analytics/posts' && api.posts) return json(api.posts(url.searchParams.get('milestone') ?? 'latest'));
    return json({ error: 'không có' }, 404);
  }));
  return calls;
}

function page(id: string, name: string) {
  return { id, name, enabled: true, role: '', mainKpi: '', timezone: 'Asia/Ho_Chi_Minh', pillars: [], status: 'ACTIVE', followers: 4280, syncedAt: 1, stats: { postsThisWeek: 0, scheduledThisWeek: 0, er28d: null, aiReplies24h: 0 } };
}

const kpi = (key: ChannelKpi['key'], label: string, value: number | null, extra: Partial<ChannelKpi> = {}): ChannelKpi => ({
  key, label, value, unit: 'count', delta: null, deltaUnit: 'pct', extra: null, spark: [], ...extra,
});

function days(n: number, f: (i: number) => number | null) {
  return Array.from({ length: n }, (_, i) => ({ day: `2026-11-${String(i + 1).padStart(2, '0')}`, reach: f(i) }));
}

function channel(over: Partial<ChannelDashboardDto> = {}): ChannelDashboardDto {
  return {
    page: { id: 'P1', name: 'Trà Sen Việt', role: '', mainKpi: '', followers: 4280, er28d: 4.2 },
    days: 28,
    posts: 9,
    kpis: [
      kpi('followers', 'Người theo dõi', 4280, { delta: 96, deltaUnit: 'count', extra: 96 }),
      kpi('reach', 'Reach', 38400, { delta: 18 }),
      kpi('er', 'ER trung vị', 4.2, { unit: 'pct', delta: 0.6, deltaUnit: 'pt' }),
      kpi('interactions', 'Tổng tương tác', 1930, { delta: -4 }),
      kpi('shareRate', 'Tỷ lệ chia sẻ', 3.1, { unit: 'permille', delta: 0, deltaUnit: 'pt' }),
      kpi('commentsPerPost', 'Bình luận mỗi bài', 6, { delta: 1, deltaUnit: 'count' }),
    ],
    reachDaily: days(5, (i) => [820, 760, 2140, 910, 1180][i]),
    followsDaily: [],
    funnel: [
      { key: 'impressions', label: 'Hiển thị', value: 52300 },
      { key: 'reach', label: 'Reach', value: 38400 },
      { key: 'engaged', label: 'Có tương tác', value: 1930 },
      { key: 'actions', label: 'Click link hoặc nhắn tin', value: 384 },
    ],
    mix: [],
    pillars: [{ name: 'Cách pha và ướp trà', posts: 4, postShare: 0.4, interactionShare: 0.5, index: 1.4, erMedian: 6.3, commentsPerPost: 7, sharesPerPost: 2, verdict: 'win' }],
    winner: 'Cách pha và ướp trà',
    formats: [
      { format: 'video', posts: 3, erMedian: 6.1 },
      { format: 'photo', posts: 5, erMedian: 3.2 },
      { format: 'link', posts: 1, erMedian: 9.9 },
      { format: 'album', posts: 0, erMedian: null },
    ],
    heat: [{ weekday: 1, slot: 4, er: 6.8, posts: 2 }, { weekday: 3, slot: 4, er: 6.3, posts: 1 }],
    top: [], bottom: [],
    insight: { summary: ['Video hướng dẫn kéo reach gấp đôi bài ảnh sản phẩm.', 'Bài đăng 19 giờ thứ Ba có ER cao nhất.'], actions: [], createdAt: 1790000000 },
    lastSnapshotAt: 1790000000,
    ...over,
  };
}

function posts(over: Partial<PostsDashboardDto> = {}, milestone: PostsDashboardDto['milestone'] = 'latest'): PostsDashboardDto {
  return {
    page: { id: 'P1', name: 'Trà Sen Việt' },
    days: 28,
    milestone,
    kpis: { posts: 2, postsDelta: 0, reach: 3000, reachDeltaPct: null, erMedian: 4, erDeltaPt: null, comments: 8, commentsDeltaPct: null, aiReplyRate: null },
    reachDaily: [],
    rows: [
      { postId: 'a', contentId: 1, title: 'Video ướp trà sen', format: 'reel', pillar: 'Cách pha và ướp trà', source: 'user', publishedAt: 1789000000, reach: 2140, er: 6.3, index: 1.5, comments: 12, shares: 5, avgWatchS: 14 },
      { postId: 'b', contentId: null, title: 'Bài chính sách đại lý', format: 'text', pillar: '', source: 'import', publishedAt: 1788000000, reach: null, er: null, index: null, comments: null, shares: null, avgWatchS: null },
    ],
    ...over,
  };
}

// ── harness ───────────────────────────────────────────────────────────────

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const roots: HTMLElement[] = [];

async function mount(ui: preact.VNode, until: RegExp): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  roots.push(el);
  await act(() => render(<Router>{ui}</Router>, el));
  for (let i = 0; i < 40 && !until.test(el.textContent ?? ''); i++) await act(async () => { await wait(25); });
  return el;
}

const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); await wait(25); });
const button = (el: HTMLElement, text: RegExp) => [...el.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));
const settle = () => act(async () => { await wait(60); });

beforeEach(() => { try { sessionStorage.clear(); } catch { /* ignore */ } invalidateFetchCache(); });
afterEach(async () => {
  for (const el of roots.splice(0)) { await act(() => render(null, el)); el.remove(); }
  vi.unstubAllGlobals();
});

// ── Tổng quan ─────────────────────────────────────────────────────────────

describe('Mạng xã hội › Tổng quan', () => {
  it('shows the Facebook card with numbers and the other channels as unsupported, without numbers', async () => {
    install({ channel: channel() });
    const el = await mount(<SocialOverview />, /Các kênh của bạn|ER trung vị/);
    const cards = el.querySelector('section[aria-label="Các kênh của bạn"]')!;
    expect(cards.textContent).toMatch(/Facebook · Trà Sen Việt/);
    expect(cards.textContent).toMatch(/Đã kết nối/);
    expect(cards.textContent).toMatch(/4\.280/); // followers
    expect(cards.textContent).toMatch(/38\.400/); // reach
    expect(cards.textContent).toMatch(/4,2%/);
    for (const name of ['YouTube', 'Instagram', 'TikTok']) {
      const card = [...cards.children].find((c) => c.textContent?.includes(name))!;
      expect(card.textContent).toMatch(/Chưa hỗ trợ ở bản này/);
      expect(card.textContent).not.toMatch(/\d/); // no fake numbers
    }
    expect(el.textContent).not.toMatch(/Số liệu minh họa/);
  });

  it('shows four KPIs against the previous period, highlights and the analyst summary', async () => {
    install({ channel: channel() });
    const el = await mount(<SocialOverview />, /Điểm nhấn/);
    const kpis = el.querySelector('section[aria-label="Chỉ số chính"]')!;
    expect(kpis.children.length).toBe(4);
    expect(kpis.textContent).toMatch(/▲ 18,0% so với kỳ trước/);
    expect(kpis.textContent).toMatch(/\+96 ròng · ▲ 96 so với kỳ trước/);
    expect(kpis.textContent).toMatch(/▲ 0,6 điểm so với kỳ trước/);
    expect(kpis.textContent).toMatch(/▼ 4,0% so với kỳ trước/);
    expect(el.textContent).toMatch(/Cách pha và ướp trà · ER 6,3%/);
    // the link format has 9,9% but only one post: video dài (3 posts) wins
    expect(el.textContent).toMatch(/Video dài · 3 bài · ER 6,1%/);
    expect(el.textContent).toMatch(/\+96 trong 28 ngày/);
    expect(el.querySelector('section[aria-label="Analyst tóm tắt"]')!.textContent).toMatch(/Video hướng dẫn kéo reach/);
  });

  it('draws reach per day with a tooltip, a spoken description and a table twin', async () => {
    install({ channel: channel() });
    const el = await mount(<SocialOverview />, /Reach mỗi ngày/);
    const group = el.querySelector('[role="group"][aria-label="Reach theo ngày"]')!;
    const bars = group.querySelectorAll('button');
    expect(bars.length).toBe(5);
    expect(bars[2].getAttribute('aria-label')).toBe('3/11: 2.140 người thấy bài');
    await act(async () => { bars[2].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); bars[2].dispatchEvent(new Event('mouseenter')); });
    await settle();
    expect(el.querySelector('[role="status"].absolute')!.textContent).toMatch(/2,1 N người/);
    const table = el.querySelector('.sr-only table')!;
    expect(table.querySelector('caption')!.textContent).toMatch(/Reach mỗi ngày/);
    expect(table.querySelectorAll('tbody tr').length).toBe(5);
    expect(el.querySelector('#social-reach-desc')!.textContent).toMatch(/Cao nhất 2\.140 người/);
  });

  it('keeps absent data absent: no 0, a reason instead, and no analyst block without a summary', async () => {
    install({
      channel: channel({
        page: { id: 'P1', name: 'Trà Sen Việt', role: '', mainKpi: '', followers: null, er28d: null },
        kpis: [
          kpi('followers', 'Người theo dõi', null),
          kpi('reach', 'Reach', null),
          kpi('er', 'ER trung vị', 3, { unit: 'pct' }),
          kpi('interactions', 'Tổng tương tác', null),
          kpi('shareRate', 'Tỷ lệ chia sẻ', null, { unit: 'permille' }),
          kpi('commentsPerPost', 'Bình luận mỗi bài', null),
        ],
        reachDaily: days(3, () => null),
        winner: null,
        pillars: [],
        formats: [{ format: 'video', posts: 2, erMedian: 8 }],
        insight: null,
      }),
    });
    const el = await mount(<SocialOverview />, /Điểm nhấn/);
    const kpis = el.querySelector('section[aria-label="Chỉ số chính"]')!;
    expect(kpis.textContent).toMatch(/Chưa lấy được số người theo dõi/);
    expect(kpis.textContent).toMatch(/Facebook chưa trả reach theo ngày/);
    expect(kpis.textContent).toMatch(/Chưa có kỳ trước để so/); // ER known, no previous period
    expect(kpis.textContent).not.toMatch(/(^|[^\d,.])0([^\d,.]|$)/);
    expect(el.textContent).toMatch(/Chưa đủ bài để chọn trụ nổi bật/);
    expect(el.textContent).toMatch(/Chưa có định dạng nào đủ 3 bài/);
    expect(el.textContent).toMatch(/Chưa có số theo dõi theo ngày/);
    expect(el.textContent).toMatch(/Facebook chưa trả số reach theo ngày/);
    expect(el.querySelector('section[aria-label="Analyst tóm tắt"]')).toBeNull();
    expect(el.textContent).not.toMatch(/Analyst tóm tắt/);
  });

  it('asks to fetch numbers when the connected Page has none yet', async () => {
    const calls = install({
      channel: channel({ page: { id: 'P1', name: 'Trà Sen Việt', role: '', mainKpi: '', followers: null, er28d: null }, posts: 0, reachDaily: days(2, () => null), lastSnapshotAt: null, insight: null }),
    });
    const el = await mount(<SocialOverview />, /Chưa có số liệu cho Page này/);
    expect(el.textContent).toMatch(/Chưa có số liệu cho Page này/);
    expect(el.textContent).toMatch(/Chưa hỗ trợ ở bản này/); // the other channels stay visible
    await click(button(el, /Lấy số liệu ngay/));
    expect(calls.posts).toEqual([{ path: '/m/marketing/analytics/refresh', body: { pageId: 'P1' } }]);
  });

  it('shows the empty state when no Page is connected, and the Composio one when there is no key', async () => {
    install({ pages: { pages: [] } });
    const el = await mount(<SocialOverview />, /Chưa bật Page nào/);
    expect(el.textContent).toMatch(/Chưa bật Page nào/);
    expect(el.querySelector('a[href="/m/marketing"]')).not.toBeNull();
    expect(button(el, /Lấy số liệu mới/)).toBeUndefined(); // nothing to refresh yet
    expect(el.querySelector('section[aria-label="Các kênh của bạn"]')).toBeNull();

    invalidateFetchCache();
    install({ settings: { composioKeyConfigured: false, enabled: true } });
    const el2 = await mount(<SocialOverview />, /Chưa nối Composio/);
    expect(el2.textContent).toMatch(/Chưa nối Composio/);
  });

  it('range selector re-reads the dashboard for 7 or 90 days and refresh calls marketing’s refresh', async () => {
    const calls = install({ channel: channel() });
    const el = await mount(<SocialOverview />, /Điểm nhấn/);
    const select = el.querySelector('select[aria-label="Khoảng thời gian"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['7', '28', '90']);
    await act(async () => { select.value = '7'; select.dispatchEvent(new Event('change', { bubbles: true })); await wait(50); });
    expect(calls.gets.some((g) => g.includes('/analytics/channel?page=P1&days=7'))).toBe(true);
    await click(button(el, /Lấy số liệu mới/));
    expect(calls.posts).toEqual([{ path: '/m/marketing/analytics/refresh', body: { pageId: 'P1' } }]);
  });

  it('the rate limit of the refresh is the server’s: a 429 is reported and the button is usable again', async () => {
    const calls = install({
      channel: channel(),
      refresh: () => json({ error: 'Vừa lấy số liệu xong, thử lại sau 9 phút' }, 429, { 'retry-after': '540' }),
    });
    const el = await mount(<SocialOverview />, /Điểm nhấn/);
    await click(button(el, /Lấy số liệu mới/));
    await settle();
    expect(calls.posts.length).toBe(1);
    expect((button(el, /Lấy số liệu mới/) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── Facebook ──────────────────────────────────────────────────────────────

describe('Mạng xã hội › Facebook', () => {
  const api = (over: Partial<Api> = {}): Api => ({ channel: channel(), posts: (m) => posts({}, m as PostsDashboardDto['milestone']), ...over });

  it('shows six KPIs with previous-period comparison, funnel, ER by format, heat table and posts', async () => {
    install(api());
    const el = await mount(<SocialFacebook />, /Hiệu quả bài đăng/);
    await settle();
    const kpis = el.querySelector('section[aria-label="Chỉ số chính"]')!;
    expect(kpis.children.length).toBe(6);
    expect(kpis.textContent).toMatch(/Tỷ lệ chia sẻ/);
    expect(kpis.textContent).toMatch(/3,1‰/);
    expect(kpis.textContent).toMatch(/▲ 18,0% so với kỳ trước/);
    expect(kpis.textContent).toMatch(/Không đổi so với kỳ trước/);

    expect(el.textContent).toMatch(/Phễu tương tác/);
    expect(el.textContent).toMatch(/52,3 N/);
    expect(el.textContent).toMatch(/Cứ 100 người thấy bài thì khoảng 1,0 người bấm link hoặc nhắn tin/);

    const formats = [...el.querySelectorAll('h2')].find((h) => /ER trung vị theo định dạng/.test(h.textContent ?? ''))!.closest('section')!;
    expect(formats.textContent).toMatch(/Video dài[\s\S]*6,1%[\s\S]*3 bài/);
    expect(formats.textContent).toMatch(/1 bài, chưa đủ kết luận/);
    expect(formats.textContent).toMatch(/Album[\s\S]*–[\s\S]*chưa có bài/);

    const heat = el.querySelector('.sr-only table caption')!;
    const heatTables = [...el.querySelectorAll('.sr-only table')].filter((t) => /thứ và khung giờ/.test(t.querySelector('caption')?.textContent ?? ''));
    expect(heat).not.toBeNull();
    expect(heatTables.length).toBe(1);
    expect(heatTables[0].querySelectorAll('tbody tr').length).toBe(7);
    expect(heatTables[0].textContent).toMatch(/6,8% \(2 bài\)/);
    expect(el.textContent).toMatch(/Ô tốt nhất: T3 18–21 giờ, ER 6,8%/);

    const table = [...el.querySelectorAll('table')].find((t) => /Hiệu quả bài đăng/.test(t.querySelector('caption')?.textContent ?? ''))!;
    expect([...table.querySelectorAll('th[scope="col"]')].map((h) => h.textContent)).toEqual(['Bài', 'Định dạng', 'Đăng lúc', 'Reach', 'ER', 'So với trung vị trang', 'Bình luận', 'Chia sẻ', 'TB xem']);
    expect(table.textContent).toMatch(/Video ướp trà sen/);
    expect(table.textContent).toMatch(/×1,5 · cao hơn trung vị/);
  });

  it('shows missing numbers in the table as absent, never 0', async () => {
    install(api());
    const el = await mount(<SocialFacebook />, /Bài chính sách đại lý/);
    await settle();
    const rows = [...el.querySelectorAll('tbody tr')].filter((r) => /Bài chính sách đại lý/.test(r.textContent ?? ''));
    expect(rows.length).toBe(1);
    const cells = [...rows[0].querySelectorAll('td')].map((c) => c.textContent);
    // định dạng, đăng lúc, reach, ER, so với, bình luận, chia sẻ, TB xem
    expect(cells.slice(2)).toEqual(['–', '–', '–', '–', '–', '–']);
    expect(el.textContent).toMatch(/Dấu “–” là chưa có số liệu, không phải 0/);
  });

  it('milestone selector re-reads the table at that milestone and explains old posts without it', async () => {
    const calls = install(api({
      posts: (m) => posts({ rows: m === 'latest' ? posts().rows : posts().rows.map((r) => ({ ...r, er: null, index: null })) }, m as PostsDashboardDto['milestone']),
    }));
    const el = await mount(<SocialFacebook />, /Hiệu quả bài đăng/);
    await settle();
    expect(button(el, /Hiện tại/)!.getAttribute('aria-pressed')).toBe('true');
    await click(button(el, /^7 ngày$/));
    await settle();
    expect(calls.gets.some((g) => g.includes('/analytics/posts?page=P1&days=28&milestone=7d'))).toBe(true);
    expect(button(el, /^7 ngày$/)!.getAttribute('aria-pressed')).toBe('true');
    expect(el.textContent).toMatch(/Số đo ở mốc 7 ngày sau khi đăng/);
    expect(el.textContent).toMatch(/Bài cũ chỉ có số liệu “Hiện tại”/);
  });

  it('keeps absent KPIs, funnel steps and the heatmap absent with a reason', async () => {
    install(api({
      channel: channel({
        kpis: channel().kpis.map((k) => (k.key === 'reach' || k.key === 'shareRate' ? { ...k, value: null, delta: null } : k)),
        funnel: [
          { key: 'impressions', label: 'Hiển thị', value: null },
          { key: 'reach', label: 'Reach', value: null },
          { key: 'engaged', label: 'Có tương tác', value: 1930 },
          { key: 'actions', label: 'Click link hoặc nhắn tin', value: null },
        ],
        heat: [],
        formats: [{ format: 'video', posts: 0, erMedian: null }],
      }),
      posts: () => posts({ rows: [] }),
    }));
    const el = await mount(<SocialFacebook />, /Phễu tương tác/);
    await settle();
    const kpis = el.querySelector('section[aria-label="Chỉ số chính"]')!;
    expect(kpis.textContent).toMatch(/Facebook chưa trả reach theo ngày/);
    expect(kpis.textContent).toMatch(/Cần cả số lượt chia sẻ và reach/);
    expect(el.textContent).toMatch(/Chưa có số liệu cho bước này/);
    expect(el.textContent).toMatch(/Chưa đủ số liệu reach và lượt bấm link, nhắn tin/);
    expect(el.textContent).toMatch(/Chưa có ô nào đủ dữ liệu/);
    expect(el.textContent).toMatch(/Chưa có bài nào đã đăng trong 28 ngày qua/);
    expect(el.textContent).not.toMatch(/Cứ 100 người/);
  });

  it('shows the empty state when no Page is connected', async () => {
    install({ pages: { pages: [] } });
    const el = await mount(<SocialFacebook />, /Chưa bật Page nào/);
    expect(el.textContent).toMatch(/Chưa bật Page nào/);
    expect(el.querySelector('section[aria-label="Chỉ số chính"]')).toBeNull();
  });

  it('asks to fetch numbers when the Page has no data yet', async () => {
    install(api({
      channel: channel({ page: { id: 'P1', name: 'Trà Sen Việt', role: '', mainKpi: '', followers: null, er28d: null }, posts: 0, reachDaily: days(2, () => null), lastSnapshotAt: null }),
    }));
    const el = await mount(<SocialFacebook />, /Chưa có số liệu cho Page này/);
    expect(el.textContent).toMatch(/Lấy số liệu ngay/);
    expect(el.querySelector('section[aria-label="Chỉ số chính"]')).toBeNull();
  });
});
