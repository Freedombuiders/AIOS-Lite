import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { createCostService } from '../../work/costs.js';
import { badRequest } from '../errors.js';
import { body } from '../util.js';

const globalInput = z.object({
  usdMonth: z.number().min(0).max(1_000_000),
  warnPercent: z.number().min(1).max(100).default(80),
});

export function costsRoutes(app: Hono, deps: AppDeps): void {
  const svc = createCostService({ db: deps.db, agents: deps.agents });

  app.get('/api/costs/summary', (c) => {
    const days = Number(c.req.query('days') ?? 30);
    if (![7, 30, 90].includes(days)) throw badRequest('days phải là 7, 30 hoặc 90.');
    return c.json(svc.summary(days));
  });
  app.get('/api/costs/budgets', (c) => c.json(svc.budgets()));
  app.put('/api/costs/budgets/global', async (c) => {
    const input = await body(c, globalInput);
    svc.setGlobal(input);
    return c.json(svc.budgets().global);
  });
}
