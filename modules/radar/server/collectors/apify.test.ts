import { describe, expect, it } from 'vitest';

import { ApifyError, memoryRotationStore, rotationOrder, runActorRotating, tokenFingerprint } from './apify.js';
import { testApify } from '../apify-integration.js';

type Call = { url: string; token: string };

/** Fake Apify: `refuse` maps token → HTTP status for run starts; every accepted run succeeds with one item. */
function fakeApify(refuse: Record<string, number> = {}) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const token = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
    calls.push({ url, token });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/runs') && init?.method === 'POST') {
      if (refuse[token]) return json({ error: { type: 'not-enough-usage-to-run-paid-actor', message: 'x' } }, refuse[token]);
      return json({ data: { id: `run-${token}`, status: 'SUCCEEDED', defaultDatasetId: `ds-${token}`, usageTotalUsd: 0.01 } });
    }
    if (url.includes('/datasets/')) return json([{ from: token }]);
    return json({ data: {} });
  }) as typeof fetch;
  return { f, calls };
}

const starts = (calls: Call[]) => calls.filter((c) => c.url.includes('/runs')).map((c) => c.token);

describe('Apify token rotation', () => {
  it('takes the tokens in turn, one step per run', async () => {
    const { f, calls } = fakeApify();
    const store = memoryRotationStore();
    for (let i = 0; i < 4; i++) await runActorRotating('a/b', {}, { tokens: ['k1', 'k2', 'k3'], store, fetchImpl: f, pollMs: 1 });
    expect(starts(calls)).toEqual(['k1', 'k2', 'k3', 'k1']);
  });

  it('skips a token that is out of credit, rests it, and uses the next one', async () => {
    const { f, calls } = fakeApify({ k1: 402 });
    const store = memoryRotationStore();
    const lines: string[] = [];
    const r = await runActorRotating('a/b', {}, { tokens: ['k1', 'k2', 'k3'], store, fetchImpl: f, pollMs: 1, onSwitch: (l) => lines.push(l), now: () => 1000 });
    expect(r.items).toEqual([{ from: 'k2' }]);
    expect(r.keyIndex).toBe(1);
    expect(lines[0]).toMatch(/Apify key 1: .*hết hạn mức.*Chuyển sang key 2/);
    expect(JSON.parse(store.get('radar.apify.rest')!)[tokenFingerprint('k1')]).toBe(1000 + 6 * 3_600_000);
    // While k1 rests, the rotation leaves it out.
    expect(rotationOrder(['k1', 'k2', 'k3'], store, 2000).map((o) => o.token)).not.toContain('k1');
    expect(starts(calls)).toEqual(['k1', 'k2']);
  });

  it('tries every token once when all of them rest, and reports when all are refused', async () => {
    const { f } = fakeApify({ k1: 402, k2: 401 });
    const store = memoryRotationStore();
    await expect(runActorRotating('a/b', {}, { tokens: ['k1', 'k2'], store, fetchImpl: f, pollMs: 1, now: () => 0 }))
      .rejects.toThrow(/Cả 2 Apify key đều bị từ chối/);
    expect(rotationOrder(['k1', 'k2'], store, 1).length).toBe(2);
  });

  it('does not switch tokens on an error that is not a refusal', async () => {
    const f = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(runActorRotating('a/b', {}, { tokens: ['k1', 'k2'], store: memoryRotationStore(), fetchImpl: f, pollMs: 1 }))
      .rejects.toBeInstanceOf(ApifyError);
  });
});

describe('Apify integration test', () => {
  it('checks each stored token and reports usage per key', async () => {
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const token = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
      if (token === 'bad') return new Response('{}', { status: 401 });
      if (String(input).endsWith('/limits')) return new Response(JSON.stringify({ data: { limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 1.25 } } }));
      return new Response(JSON.stringify({ data: { username: `user-${token}` } }));
    }) as typeof fetch;
    const r = await testApify({ api_token: 'a', api_token_2: 'bad', api_token_3: 'c' }, undefined, f);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('Key 1: user-a, tháng này đã dùng $1,25/$5,00');
    expect(r.detail).toContain('Key 2: token bị từ chối');
    expect(r.detail).toContain('dùng lần lượt 2 key');
    expect(r.accountLabel).toBe('user-a, user-c');
  });
});
