/** HTTP API of Radar (Radar thị trường). All JSON; errors are { error } in Vietnamese. */

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { toolStatus, openBrowserLogin } from './collectors/index.js';
import { ConfigError, loadConfig, resetConfig, saveConfig, setEnabled } from './config.js';
import { defaultRadarConfig } from './defaults.js';
import { buildIndexPayload, countsOf } from './index-payload.js';
import { isLayerBusy, queueLayer, queueState } from './pipeline.js';
import { renderIndex, renderReport } from './render/index.js';
import { getReport, getRun, getRunLog, lastOkDay, listReports, listRuns, saveReport } from './store.js';
import { safeTimezone } from './time.js';
import { LAYER_KEYS, type LayerKey, type RenderLinks } from './types.js';
import { lastMarker, nextRunAt } from './worker.js';

export interface ReportSummary {
  date: string;
  layer: LayerKey;
  layerLabel: string;
  sessions: number;
  newPosts: number;
  newPains: number;
  items: number;
  updatedAt: string;
}

const LINKS: RenderLinks = {
  report: (date, layer) => `/m/radar/${date}/${layer}`,
  index: () => '/m/radar',
};

const layerSchema = z.enum(['vn', 'world', 'nganh'], { message: 'Lớp phải là vn, world hoặc nganh' });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải có dạng YYYY-MM-DD');

export function registerRadarRoutes(app: Hono): void {
  app.use('/config', bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use('*', bodyLimit({ maxSize: 1024 * 1024 }));

  const parseLayer = (v: string): LayerKey | null => {
    const r = layerSchema.safeParse(v);
    return r.success ? r.data : null;
  };

  app.get('/index', (c) => {
    try {
      const payload = buildIndexPayload();
      return c.json({ html: renderIndex(payload, LINKS), payload });
    } catch (err) {
      return c.json({ error: `Không dựng được trang chủ Radar: ${(err as Error).message}` }, 500);
    }
  });

  app.get('/reports', (c) => {
    const config = loadConfig();
    const reports: ReportSummary[] = listReports().map((r) => {
      const counts = countsOf(r.payload);
      return {
        date: r.day, layer: r.layer, layerLabel: config.layers[r.layer]?.label ?? r.payload.layerLabel,
        sessions: r.payload.sessions.filter((s) => s.key !== 'all').length, newPosts: counts.newPosts, newPains: counts.newPains,
        items: counts.posts, updatedAt: r.updatedAt,
      };
    });
    return c.json({ reports });
  });

  app.get('/reports/:date/:layer', (c) => {
    const layer = parseLayer(c.req.param('layer'));
    const date = dateSchema.safeParse(c.req.param('date'));
    if (!layer || !date.success) return c.json({ error: 'Đường dẫn báo cáo không hợp lệ' }, 400);
    const r = getReport(date.data, layer);
    if (!r) return c.json({ error: 'Chưa có báo cáo cho ngày và lớp này' }, 404);
    return c.json({ payload: r.payload });
  });

  app.get('/reports/:date/:layer/html', (c) => {
    const layer = parseLayer(c.req.param('layer'));
    const date = dateSchema.safeParse(c.req.param('date'));
    if (!layer || !date.success) return c.json({ error: 'Đường dẫn báo cáo không hợp lệ' }, 400);
    const r = getReport(date.data, layer);
    if (!r) return c.json({ error: 'Chưa có báo cáo cho ngày và lớp này' }, 404);
    try {
      return c.json({ html: renderReport(r.payload, LINKS) });
    } catch (err) {
      return c.json({ error: `Không dựng được báo cáo: ${(err as Error).message}` }, 500);
    }
  });

  app.get('/config', (c) => c.json({ config: loadConfig(), defaults: defaultRadarConfig() }));

  app.put('/config', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'Cấu hình Radar phải là một đối tượng JSON' }, 400);
    try {
      return c.json({ config: saveConfig(body) });
    } catch (err) {
      if (err instanceof ConfigError) return c.json({ error: err.message }, 400);
      return c.json({ error: 'Không lưu được cấu hình Radar' }, 500);
    }
  });

  app.post('/config/reset', (c) => c.json({ config: resetConfig() }));

  app.post('/enabled', async (c) => {
    const body = z.object({ enabled: z.boolean({ message: 'Thiếu trường enabled (true/false)' }) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.issues[0].message }, 400);
    return c.json({ enabled: setEnabled(body.data.enabled).enabled });
  });

  app.get('/status', async (c) => {
    const config = loadConfig();
    const tz = safeTimezone(config.timezone);
    const nowSec = Math.floor(Date.now() / 1000);
    const state = queueState();
    let tools;
    try {
      tools = await toolStatus();
    } catch {
      tools = {
        apify: { configured: false },
        grok: { installed: false, path: null, loggedIn: null, detail: 'Chưa kiểm tra được' },
        browser: { available: false, profileDir: '', detail: 'Chưa kiểm tra được' },
      };
    }
    return c.json({
      enabled: config.enabled,
      timezone: tz,
      running: state.running,
      queue: state.queue,
      schedule: LAYER_KEYS.map((layer) => {
        const lc = config.layers[layer];
        const marker = lastMarker(layer);
        const scheduled = config.enabled && lc.enabled;
        return {
          layer, label: lc.label, time: lc.time, enabled: lc.enabled, lastDay: lastOkDay(layer),
          nextRunAt: scheduled ? nextRunAt(nowSec, tz, lc.time, marker) : null,
        };
      }),
      tools,
      runs: listRuns(20),
    });
  });

  app.post('/run', async (c) => {
    const body = z.object({ layer: layerSchema }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Lớp phải là vn, world hoặc nganh' }, 400);
    const layer = body.data.layer;
    if (isLayerBusy(layer)) return c.json({ error: 'Lớp này đang chạy hoặc đã nằm trong hàng đợi' }, 409);
    const { run } = queueLayer(layer, { trigger: 'manual' });
    return c.json({ run });
  });

  app.get('/runs/:id', (c) => {
    const id = Number(c.req.param('id'));
    const run = Number.isInteger(id) ? getRun(id) : null;
    if (!run) return c.json({ error: 'Không tìm thấy lượt chạy' }, 404);
    return c.json({ run, log: getRunLog(id) });
  });

  app.post('/browser/login', async (c) => {
    try {
      return c.json(await openBrowserLogin());
    } catch (err) {
      return c.json({ ok: false, detail: `Không mở được trình duyệt: ${(err as Error).message}` });
    }
  });

  app.post('/ideas/status', async (c) => {
    const body = z.object({
      date: dateSchema, layer: layerSchema, sessionKey: z.string().min(1), index: z.number().int().min(0),
      status: z.enum(['todo', 'doing', 'done']),
    }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: `Dữ liệu không hợp lệ: ${body.error.issues[0].message}` }, 400);
    const { date, layer, sessionKey, index, status } = body.data;
    const r = getReport(date, layer);
    const session = r?.payload.sessions.find((s) => s.key === sessionKey);
    if (!r || !session) return c.json({ error: 'Không tìm thấy báo cáo hoặc phiên' }, 404);
    const idea = session.ideas[index];
    if (!idea) return c.json({ error: 'Không tìm thấy ý tưởng' }, 404);
    idea.status = status;
    // The merged 'all' view and the session it came from share ideas by title: keep them in step.
    for (const s of r.payload.sessions) {
      if (s === session) continue;
      const twin = s.ideas.find((i) => i.channel === idea.channel && i.title === idea.title);
      if (twin) twin.status = status;
    }
    saveReport(r.payload);
    return c.json({ ok: true });
  });
}
