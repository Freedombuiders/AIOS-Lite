import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createTestHarness, type TestHarness } from '../modules/test-deps.js';
import { handleError } from './errors.js';
import { costsRoutes } from './routes/costs.js';

let h: TestHarness;
beforeEach(() => {
  h = createTestHarness({});
});
afterEach(() => h.cleanup());

const call = (path: string, init?: RequestInit) => {
  const app = new Hono();
  app.onError(handleError(h.deps.log));
  costsRoutes(app, h.deps);
  return app.request(path, init);
};

describe('costs routes', () => {
  it('summary validates days and returns totals', async () => {
    expect((await call('/api/costs/summary?days=5')).status).toBe(400);
    const res = await call('/api/costs/summary?days=7');
    expect(res.status).toBe(200);
    const j = (await res.json()) as { byDay: unknown[]; totals: { runs: number } };
    expect(j.byDay).toHaveLength(7);
    expect(j.totals.runs).toBe(0);
  });

  it('global budget round-trips through kv', async () => {
    const put = await call('/api/costs/budgets/global', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usdMonth: 50, warnPercent: 70 }) });
    expect(put.status).toBe(200);
    const j = (await (await call('/api/costs/budgets')).json()) as { global: { usdMonth: number; warnPercent: number }; month: string };
    expect(j.global).toMatchObject({ usdMonth: 50, warnPercent: 70 });
    const bad = await call('/api/costs/budgets/global', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usdMonth: -1 }) });
    expect(bad.status).toBe(400);
  });
});
