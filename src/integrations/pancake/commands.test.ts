import { describe, expect, it, vi } from 'vitest';

import { IntegrationUsageError, type IntegrationCommand, type IntegrationValues, type ParsedArgs } from '../types.js';
import { buildPancakeCommands, pancakeCommands } from './commands.js';
import { pancakeIntegration } from './index.js';

const KEY = 'sekret-api-key-123';
const TOKEN = 'sekret-token-9';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Routes by URL path so a command can make several calls in any order. */
function routedFetch(routes: Record<string, (url: URL, init?: RequestInit) => unknown>) {
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const key = `${init?.method ?? 'GET'} ${url.pathname.replace('/api/public_api', '').replace('/api/v1', '')}`;
    const handler = routes[key];
    if (!handler) throw new Error(`no route for ${key}`);
    return json(handler(url, init));
  });
  return fn;
}

function setup(values: IntegrationValues, routes: Record<string, (url: URL, init?: RequestInit) => unknown> = {}) {
  const fetchImpl = routedFetch(routes);
  const commands = buildPancakeCommands({ fetchImpl, sleepImpl: async () => {} });
  const run = (name: string, argv: string[] = [], flags: ParsedArgs['flags'] = {}) => {
    const cmd = commands.find((c) => c.name === name) as IntegrationCommand;
    expect(cmd, `command ${name}`).toBeDefined();
    return cmd.run({ agentId: 'main', values }, { positionals: argv, flags });
  };
  return { run, fetchImpl };
}

const POS: IntegrationValues = { pos_api_key: KEY, shop_id: '42' };
const CHAT1: IntegrationValues = { page_tokens: `111:${TOKEN}` };
const CHAT2: IntegrationValues = { page_tokens: `111:${TOKEN}, 222:other-token` };

const rawOrder = {
  id: 1001, display_id: 55, status: 17, status_name: 'x', inserted_at: '2026-10-01T03:00:00',
  updated_at: '2026-10-02T03:00:00', bill_full_name: 'Nguyen A', bill_phone_number: '0912345678',
  customer: { id: 'cust-1' }, conversation_id: 'conv-1', page_id: '111', total_price: '350000',
  total_discount: 0, shipping_fee: 30000, cod: 380000, note: 'giao gấp',
  items: [{ variation_id: 'v1', product_id: 'p1', quantity: 2, variation_info: { name: 'Áo M', retail_price: 175000 } }],
  shipping_address: { full_name: 'Nguyen A', phone_number: '0912345678', full_address: '1 Le Loi, Q1, HCM' },
  tags: [{ id: 1, name: 'vip' }], partner: { partner_status: 'on_the_way', extend_code: 'GHN1' },
  secretInternalField: 'x',
};

describe('static shape', () => {
  it('names every command uniquely and marks write commands', () => {
    const names = pancakeCommands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(pancakeCommands.filter((c) => c.access === 'write').map((c) => c.name).sort())
      .toEqual(['orders create', 'orders set-status', 'reply', 'tag']);
    for (const c of pancakeCommands) expect(c.description.length).toBeGreaterThan(10);
  });
  it('is wired into the definition', () => {
    expect(pancakeIntegration.id).toBe('pancake');
    expect(pancakeIntegration.commands).toBe(pancakeCommands);
    expect(pancakeIntegration.fields.map((f) => f.key)).toEqual(['pos_api_key', 'shop_id', 'page_tokens']);
    expect(pancakeIntegration.fields.every((f) => !f.required)).toBe(true);
  });
});

describe('credential guards', () => {
  it('POS commands without an API key tell the agent what is missing', async () => {
    const { run, fetchImpl } = setup(CHAT1);
    await expect(run('orders list')).rejects.toThrow(/Chưa nhập API key Pancake POS/);
    await expect(run('orders list')).rejects.toBeInstanceOf(IntegrationUsageError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('chat commands without tokens say so', async () => {
    const { run } = setup(POS);
    await expect(run('pages')).rejects.toThrow(/Chưa nhập page access token Pancake/);
    await expect(run('tags')).rejects.toThrow(/Chưa nhập page access token Pancake/);
  });
  it('rejects unknown flags and lists the valid ones', async () => {
    const { run } = setup(POS, {});
    await expect(run('orders list', [], { phone: '09' })).rejects.toThrow(/--phone.*--status/s);
  });
});

describe('orders list', () => {
  const routes = { 'GET /shops/42/orders': () => ({ success: true, data: [rawOrder], page_number: 1, page_size: 20, total_entries: 1, total_pages: 1 }) };

  it('parses filters into the query and returns compact orders', async () => {
    const { run, fetchImpl } = setup(POS, routes);
    const res: any = await run('orders list', [], { status: 'confirmed,huy,17', since: '2026-10-01', search: '0912', limit: '500', sort: 'updated' });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.getAll('filter_status[]')).toEqual(['1', '6', '17']);
    expect(url.searchParams.get('page_size')).toBe('100');
    expect(url.searchParams.get('search')).toBe('0912');
    expect(url.searchParams.get('startDateTime')).toBe(String(Date.parse('2026-10-01T00:00:00+07:00') / 1000));
    expect(url.searchParams.get('updateStatus')).toBe('updated_at');
    expect(url.searchParams.get('option_sort')).toBe('last_updated_order_desc');

    expect(res).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    const o = res.items[0];
    expect(o).toMatchObject({
      id: '1001', displayId: '55', status: { code: 17, name: 'Waiting for confirmation' },
      customer: { id: 'cust-1', name: 'Nguyen A', phone: '0912345678' },
      total: 350000, shippingFee: 30000, cod: 380000, carrierStatus: 'on_the_way',
      conversationId: 'conv-1', pageId: '111', tags: ['vip'], note: 'giao gấp',
    });
    expect(o.items).toEqual([{ variationId: 'v1', name: 'Áo M', qty: 2, price: 175000 }]);
    expect(o.shipTo.address).toBe('1 Le Loi, Q1, HCM');
    expect(o.secretInternalField).toBeUndefined();
    expect(o.discount).toBe(0);
  });

  it('--full returns the raw response', async () => {
    const { run } = setup(POS, routes);
    const res: any = await run('orders list', [], { full: true });
    expect(res.data[0].secretInternalField).toBe('x');
  });

  it('rejects a bad status with the table', async () => {
    const { run } = setup(POS, routes);
    await expect(run('orders list', [], { status: 'banana' })).rejects.toThrow(/banana.*0=New/s);
  });

  it('auto-discovers the shop when none is stored', async () => {
    const { run, fetchImpl } = setup({ pos_api_key: KEY }, {
      'GET /shops': () => ({ success: true, shops: [{ id: 7, name: 'A' }, { id: 9, name: 'B', preferred_shop: true }] }),
      'GET /shops/9/orders': () => ({ success: true, data: [] }),
    });
    await run('orders list');
    expect(fetchImpl.mock.calls.map((c) => new URL(c[0]).pathname)).toEqual(['/api/v1/shops', '/api/v1/shops/9/orders']);
  });

  it('--shop overrides the stored shop', async () => {
    const { run, fetchImpl } = setup(POS, { 'GET /shops/5/orders': () => ({ success: true, data: [] }) });
    await run('orders list', [], { shop: '5' });
    expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe('/api/v1/shops/5/orders');
  });
});

describe('orders get / customers / products', () => {
  it('orders get unwraps {data} and requires an id', async () => {
    const { run } = setup(POS, { 'GET /shops/42/orders/1001': () => ({ success: true, data: rawOrder }) });
    const res: any = await run('orders get', ['1001']);
    expect(res.id).toBe('1001');
    await expect(run('orders get')).rejects.toThrow(/orderId/);
    const full: any = await run('orders get', ['1001'], { full: true });
    expect(full.secretInternalField).toBe('x');
  });

  it('customers search joins words and maps compactly', async () => {
    const { run, fetchImpl } = setup(POS, {
      'GET /shops/42/customers': () => ({
        success: true, total_entries: 1, data: [{
          id: 'c1', name: 'Tran B', phone_numbers: ['0900000001'], emails: [], order_count: 3,
          succeed_order_count: 2, purchased_amount: 900000, last_order_at: '2026-09-30T00:00:00', reward_point: 0,
        }],
      }),
    });
    const res: any = await run('customers search', ['Tran', 'B']);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('search')).toBe('Tran B');
    expect(res.items[0]).toEqual({
      id: 'c1', name: 'Tran B', phones: ['0900000001'], orders: 3, succeededOrders: 2,
      totalSpent: 900000, points: 0, lastOrderAt: '2026-09-30T00:00:00',
    });
    await expect(run('customers search')).rejects.toThrow(/từ khóa/);
  });

  it('products low-stock sends the threshold and maps warehouse stock', async () => {
    const { run, fetchImpl } = setup(POS, {
      'GET /shops/42/products/variations': () => ({
        success: true, total_entries: 1, data: [{
          id: 'var-1', display_id: 'AO01', retail_price: 150000, remain_quantity: 2,
          product: { name: 'Áo thun' },
          variations_warehouses: [{ warehouse_id: 'w1', remain_quantity: 2, available_quantity: 1, actual_remain_quantity: 3 }],
        }],
      }),
    });
    const res: any = await run('products low-stock', [], { max: '3' });
    expect(JSON.parse(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('remainQuantity')!).value).toBe(3);
    expect(res.maxStock).toBe(3);
    expect(res.items[0]).toEqual({
      id: 'var-1', sku: 'AO01', name: 'Áo thun', price: 150000, stock: 2,
      warehouses: [{ warehouseId: 'w1', stock: 2, available: 1, onHand: 3 }],
    });
  });

  it('statuses makes no API call', async () => {
    const { run, fetchImpl } = setup({});
    const res: any = await run('statuses');
    expect(res.statuses).toContainEqual({ code: 17, name: 'Waiting for confirmation' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('orders create', () => {
  const flags = { name: 'Nguyen A', phone: '0912345678', address: '1 Le Loi, Q1', items: 'AO01:2:150000,QUAN02' };
  const created = () => ({ success: true, data: { id: 2002, status: 0, items: [] } });

  it('builds the body, injects shop_id and the only warehouse', async () => {
    const { run, fetchImpl } = setup(POS, {
      'GET /shops/42/warehouses': () => ({ data: [{ id: 'w-1', name: 'Kho chính' }] }),
      'POST /shops/42/orders': created,
    });
    const res: any = await run('orders create', [], { ...flags, note: 'gấp', 'shipping-fee': '25000', conversation: 'cv1', 'page-id': '111' });
    const post = fetchImpl.mock.calls.find((c) => c[1]?.method === 'POST')!;
    const body = JSON.parse(String(post[1]?.body));
    expect(body).toMatchObject({
      shop_id: 42, warehouse_id: 'w-1', bill_full_name: 'Nguyen A', bill_phone_number: '0912345678',
      shipping_fee: 25000, note: 'gấp', conversation_id: 'cv1', page_id: '111',
      shipping_address: { address: '1 Le Loi, Q1', province_id: '', district_id: '', commune_id: '' },
    });
    expect(body.items).toEqual([
      { variation_id: 'AO01', quantity: 2, variation_info: { retail_price: 150000 } },
      { variation_id: 'QUAN02', quantity: 1 },
    ]);
    expect(res).toMatchObject({ created: true, order: { id: '2002' } });
  });

  it('uses --warehouse without listing warehouses', async () => {
    const { run, fetchImpl } = setup(POS, { 'POST /shops/42/orders': created });
    await run('orders create', [], { ...flags, warehouse: 'w-9' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).warehouse_id).toBe('w-9');
  });

  it('lists warehouses when there are several and none was given', async () => {
    const { run, fetchImpl } = setup(POS, {
      'GET /shops/42/warehouses': () => ({ data: [{ id: 'a', name: 'Kho A' }, { id: 'b', name: 'Kho B' }] }),
    });
    await expect(run('orders create', [], flags)).rejects.toThrow(/--warehouse is required.*a \(Kho A\), b \(Kho B\)/);
    expect(fetchImpl.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
  });

  it('accepts --json and still injects shop_id', async () => {
    const { run, fetchImpl } = setup(POS, { 'POST /shops/42/orders': created });
    await run('orders create', [], {
      json: JSON.stringify({ bill_full_name: 'X', warehouse_id: 'w', items: [{ variation_id: 'v', quantity: 1 }] }),
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({ shop_id: 42, bill_full_name: 'X' });
  });

  it('validates input before any write', async () => {
    const { run, fetchImpl } = setup(POS, { 'POST /shops/42/orders': created });
    await expect(run('orders create', [], { name: 'A' })).rejects.toThrow(/--phone, --address, --items/);
    await expect(run('orders create', [], { ...flags, items: 'AO01:x' })).rejects.toThrow(/sai định dạng/);
    await expect(run('orders create', [], { json: '{bad' })).rejects.toThrow(/JSON/);
    await expect(run('orders create', [], { ...flags, conversation: 'cv' })).rejects.toThrow(/--page-id/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('orders set-status', () => {
  it('sends the numeric status', async () => {
    const { run, fetchImpl } = setup(POS, { 'PUT /shops/42/orders/1001': () => ({ success: true, data: { id: 1001, status: 1 } }) });
    const res: any = await run('orders set-status', ['1001', 'da-xac-nhan']);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ status: 1 });
    expect(res).toMatchObject({ updated: true, orderId: '1001', status: { code: 1, name: 'Confirmed' } });
  });
  it('rejects unknown statuses and missing args', async () => {
    const { run, fetchImpl } = setup(POS);
    await expect(run('orders set-status', ['1001', 'whatever'])).rejects.toThrow(/không hợp lệ/);
    await expect(run('orders set-status', ['1001'])).rejects.toThrow(/trạng thái/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('command risk', () => {
  const setStatus = pancakeCommands.find((c) => c.name === 'orders set-status') as IntegrationCommand;
  const risk = (status: string) => setStatus.riskOf!({ positionals: ['1001', status], flags: {} });

  it('treats cancelling or deleting an order as destructive and other status changes as plain writes', () => {
    for (const s of ['6', 'huy', 'da-huy', 'Canceled', '7', 'xoa', 'deleted']) expect(risk(s), s).toBe('destructive');
    for (const s of ['1', 'da-xac-nhan', 'cho-xac-nhan', 'whatever']) expect(risk(s), s).toBe('write');
    expect(setStatus.riskOf!({ positionals: ['1001'], flags: {} })).toBe('write');
  });

  it('adds no other destructive command: messages and tags stay plain writes', () => {
    expect(pancakeCommands.filter((c) => c.risk === 'destructive')).toEqual([]);
  });
});

describe('chat commands', () => {
  const convs = {
    'GET /v2/pages/111/conversations': () => ({
      conversations: [
        { id: 'c2', type: 'INBOX', snippet: 'Giá bao nhiêu', seen: false, message_count: 4, has_phone: true, recent_phone_numbers: ['0912345678'], from: { id: 'u1', name: 'Nguyen A' }, updated_at: '2026-10-07T01:00:00', tags: [3] },
        { id: 'c1', type: 'COMMENT', snippet: 'ok', seen: true, from: { id: 'u2', name: 'B' }, post_id: 'p1' },
      ],
    }),
  };

  it('uses the only configured page without --page', async () => {
    const { run, fetchImpl } = setup(CHAT1, convs);
    const res: any = await run('conversations list', [], { type: 'inbox', since: '24h' });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.getAll('type[]')).toEqual(['INBOX']);
    expect(url.searchParams.has('since')).toBe(true);
    expect(res).toMatchObject({ page: '111', count: 2, next: 'c1' });
    expect(res.items[0]).toEqual({
      id: 'c2', type: 'INBOX', customer: 'Nguyen A', customerId: 'u1', snippet: 'Giá bao nhiêu',
      unread: true, messages: 4, hasPhone: true, phones: ['0912345678'], updatedAt: '2026-10-07T01:00:00', tags: [3],
    });
  });

  it('--unread keeps only unseen conversations', async () => {
    const { run } = setup(CHAT1, convs);
    const res: any = await run('conversations list', [], { unread: true });
    expect(res.items.map((c: any) => c.id)).toEqual(['c2']);
  });

  it('requires --page when several pages are configured, and validates it', async () => {
    const { run, fetchImpl } = setup(CHAT2, convs);
    await expect(run('conversations list')).rejects.toThrow('--page is required: configured pages are 111, 222.');
    await expect(run('conversations list', [], { page: '999' })).rejects.toThrow(/999.*111, 222/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await run('conversations list', [], { page: '111' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a range over a month', async () => {
    const { run } = setup(CHAT1, convs);
    await expect(run('conversations list', [], { since: '90d' })).rejects.toThrow(/1 tháng/);
  });

  it('pages lists ids only, never tokens', async () => {
    const { run } = setup(CHAT2);
    const res = await run('pages');
    expect(res).toEqual({ pages: ['111', '222'] });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it('messages are plain text, oldest first, with a next offset', async () => {
    const { run, fetchImpl } = setup(CHAT1, {
      'GET /v1/pages/111/conversations/c1/messages': () => ({
        success: true,
        messages: [
          { id: 'm2', from: { id: '111', name: 'Shop' }, message: '<div>Dạ <b>còn</b> hàng&nbsp;ạ</div>', inserted_at: '2026-10-07T01:02:00' },
          { id: 'm1', from: { id: 'u1', name: 'A' }, original_message: 'Còn hàng không?', message: '<p>x</p>', inserted_at: '2026-10-07T01:00:00', attachments: [{ type: 'photo', url: 'https://img/1.jpg' }] },
        ],
      }),
    });
    const res: any = await run('messages', ['c1'], { offset: '30' });
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('current_count')).toBe('30');
    expect(res.messages.map((m: any) => [m.by, m.text])).toEqual([['customer', 'Còn hàng không?'], ['page', 'Dạ còn hàng ạ']]);
    expect(res.messages[0].attachments).toEqual([{ type: 'photo', url: 'https://img/1.jpg' }]);
    expect(res.nextOffset).toBe(32);
  });

  it('tags lists id and text', async () => {
    const { run } = setup(CHAT1, { 'GET /v1/pages/111/tags': () => ({ tags: [{ id: 5, text: 'vip', color: '#fff' }] }) });
    expect(await run('tags')).toEqual({ page: '111', tags: [{ id: '5', text: 'vip', color: '#fff' }] });
  });

  it('reply sends the text and requires --text', async () => {
    const { run, fetchImpl } = setup(CHAT1, { 'POST /v1/pages/111/conversations/c1/messages': () => ({ success: true, id: 'm9' }) });
    const res = await run('reply', ['c1'], { text: 'Chào bạn' });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({ action: 'reply_inbox', message: 'Chào bạn' });
    expect(res).toEqual({ sent: true, page: '111', conversationId: 'c1', messageId: 'm9' });
    await expect(run('reply', ['c1'])).rejects.toThrow(/--text/);
    await expect(run('reply', ['c1'], { text: true })).rejects.toThrow(/--text/);
  });

  it('tag adds by default and removes with --remove', async () => {
    const { run, fetchImpl } = setup(CHAT1, { 'POST /v1/pages/111/conversations/c1/tags': () => ({ success: true }) });
    await run('tag', ['c1', '5']);
    await run('tag', ['c1', '5'], { remove: true });
    expect(fetchImpl.mock.calls.map((c) => JSON.parse(String(c[1]?.body)))).toEqual([
      { action: 'add', tag_id: '5' }, { action: 'remove', tag_id: '5' },
    ]);
  });
});
