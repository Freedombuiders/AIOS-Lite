import { afterEach, describe, expect, it, vi } from 'vitest';
import { crmApi } from './client';
import { applyFilter, EMPTY_FILTER, sortRows } from './filters';
import { dueChip } from './format';
import { obsidianUrl } from './obsidian';
import { NOW, ROWS } from './fixtures.test-util';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('crmApi.changeStage (the route a dragged card calls)', () => {
  it('PUTs care\'s customer-care route of the customer\'s own conversation with the revision it just read', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (init.method === 'PUT') return json({ ok: true });
      return json({
        id: 'c1', revision: 7,
        conversations: [{ id: 'g1', primaryCustomerId: 'other' }, { id: 'conv 1', primaryCustomerId: 'c1' }],
        tasks: [],
      });
    }));
    await crmApi.changeStage('c1', 'quoted');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/m/care/customers/c1', 'PUT /api/m/care/conversations/conv%201/customer-care']);
    expect(calls[1]!.body).toEqual({ expectedCustomerRevision: 7, customer: { stage: 'quoted' } });
  });

  it('refuses plainly when the customer has no conversation of their own', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'c1', revision: 1, conversations: [{ id: 'g1', primaryCustomerId: 'other' }], tasks: [] })));
    await expect(crmApi.changeStage('c1', 'won')).rejects.toThrow(/chưa có cuộc trò chuyện/);
  });

  it('passes care\'s refusal through', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit = {}) => (init.method === 'PUT'
      ? json({ error: { code: 'STALE_REVISION', message: 'Hồ sơ vừa được sửa ở nơi khác.' } }, 409)
      : json({ id: 'c1', revision: 1, conversations: [{ id: 'k', primaryCustomerId: 'c1' }], tasks: [] }))));
    await expect(crmApi.changeStage('c1', 'won')).rejects.toThrow('Hồ sơ vừa được sửa ở nơi khác.');
  });
});

describe('crmApi reads', () => {
  it('pages through every customer', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return json(url.includes('after=a') ? { items: [{ id: 'b' }], next: null } : { items: [{ id: 'a' }], next: 'a' });
    }));
    expect((await crmApi.customers()).map((r) => r.id)).toEqual(['a', 'b']);
    expect(urls).toEqual(['/api/m/crm/customers?limit=200', '/api/m/crm/customers?limit=200&after=a']);
  });

  it('reads the note through the existing brain file route', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return json({ content: '# x' }); }));
    await crmApi.noteFile('ban-hang', 'khach-hang/chi-lan.md');
    expect(urls).toEqual(['/api/brain/file?folder=ban-hang&path=khach-hang%2Fchi-lan.md']);
  });

  it('patches a task on care\'s task route', async () => {
    const calls: Array<[string, string, unknown]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { calls.push([url, init.method ?? '', JSON.parse(String(init.body))]); return json({}); }));
    await crmApi.patchTask('t 1', { expectedRevision: 3, done: true });
    expect(calls).toEqual([['/api/m/care/tasks/t%201', 'PATCH', { expectedRevision: 3, done: true }]]);
  });
});

describe('obsidianUrl', () => {
  it('builds obsidian://open?path= from the folder path and the note path', () => {
    expect(obsidianUrl('/Users/me/Brain/ban hang', 'khach-hang/chi-lan.md')).toBe('obsidian://open?path=%2FUsers%2Fme%2FBrain%2Fban%20hang%2Fkhach-hang%2Fchi-lan.md');
    expect(obsidianUrl('/a/b/', '/khach-hang/x.md')).toBe('obsidian://open?path=%2Fa%2Fb%2Fkhach-hang%2Fx.md');
    expect(obsidianUrl('C:\\Brain\\sales', 'khach-hang/x.md')).toBe('obsidian://open?path=C%3A%5CBrain%5Csales%5Ckhach-hang%2Fx.md');
  });
  it('gives no link without an absolute folder path or a note', () => {
    expect(obsidianUrl('./brain/x', 'a.md')).toBeNull();
    expect(obsidianUrl(undefined, 'a.md')).toBeNull();
    expect(obsidianUrl('/a', null)).toBeNull();
  });
});

describe('filters', () => {
  it('ignores diacritics and case in search, and matches tags exactly', () => {
    expect(applyFilter(ROWS, { ...EMPTY_FILTER, q: 'CHI LAN' }, NOW).map((r) => r.id)).toEqual(['lan']);
    expect(applyFilter(ROWS, { ...EMPTY_FILTER, q: '0901' }, NOW).map((r) => r.id)).toEqual(['lan']);
    expect(applyFilter(ROWS, { ...EMPTY_FILTER, tag: 'hoi si' }, NOW).map((r) => r.id).sort()).toEqual(['lan', 'minh']);
  });
  it('due filters use Vietnam days', () => {
    const ids = (due: Parameters<typeof applyFilter>[1]['due']) => applyFilter(ROWS, { ...EMPTY_FILTER, due }, NOW).map((r) => r.id).sort();
    expect(ids('late')).toEqual(['minh']);
    expect(ids('today')).toEqual(['hoa']);
    expect(ids('attention')).toEqual(['hoa', 'minh']);
    expect(ids('week')).toEqual(['hoa', 'lan']);
    expect(ids('none')).toEqual(['tuan']);
  });
  it('keeps customers without a follow-up last in both directions', () => {
    expect(sortRows(ROWS, { key: 'viec_tiep', dir: 'asc' }).map((r) => r.id)).toEqual(['minh', 'hoa', 'lan', 'tuan']);
    expect(sortRows(ROWS, { key: 'viec_tiep', dir: 'desc' }).map((r) => r.id)).toEqual(['lan', 'hoa', 'minh', 'tuan']);
  });
  it('labels due dates', () => {
    expect(dueChip(null, NOW)).toEqual({ text: 'Chưa có việc', tone: 'none' });
    expect(dueChip(NOW - 3 * 86_400_000, NOW)).toEqual({ text: 'Quá hạn 23/11', tone: 'late' });
    expect(dueChip(NOW + 3_600_000, NOW).text).toBe('Hôm nay');
    expect(dueChip(NOW + 2 * 86_400_000, NOW).text).toBe('28/11');
  });
});
