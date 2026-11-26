import { describe, expect, it } from 'vitest';
import { fakeCloud } from '../../packs/test-packs.js';
import type { IntegrationValues } from '../types.js';
import { CLOUD_INTEGRATION_ID, CLOUD_PENDING_ID, callbackPage, createCloudLogin } from './login.js';

function memStore(initial: Record<string, IntegrationValues> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    load: (id: string) => data.get(id) ?? null,
    save: (id: string, v: IntegrationValues) => void data.set(id, { ...v }),
    remove: (id: string) => void data.delete(id),
  };
}

function setup() {
  const cloud = fakeCloud();
  const store = memStore();
  let t = 1_000_000;
  const login = createCloudLogin({ store, host: '127.0.0.1', port: 4380, fetchImpl: cloud.fetchImpl, now: () => t });
  const { url } = login.start(cloud.base);
  const u = new URL(url);
  return { cloud, store, login, url: u, state: u.searchParams.get('state')!, tick: (ms: number) => (t += ms) };
}

describe('desktop sign-in to the cloud', () => {
  it('opens /auth/web/start with a loopback return URL and a random state; nothing stored in the clear', () => {
    const { url, state, store, cloud } = setup();
    expect(url.origin + url.pathname).toBe(`${cloud.base}/auth/web/start`);
    expect(url.searchParams.get('return')).toBe('http://127.0.0.1:4380/api/cloud/callback');
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const pending = store.data.get(CLOUD_PENDING_ID)!;
    expect(pending.cloud_url).toBe(cloud.base);
    expect(JSON.stringify(pending)).not.toContain(state);
  });

  it('rejects a wrong state: no exchange, nothing saved, and the real attempt still works', async () => {
    const { login, state, store, cloud } = setup();
    for (const bad of ['', 'x'.repeat(43), `${state}x`, state.slice(1)]) {
      const r = await login.callback({ code: cloud.exchange.code, state: bad });
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/không hợp lệ/) });
    }
    expect(cloud.calls).toEqual([]);
    expect(store.data.has(CLOUD_INTEGRATION_ID)).toBe(false);

    const ok = await login.callback({ code: cloud.exchange.code, state });
    expect(ok).toEqual({ ok: true, email: cloud.exchange.email });
    expect(store.data.get(CLOUD_INTEGRATION_ID)).toEqual({ cloud_url: cloud.base, session_token: cloud.exchange.token });
    expect(JSON.parse(cloud.calls[0]!.body!)).toMatchObject({ code: cloud.exchange.code, state, kind: 'machine' });
  });

  it('a state works once, and not after 10 minutes', async () => {
    const a = setup();
    await a.login.callback({ code: a.cloud.exchange.code, state: a.state });
    expect(await a.login.callback({ code: a.cloud.exchange.code, state: a.state })).toMatchObject({ ok: false });

    const b = setup();
    b.tick(10 * 60_000 + 1);
    expect(await b.login.callback({ code: b.cloud.exchange.code, state: b.state })).toMatchObject({ ok: false });
    expect(b.store.data.has(CLOUD_INTEGRATION_ID)).toBe(false);
  });

  it('cloud errors and a bad code end the attempt without saving a session', async () => {
    const a = setup();
    expect(await a.login.callback({ error: 'access_denied', state: a.state })).toEqual({ ok: false, message: 'Bạn đã huỷ đăng nhập Google.' });
    const b = setup();
    const r = await b.login.callback({ code: 'wrong-code', state: b.state });
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/HTTP 401/) });
    expect(JSON.stringify(r)).not.toContain('wrong-code');
    expect(b.store.data.has(CLOUD_INTEGRATION_ID)).toBe(false);
  });

  it('uses the saved cloud address and refuses a non-https one', () => {
    const store = memStore({ [CLOUD_INTEGRATION_ID]: { cloud_url: 'https://saved.example', session_token: '' } });
    const login = createCloudLogin({ store, host: '0.0.0.0', port: 5000 });
    expect(login.start().url).toMatch(/^https:\/\/saved\.example\/auth\/web\/start\?return=http%3A%2F%2F127\.0\.0\.1%3A5000/);
    expect(() => login.start('http://evil.example')).toThrow(/https/);
  });

  it('the landing page escapes what it shows', () => {
    expect(callbackPage({ ok: false, message: '<script>x</script>' })).not.toContain('<script>x');
  });
});
