/**
 * /analytics/* — read-only dashboards plus the manual refresh. The
 * dashboards are served from SQLite and never call Facebook. See ../types.ts.
 */

import type { Hono } from 'hono';
import { z } from 'zod';

import { getFbAnalyticsPage } from '../store.js';
import { logger } from '../compat.js';
import { clampDays, loadChannelDashboard, loadPostDetail, loadPostsDashboard } from './service.js';
import { buildMarketingOverview } from './overview.js';
import { startRefresh } from './worker.js';

const MILESTONES = ['latest', '24h', '7d', '28d'] as const;
const RefreshBody = z.object({ pageId: z.string().min(1) });

export function registerAnalyticsRoutes(app: Hono): void {
  // Cross-Page summary for the Tổng quan home section.
  app.get('/overview', (c) => {
    const out = buildMarketingOverview({
      from: c.req.query('from') ?? '', to: c.req.query('to') ?? '',
      prevFrom: c.req.query('prevFrom') || undefined, prevTo: c.req.query('prevTo') || undefined,
    });
    if ('error' in out) return c.json({ error: out.error }, 400);
    return c.json(out);
  });

  app.get('/analytics/channel', (c) => {
    const pageId = c.req.query('page') ?? '';
    if (!pageId) return c.json({ error: 'Thiếu tham số page' }, 400);
    const dto = loadChannelDashboard(pageId, clampDays(c.req.query('days')));
    if (!dto) return c.json({ error: 'Không tìm thấy Page' }, 404);
    return c.json(dto);
  });

  app.get('/analytics/posts', (c) => {
    const pageId = c.req.query('page') ?? '';
    if (!pageId) return c.json({ error: 'Thiếu tham số page' }, 400);
    // Default (also for a missing or unknown value): numbers to date.
    const asked = c.req.query('milestone') ?? '';
    const milestone = (MILESTONES as readonly string[]).includes(asked) ? asked : 'latest';
    const dto = loadPostsDashboard(pageId, clampDays(c.req.query('days')), milestone as (typeof MILESTONES)[number]);
    if (!dto) return c.json({ error: 'Không tìm thấy Page' }, 404);
    return c.json(dto);
  });

  app.get('/analytics/post/:postId', (c) => {
    const dto = loadPostDetail(c.req.param('postId'));
    if (!dto) return c.json({ error: 'Không tìm thấy bài đăng' }, 404);
    return c.json(dto);
  });

  app.post('/analytics/refresh', async (c) => {
    const body = RefreshBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Thiếu pageId' }, 400);
    const started = startRefresh(getFbAnalyticsPage(body.data.pageId));
    if (!started.ok) {
      if (started.retryAfterSec) c.header('Retry-After', String(started.retryAfterSec));
      return c.json({ error: started.error }, started.status);
    }
    started.done.catch((err) => logger.error({ err }, 'fbstudio analytics refresh failed'));
    return c.json({ ok: true });
  });
}
