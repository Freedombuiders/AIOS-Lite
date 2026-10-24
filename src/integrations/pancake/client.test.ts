import { describe, expect, it, vi } from 'vitest';

import { IntegrationApiError, IntegrationUsageError } from '../types.js';
import {
  createPancakePagesClient,
  createPancakePosClient,
  orderStatusName,
  parseOrderStatus,
  parsePageTokens,
  parseTimeArg,
} from './client.js';

const KEY = 'sekret-api-key-123';
const TOKEN = 'sekret-page-token-456';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function mockFetch(...responses: Array<Response | Error>) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  return fn;
}

const noSleep = async () => {};

describe('POS client', () => {
  it('puts api_key in the query and builds filter_status[] repeats', async () => {
    const fetchImpl = mockFetch(json({ success: true, data: [], total_entries: 0 }));
    const client = createPancakePosClient({ apiKey: KEY, shopId: 42, fetchImpl });
    await client.listOrders({
      pageSize: 20, pageNumber: 2, search: '0912', filterStatus: [1, 2],
      startDateTime: 100, endDateTime: 200, updateStatus: 'updated_at', optionSort: 'inserted_at_desc',
      customerId: 'c1',
    });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://pos.pages.fm/api/v1/shops/42/orders');
    expect(url.searchParams.get('api_key')).toBe(KEY);
    expect(url.searchParams.getAll('filter_status[]')).toEqual(['1', '2']);
    expect(url.searchParams.get('page_size')).toBe('20');
    expect(url.searchParams.get('page_number')).toBe('2');
    expect(url.searchParams.get('startDateTime')).toBe('100');
    expect(url.searchParams.get('updateStatus')).toBe('updated_at');
    expect(url.searchParams.get('customer_id')).toBe('c1');
  });

  it('omits updateStatus without a time range and skips empty params', async () => {
    const fetchImpl = mockFetch(json({ success: true, data: [] }));
    await createPancakePosClient({ apiKey: KEY, shopId: 1, fetchImpl }).listOrders({ updateStatus: 'updated_at', search: '' });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.has('updateStatus')).toBe(false);
    expect(url.searchParams.has('search')).toBe(false);
  });

  it('encodes the stock filter as JSON in remainQuantity', async () => {
    const fetchImpl = mockFetch(json({ success: true, data: [] }));
    await createPancakePosClient({ apiKey: KEY, shopId: 1, fetchImpl }).listVariations({ remainAtMost: 5 });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v1/shops/1/products/variations');
    expect(JSON.parse(url.searchParams.get('remainQuantity')!)).toEqual({ type: 'smallerOrEqual', value: 5, warehouseId: 'all' });
  });

  it('getOrder accepts a bare order and a {data: order} wrapper', async () => {
    const bare = mockFetch(json({ id: 7, status: 1 }));
    expect(await createPancakePosClient({ apiKey: KEY, shopId: 1, fetchImpl: bare }).getOrder(7)).toMatchObject({ id: 7 });
    const wrapped = mockFetch(json({ success: true, data: { id: 8, status: 2 } }));
    expect(await createPancakePosClient({ apiKey: KEY, shopId: 1, fetchImpl: wrapped }).getOrder(8)).toMatchObject({ id: 8 });
  });

  it('sends JSON bodies for create and update', async () => {
    const fetchImpl = mockFetch(json({ success: true, data: { id: 1 } }), json({ success: true }));
    const client = createPancakePosClient({ apiKey: KEY, shopId: 1, fetchImpl });
    await client.createOrder({ shop_id: 1, items: [] });
    await client.updateOrder(9, { status: 6 });
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ shop_id: 1, items: [] });
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('PUT');
    expect(new URL(fetchImpl.mock.calls[1][0]).pathname).toBe('/api/v1/shops/1/orders/9');
  });

  it('asks for a shop id with guidance when none is set', async () => {
    const client = createPancakePosClient({ apiKey: KEY, fetchImpl: mockFetch() });
    expect(() => client.listOrders()).toThrow(IntegrationUsageError);
    expect(() => client.listOrders()).toThrow(/--shop/);
  });

  it('retries 429 with backoff and then succeeds', async () => {
    const fetchImpl = mockFetch(json({}, 429), json({}, 429, { 'retry-after': '2' }), json({ success: true, shops: [] }));
    const sleepImpl = vi.fn(async (_ms: number) => {});
    const shops = await createPancakePosClient({ apiKey: KEY, fetchImpl, sleepImpl }).listShops();
    expect(shops).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it('gives up after two retries on 429', async () => {
    const fetchImpl = mockFetch(json({}, 429), json({}, 429), json({}, 429));
    await expect(createPancakePosClient({ apiKey: KEY, fetchImpl, sleepImpl: noSleep }).listShops())
      .rejects.toMatchObject({ name: 'IntegrationApiError', status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('treats success:false on HTTP 200 as an error and keeps the message', async () => {
    const fetchImpl = mockFetch(json({ success: false, message: 'api_key is invalid', error_code: 105 }));
    const err = await createPancakePosClient({ apiKey: KEY, fetchImpl }).listShops().catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationApiError);
    expect(err.message).toContain('api_key is invalid');
  });

  it('uses the error field and message_code when there is no message', async () => {
    const a = await createPancakePosClient({ apiKey: KEY, shopId: 1, fetchImpl: mockFetch(json({ success: false, error: 'order_not_found' }, 404)) })
      .getOrder(1).catch((e) => e);
    expect(a.message).toContain('order_not_found');
    expect(a.status).toBe(404);
    const b = await createPancakePagesClient({ pageId: 'p1', pageAccessToken: TOKEN, fetchImpl: mockFetch(json({ success: false, message_code: 'blocked_by_user' })) })
      .replyInbox('c1', 'hi').catch((e) => e);
    expect(b.message).toContain('blocked_by_user');
  });

  it('never leaks the key or the URL in errors', async () => {
    const cases: Array<Response | Error> = [
      json({ success: false, message: `bad key ${KEY}` }, 403),
      json({ message: `see https://pos.pages.fm/api/v1/shops?api_key=${KEY}` }, 400),
      new TypeError(`fetch failed https://pos.pages.fm/api/v1/shops?api_key=${KEY}`),
      new Response('<html>oops</html>', { status: 502 }),
    ];
    for (const c of cases) {
      const err = await createPancakePosClient({ apiKey: KEY, fetchImpl: mockFetch(c) }).listShops().catch((e) => e);
      expect(err).toBeInstanceOf(IntegrationApiError);
      expect(err.message).not.toContain(KEY);
      expect(err.message).not.toContain('api_key=');
      expect(err.message).not.toContain('https://');
    }
  });

  it('never leaks the page token', async () => {
    const err = await createPancakePagesClient({
      pageId: 'p1', pageAccessToken: TOKEN,
      fetchImpl: mockFetch(new Error(`boom page_access_token=${TOKEN}`)),
    }).listTags().catch((e) => e);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('p1');
  });

  it('reports a cancelled request distinctly', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); });
    const err = await createPancakePosClient({ apiKey: KEY, fetchImpl, signal: ac.signal }).listShops().catch((e) => e);
    expect(err.message).toMatch(/cancelled/);
  });
});

describe('Pages client', () => {
  it('builds conversation, message, reply and tag requests', async () => {
    const fetchImpl = mockFetch(
      json({ conversations: [] }), json({ success: true, messages: [] }),
      json({ success: true, id: 'm1' }), json({ tags: [{ id: 1, text: 'vip' }] }), json({ success: true }),
    );
    const client = createPancakePagesClient({ pageId: '123', pageAccessToken: TOKEN, fetchImpl });
    await client.listConversations({ lastConversationId: 'c9', types: ['INBOX', 'COMMENT'], since: 10, until: 20, unreadFirst: true });
    await client.getMessages('c1', 30);
    await client.replyInbox('c1', 'Chào bạn');
    expect(await client.listTags()).toEqual([{ id: 1, text: 'vip' }]);
    await client.setConversationTag('c1', '5', 'remove');

    const u0 = new URL(fetchImpl.mock.calls[0][0]);
    expect(u0.origin + u0.pathname).toBe('https://pages.fm/api/public_api/v2/pages/123/conversations');
    expect(u0.searchParams.get('page_access_token')).toBe(TOKEN);
    expect(u0.searchParams.getAll('type[]')).toEqual(['INBOX', 'COMMENT']);
    expect(u0.searchParams.get('last_conversation_id')).toBe('c9');
    expect(u0.searchParams.get('unread_first')).toBe('true');

    const u1 = new URL(fetchImpl.mock.calls[1][0]);
    expect(u1.pathname).toBe('/api/public_api/v1/pages/123/conversations/c1/messages');
    expect(u1.searchParams.get('current_count')).toBe('30');

    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toEqual({ action: 'reply_inbox', message: 'Chào bạn' });
    expect(JSON.parse(String(fetchImpl.mock.calls[4][1]?.body))).toEqual({ action: 'remove', tag_id: '5' });
  });

  it('turns a failed reply (HTTP 200, success:false) into an error', async () => {
    const fetchImpl = mockFetch(json({ success: false, message_code: 'outside_24h_window' }));
    await expect(createPancakePagesClient({ pageId: '1', pageAccessToken: TOKEN, fetchImpl }).replyInbox('c', 'x'))
      .rejects.toThrow(/outside_24h_window/);
  });
});

describe('parsePageTokens', () => {
  it('splits on commas, spaces and newlines, at the first colon', () => {
    expect(parsePageTokens('111:abc, 222:de:f\n333:ghi  444:jkl')).toEqual([
      { pageId: '111', token: 'abc' },
      { pageId: '222', token: 'de:f' },
      { pageId: '333', token: 'ghi' },
      { pageId: '444', token: 'jkl' },
    ]);
  });
  it('skips malformed entries, dedupes by page, tolerates empty', () => {
    expect(parsePageTokens('nocolon, :x, 5:, 6:a, 6:b')).toEqual([{ pageId: '6', token: 'b' }]);
    expect(parsePageTokens(undefined)).toEqual([]);
    expect(parsePageTokens('')).toEqual([]);
  });
});

describe('parseOrderStatus', () => {
  it('accepts codes, English and Vietnamese names', () => {
    expect(parseOrderStatus('1')).toBe(1);
    expect(parseOrderStatus(6)).toBe(6);
    expect(parseOrderStatus('new')).toBe(0);
    expect(parseOrderStatus('moi')).toBe(0);
    expect(parseOrderStatus('Confirmed')).toBe(1);
    expect(parseOrderStatus('da-xac-nhan')).toBe(1);
    expect(parseOrderStatus('Đã xác nhận')).toBe(1);
    expect(parseOrderStatus('shipped')).toBe(2);
    expect(parseOrderStatus('received')).toBe(3);
    expect(parseOrderStatus('canceled')).toBe(6);
    expect(parseOrderStatus('cancelled')).toBe(6);
    expect(parseOrderStatus('huy')).toBe(6);
    expect(parseOrderStatus('waiting-for-confirmation')).toBe(17);
    expect(parseOrderStatus('Waiting for pick up')).toBe(9);
  });
  it('returns null for unknown input', () => {
    expect(parseOrderStatus('banana')).toBeNull();
    expect(parseOrderStatus('99')).toBeNull();
    expect(parseOrderStatus('')).toBeNull();
  });
  it('names codes', () => {
    expect(orderStatusName(17)).toBe('Waiting for confirmation');
    expect(orderStatusName(123)).toBe('Unknown');
  });
});

describe('parseTimeArg', () => {
  const now = Date.parse('2026-10-07T00:00:00Z');
  const nowS = now / 1000;
  it('reads relative durations', () => {
    expect(parseTimeArg('24h', { now })).toBe(nowS - 86400);
    expect(parseTimeArg('7d', { now })).toBe(nowS - 7 * 86400);
    expect(parseTimeArg('30m', { now })).toBe(nowS - 1800);
    expect(parseTimeArg('2w', { now })).toBe(nowS - 14 * 86400);
  });
  it('reads dates as Vietnam time, with an end-of-day option', () => {
    const start = Date.parse('2026-10-01T00:00:00+07:00') / 1000;
    expect(parseTimeArg('2026-10-01')).toBe(start);
    expect(parseTimeArg('2026-10-01', { endOfDay: true })).toBe(start + 86399);
  });
  it('reads unix seconds and milliseconds and ISO datetimes', () => {
    expect(parseTimeArg('1760000000')).toBe(1760000000);
    expect(parseTimeArg('1760000000000')).toBe(1760000000);
    expect(parseTimeArg('2026-10-01T00:00:00Z')).toBe(Date.parse('2026-10-01T00:00:00Z') / 1000);
  });
  it('rejects nonsense with guidance', () => {
    expect(() => parseTimeArg('yesterday')).toThrow(IntegrationUsageError);
    expect(() => parseTimeArg('yesterday')).toThrow(/7d/);
  });
});
