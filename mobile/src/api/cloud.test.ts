import { createCloudClient, DEFAULT_TIMEOUT_MS, type CloudClientOptions } from './cloud';
import { CloudError, errorMessageKey } from './errors';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const err = (status: number, code: string, message = 'Lỗi.') => json(status, { error: { code, message } });

type Fetch = typeof fetch;
function client(fetchImpl: Fetch, over: Partial<CloudClientOptions> = {}) {
  const onUnauthorized = jest.fn();
  const api = createCloudClient({ baseUrl: 'https://cloud.test/', getToken: () => 'tok_secret_123', onUnauthorized, fetch: fetchImpl, ...over });
  return { api, onUnauthorized };
}
const fetchOf = (impl: (url: string, init: RequestInit) => Promise<Response>) => jest.fn(impl) as unknown as jest.MockedFunction<Fetch>;

async function failure(p: Promise<unknown>): Promise<CloudError> {
  try { await p; } catch (e) { return e as CloudError; }
  throw new Error('expected a rejection');
}

describe('cloud client: session expiry (401)', () => {
  it('reports the rejected token, clears nothing itself, and throws unauthorized', async () => {
    const f = fetchOf(async () => err(401, 'unauthorized', 'Phiên đăng nhập không còn hiệu lực. Hãy đăng nhập lại.'));
    const { api, onUnauthorized } = client(f);
    const e = await failure(api.me());
    expect(e).toBeInstanceOf(CloudError);
    expect(e.kind).toBe('unauthorized');
    expect(e.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith('tok_secret_123');
  });

  it('does the same for every authenticated call, not just /me', async () => {
    const { api, onUnauthorized } = client(fetchOf(async () => err(401, 'unauthorized')));
    for (const call of [() => api.listPacks(), () => api.getPack('x'), () => api.revokeSession('s'), () => api.deleteAccount(), () => api.logout()]) {
      expect((await failure(call())).kind).toBe('unauthorized');
    }
    expect(onUnauthorized).toHaveBeenCalledTimes(5);
  });

  it('does not treat a 401 on sign-in as an expired session: the Google token was refused', async () => {
    const { api, onUnauthorized } = client(fetchOf(async () => err(401, 'unauthorized', 'ID token Google không hợp lệ hoặc đã hết hạn.')));
    const e = await failure(api.signInWithGoogle('google-id-token'));
    expect(e.kind).toBe('credentials');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('fails without a request when there is no token', async () => {
    const f = fetchOf(async () => json(200, {}));
    const { api, onUnauthorized } = client(f, { getToken: () => null });
    expect((await failure(api.me())).kind).toBe('unauthorized');
    expect(f).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('cloud client: disabled account (403)', () => {
  it('maps a 403 on sign-in to "disabled" and keeps the cloud message for logs', async () => {
    const { api, onUnauthorized } = client(fetchOf(async () => err(403, 'forbidden', 'Tài khoản đã bị khoá. Hãy liên hệ quản trị viên.')));
    const e = await failure(api.signInWithGoogle('google-id-token'));
    expect(e.kind).toBe('disabled');
    expect(e.status).toBe(403);
    expect(e.serverMessage).toContain('khoá');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('a 403 on an authenticated call is "forbidden", not a sign-out', async () => {
    const { api, onUnauthorized } = client(fetchOf(async () => err(403, 'forbidden')));
    expect((await failure(api.listPacks())).kind).toBe('forbidden');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('cloud client: network failure', () => {
  it('surfaces a network error when fetch rejects', async () => {
    const { api, onUnauthorized } = client(fetchOf(async () => { throw new TypeError('Network request failed'); }));
    const e = await failure(api.listPacks());
    expect(e.kind).toBe('network');
    expect(e.retryable).toBe(true);
    expect(errorMessageKey(e)).toBe('errors.network');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('gives up after the time limit instead of waiting for ever', async () => {
    jest.useFakeTimers();
    try {
      const f = fetchOf((_url, init) => new Promise((_res, rej) => {
        init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }));
      const { api } = client(f, { timeoutMs: 5_000 });
      const pending = failure(api.listPacks());
      await jest.advanceTimersByTimeAsync(5_000);
      const e = await pending;
      expect(e.kind).toBe('timeout');
      expect(errorMessageKey(e)).toBe('errors.timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses a 15 second default limit', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
  });

  it('stays a network error (not a timeout) when the caller aborts', async () => {
    const controller = new AbortController();
    const f = fetchOf((_url, init) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const { api } = client(f);
    const pending = failure(api.listPacks({}, controller.signal));
    controller.abort();
    expect((await pending).kind).toBe('network');
  });

  it('maps a 500 to "server", 429 to "rate_limited", 404 to "not_found"', async () => {
    const kinds: [number, string][] = [[500, 'server'], [502, 'server'], [429, 'rate_limited'], [404, 'not_found'], [400, 'bad_request']];
    for (const [status, kind] of kinds) {
      const { api } = client(fetchOf(async () => err(status, 'x')));
      expect((await failure(api.getPack('x'))).kind).toBe(kind);
    }
  });

  it('survives an HTML error page from a proxy', async () => {
    const { api } = client(fetchOf(async () => new Response('<html>Bad gateway</html>', { status: 502 })));
    expect((await failure(api.listPacks())).kind).toBe('server');
  });

  it('rejects a 200 that is not JSON, or not an object, as invalid_response', async () => {
    expect((await failure(client(fetchOf(async () => new Response('ok', { status: 200 }))).api.listPacks())).kind).toBe('invalid_response');
    expect((await failure(client(fetchOf(async () => json(200, [1, 2]))).api.listPacks())).kind).toBe('invalid_response');
    expect((await failure(client(fetchOf(async () => new Response('', { status: 200 }))).api.listPacks())).kind).toBe('invalid_response');
  });

  it('reports "not_configured" when the app has no cloud address', async () => {
    const f = fetchOf(async () => json(200, {}));
    const { api } = client(f, { baseUrl: '' });
    expect((await failure(api.listPacks())).kind).toBe('not_configured');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('cloud client: requests', () => {
  it('sends the bearer token, the module filter and a trimmed search', async () => {
    const f = fetchOf(async () => json(200, { items: [] }));
    const { api } = client(f);
    await api.listPacks({ module: 'learn', q: '  trà ' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://cloud.test/packs?module=learn&q=${encodeURIComponent('trà')}`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_secret_123');
  });

  it('omits empty filters and does not send a token on sign-in', async () => {
    const f = fetchOf(async () => json(200, { token: 't', user: {}, session: {} }));
    const { api } = client(f);
    await api.signInWithGoogle('gid', 'iPhone');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cloud.test/auth/google');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ idToken: 'gid', kind: 'mobile', label: 'iPhone' });
    await api.listPacks({ q: '   ' });
    expect(f.mock.calls[1][0]).toBe('https://cloud.test/packs');
  });

  it('escapes ids in paths', async () => {
    const f = fetchOf(async () => json(200, { ok: true }));
    const { api } = client(f);
    await api.revokeSession('a/b c');
    expect(f.mock.calls[0][0]).toBe('https://cloud.test/me/sessions/a%2Fb%20c');
    expect((f.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('never puts the token or the ID token in an error', async () => {
    const f = fetchOf(async () => err(500, 'internal', 'Lỗi máy chủ'));
    const { api } = client(f);
    const e1 = await failure(api.me());
    const e2 = await failure(api.signInWithGoogle('google-id-token-value'));
    for (const e of [e1, e2]) {
      expect(JSON.stringify({ m: e.message, s: e.serverMessage, c: e.code, k: e.kind, st: e.stack })).not.toMatch(/tok_secret_123|google-id-token-value/);
    }
  });
});
