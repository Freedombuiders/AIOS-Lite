import { describe, expect, it, vi } from 'vitest';

import { testPancake } from './index.js';

const KEY = 'sekret-api-key-123';
const TOKEN = 'sekret-token-9';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchBy(handler: (url: URL) => Response) {
  return vi.fn(async (input: string) => handler(new URL(input)));
}

const shops = {
  success: true,
  shops: [
    { id: 11, name: 'Shop Một' },
    { id: 22, name: 'Shop Hai', preferred_shop: true },
  ],
};

describe('testPancake', () => {
  it('requires at least one credential', async () => {
    const res = await testPancake({}, undefined, { fetchImpl: fetchBy(() => json({})) });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/ít nhất/);
  });

  it('discovers the preferred shop when none is stored', async () => {
    const fetchImpl = fetchBy(() => json(shops));
    const res = await testPancake({ pos_api_key: KEY }, undefined, { fetchImpl });
    expect(res).toMatchObject({ ok: true, accountLabel: 'Shop Hai', discovered: { shop_id: '22' } });
    expect(res.detail).toBe('Đã kết nối Pancake POS: shop Shop Hai (id 22)');
  });

  it('keeps a stored shop id that belongs to the key, and flags one that does not', async () => {
    const fetchImpl = fetchBy(() => json(shops));
    const keep = await testPancake({ pos_api_key: KEY, shop_id: '11' }, undefined, { fetchImpl });
    expect(keep.discovered).toEqual({ shop_id: '11' });
    expect(keep.accountLabel).toBe('Shop Một');
    const wrong = await testPancake({ pos_api_key: KEY, shop_id: '999' }, undefined, { fetchImpl });
    expect(wrong.discovered).toEqual({ shop_id: '22' });
    expect(wrong.detail).toMatch(/999/);
  });

  it('reports a rejected key without echoing it', async () => {
    const fetchImpl = fetchBy(() => json({ success: false, message: 'api_key is invalid', error_code: 105 }, 403));
    const res = await testPancake({ pos_api_key: KEY }, undefined, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('api_key is invalid');
    expect(res.detail).not.toContain(KEY);
  });

  it('reports a network failure without throwing or leaking', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError(`fetch failed api_key=${KEY}`); });
    const res = await testPancake({ pos_api_key: KEY }, undefined, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.detail).not.toContain(KEY);
  });

  it('fails when the key has no shops', async () => {
    const res = await testPancake({ pos_api_key: KEY }, undefined, { fetchImpl: fetchBy(() => json({ success: true, shops: [] })) });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/không truy cập được shop/);
  });

  it('tests POS and pages together', async () => {
    const fetchImpl = fetchBy((url) => (url.pathname.endsWith('/shops') ? json(shops) : json({ tags: [] })));
    const res = await testPancake({ pos_api_key: KEY, page_tokens: `1:${TOKEN}\n2:${TOKEN}b` }, undefined, { fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.detail).toBe('Đã kết nối Pancake POS: shop Shop Hai (id 22) · 2 page chat');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('names the page whose token failed and never includes tokens', async () => {
    const fetchImpl = fetchBy((url) => {
      if (url.pathname.endsWith('/shops')) return json(shops);
      return url.pathname.includes('/pages/2/') ? json({ success: false, message: 'Invalid token' }, 401) : json({ tags: [] });
    });
    const res = await testPancake({ pos_api_key: KEY, page_tokens: `1:${TOKEN} 2:${TOKEN}b` }, undefined, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('page 2');
    expect(res.detail).not.toContain('page 1:');
    expect(res.detail).not.toContain(TOKEN);
    expect(res.discovered).toBeUndefined();
  });

  it('works with page tokens only', async () => {
    const res = await testPancake({ page_tokens: `1:${TOKEN}` }, undefined, { fetchImpl: fetchBy(() => json({ tags: [] })) });
    expect(res).toMatchObject({ ok: true, accountLabel: 'Page 1' });
    expect(res.discovered).toBeUndefined();
  });

  it('rejects malformed page tokens before calling anything', async () => {
    const fetchImpl = fetchBy(() => json({}));
    const res = await testPancake({ page_tokens: 'justatoken' }, undefined, { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/page_id:token/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
