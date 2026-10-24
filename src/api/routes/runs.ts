import type { Hono } from 'hono';
import type { AccessSnapshot } from '../../access/contracts.js';
import type { AppDeps } from '../../core/deps.js';
import { parseJson } from '../../core/db.js';
import type { RunStatus } from '../../core/types.js';
import { badRequest } from '../errors.js';
import { found, intParam, limitParam, optInt } from '../util.js';

export function runsRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/runs', (c) => {
    const status = c.req.query('status') as RunStatus | undefined;
    if (status && !['running', 'done', 'failed', 'cancelled'].includes(status)) throw badRequest('Tham số status không hợp lệ.');
    return c.json({
      items: deps.runs.list({ taskId: optInt(c, 'taskId'), agentId: c.req.query('agentId') || undefined, status, limit: limitParam(c), beforeId: optInt(c, 'beforeId') }),
    });
  });

  app.get('/api/runs/:id', (c) => {
    const run = found(deps.runs.get(intParam(c)), 'lượt chạy');
    return c.json({
      run,
      events: deps.runs.events(run.id, { afterId: optInt(c, 'afterEventId') }),
      access: parseJson<AccessSnapshot | null>(run.accessJson, null),
    });
  });
}
