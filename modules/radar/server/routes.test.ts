import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./collectors/index.js', () => ({
  collectLayer: vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); throw new Error('không có mạng trong test'); }),
  fetchFacebookComments: vi.fn(async () => new Map()),
  collectVnChatter: vi.fn(async () => null),
  toolStatus: vi.fn(async () => ({
    apify: { configured: false },
    grok: { installed: false, path: null, loggedIn: null, detail: 'Chưa cài' },
    browser: { available: false, profileDir: '/tmp/p', detail: 'Chưa có' },
  })),
  openBrowserLogin: vi.fn(async () => ({ ok: true, detail: 'đã mở' })),
}));
vi.mock('./render/index.js', () => ({
  renderIndex: vi.fn(() => '<html>index</html>'),
  renderReport: vi.fn((p: { date: string }) => {
    if (p.date === '2026-01-01') throw new Error('render hỏng');
    return '<html>report</html>';
  }),
}));

import { _initTestDatabase } from './test-db.js';
import { defaultRadarConfig } from './defaults.js';
import { isLayerBusy } from './pipeline.js';
import { registerRadarRoutes } from './routes.js';
import { saveReport } from './store.js';
import type { ReportPayload } from './types.js';

let app: Hono;
/* eslint-disable @typescript-eslint/no-explicit-any */
const req = (path: string, init?: RequestInit) => app.request(path, init) as Promise<{ status: number; json(): Promise<any> }>;
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  _initTestDatabase();
  app = new Hono();
  registerRadarRoutes(app);
});

const payload = (date: string): ReportPayload => ({
  version: 1, layer: 'nganh', layerLabel: 'Ngành nghề', slotLabel: 'phiên 20h', date, dateLabel: '17/10/2026', weekday: 'Thứ Bảy',
  owner: '', generatedAt: new Date().toISOString(),
  sessions: [{
    key: 's1', label: 'Phiên 20h', scan: { when: '', sources: '', top: '' }, topics: [], communities: [], items: [], pains: [], quotes: [],
    buySignals: [], tools: [], ideas: [{ channel: 'Mọi kênh', title: 'Gợi ý: x', evidence: [], status: 'todo' }], fears: [], professions: [],
    missingProfessions: [], competitors: [], otherAdvertisers: [], gap: null, trends: [], dataNotes: [],
  }],
});

describe('radar routes', () => {
  it('status: schedule, tools, no runs', async () => {
    const res = await req('/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ enabled: false, timezone: 'Asia/Ho_Chi_Minh', running: null, queue: [], runs: [] });
    expect(body.schedule.map((s: { layer: string }) => s.layer)).toEqual(['vn', 'world', 'nganh']);
    expect(body.schedule[0].nextRunAt).toBeNull(); // master switch off
    expect(body.tools.grok.detail).toBe('Chưa cài');
  });

  it('run: queues, then 409 for the same layer; bad layer is 400', async () => {
    const first = await req('/run', json({ layer: 'vn' }));
    expect(first.status).toBe(200);
    const { run } = await first.json();
    expect(run).toMatchObject({ layer: 'vn', status: 'queued', trigger: 'manual' });
    const second = await req('/run', json({ layer: 'vn' }));
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/đang chạy/);
    expect((await req('/run', json({ layer: 'zzz' }))).status).toBe(400);

    while (isLayerBusy('vn')) await new Promise((r) => setTimeout(r, 10));
    const detail = await (await req(`/runs/${run.id}`)).json();
    expect(detail.run.status).toBe('error');
    expect(Array.isArray(detail.log)).toBe(true);
    expect((await req('/runs/9999')).status).toBe(404);
  });

  it('config: get, put validation names the field, reset, enabled', async () => {
    const got = await (await req('/config')).json();
    expect(got.config.enabled).toBe(false);
    expect(got.defaults.layers.vn.time).toBe('07:00');

    const bad = defaultRadarConfig();
    bad.layers.nganh.time = '25:99';
    const res = await req('/config', { ...json(bad), method: 'PUT' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/nganh.*giờ quét|giờ quét/);

    const ok = defaultRadarConfig();
    ok.owner.name = 'Minh';
    const saved = await req('/config', { ...json(ok), method: 'PUT' });
    expect((await saved.json()).config.owner.name).toBe('Minh');

    expect(await (await req('/enabled', json({ enabled: true }))).json()).toEqual({ enabled: true });
    expect((await req('/enabled', json({ enabled: 'yes' }))).status).toBe(400);
    const reset = await (await req('/config/reset', { method: 'POST' })).json();
    expect(reset.config.owner.name).toBe('');
  });

  it('reports: list, get, html, 404, render failure is 500', async () => {
    expect((await req('/reports/2026-10-17/nganh')).status).toBe(404);
    saveReport(payload('2026-10-17'));
    saveReport(payload('2026-01-01'));
    const list = await (await req('/reports')).json();
    expect(list.reports).toHaveLength(2);
    expect(list.reports[0]).toMatchObject({ date: '2026-10-17', layer: 'nganh', layerLabel: 'Ngành nghề', sessions: 1 });
    expect((await (await req('/reports/2026-10-17/nganh')).json()).payload.date).toBe('2026-10-17');
    expect(await (await req('/reports/2026-10-17/nganh/html')).json()).toEqual({ html: '<html>report</html>' });
    const broken = await req('/reports/2026-01-01/nganh/html');
    expect(broken.status).toBe(500);
    expect((await broken.json()).error).toMatch(/render hỏng/);
    expect((await req('/reports/2026-10-17/zzz')).status).toBe(400);
    const idx = await (await req('/index')).json();
    expect(idx.html).toBe('<html>index</html>');
    expect(idx.payload.layers).toHaveLength(3);
  });

  it('ideas/status updates the stored payload', async () => {
    saveReport(payload('2026-10-17'));
    const res = await req('/ideas/status', json({ date: '2026-10-17', layer: 'nganh', sessionKey: 's1', index: 0, status: 'doing' }));
    expect(await res.json()).toEqual({ ok: true });
    const p = (await (await req('/reports/2026-10-17/nganh')).json()).payload;
    expect(p.sessions[0].ideas[0].status).toBe('doing');
    expect((await req('/ideas/status', json({ date: '2026-10-17', layer: 'nganh', sessionKey: 's1', index: 5, status: 'done' }))).status).toBe(404);
    expect((await req('/ideas/status', json({ date: 'x', layer: 'nganh', sessionKey: 's1', index: 0, status: 'done' }))).status).toBe(400);
  });

  it('browser login passes through', async () => {
    expect(await (await req('/browser/login', { method: 'POST' })).json()).toEqual({ ok: true, detail: 'đã mở' });
  });
});
