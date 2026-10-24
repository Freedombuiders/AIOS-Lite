import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, apiPost, qs, setToken, tokenizedSseUrl } from './api';

function respond(status: number, body: unknown) {
  return Promise.resolve(new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('api client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('prefixes /api and sends the bearer token from localStorage', async () => {
    setToken('abc');
    fetchMock.mockReturnValue(respond(200, { items: [] }));
    await expect(apiGet('/tasks')).resolves.toEqual({ items: [] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/tasks');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer abc');
  });

  it('does not double-prefix /api paths and sends JSON bodies', async () => {
    fetchMock.mockReturnValue(respond(201, { id: 1 }));
    await apiPost('/api/tasks', { prompt: 'x' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/tasks');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"prompt":"x"}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('maps the API error shape to ApiError', async () => {
    fetchMock.mockReturnValue(respond(412, { error: { code: 'requirements_missing', message: 'Thiếu kết nối composio' } }));
    const err = await apiPost('/modules/care/add').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(412);
    expect(err.code).toBe('requirements_missing');
    expect(err.message).toBe('Thiếu kết nối composio');
  });

  it('reports a Vietnamese network error when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('failed'));
    const err = await apiGet('/health').catch((e) => e);
    expect(err.code).toBe('network');
    expect(err.message).toMatch(/máy chủ/);
  });

  it('builds query strings and tokenized SSE urls', () => {
    expect(qs({ a: 1, b: '', c: undefined, d: 'x y' })).toBe('?a=1&d=x+y');
    expect(qs({})).toBe('');
    expect(tokenizedSseUrl('/api/events')).toBe('/api/events');
    setToken('t k');
    expect(tokenizedSseUrl('/api/events')).toBe('/api/events?token=t%20k');
    expect(tokenizedSseUrl('/api/events?types=task')).toBe('/api/events?types=task&token=t%20k');
  });
});
