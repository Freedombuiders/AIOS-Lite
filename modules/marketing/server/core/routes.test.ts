import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('os') as typeof import('os');
  return {
    mediaDir: p.join(o.tmpdir(), `fbstudio-routes-test-${process.pid}`, 'media'),
    execute: vi.fn(),
    listConnections: vi.fn(),
    resetComposio: vi.fn(),
    hasKey: vi.fn(() => true),
    setEnvKey: vi.fn(),
    notify: vi.fn(async () => {}),
  };
});

vi.mock('../../../_lib/composio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/composio.js')>();
  return {
    ...actual,
    FB_MEDIA_DIR: mocks.mediaDir,
    execute: mocks.execute,
    listConnections: mocks.listConnections,
    resetComposio: mocks.resetComposio,
    hasComposioKey: () => mocks.hasKey(),
  };
});
vi.mock('../notify.js', () => ({ notifyOwner: mocks.notify }));
vi.mock('../compat.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../compat.js')>()), listAgentIds: () => ['main'] }));

import { _initTestDatabase, getFbContent, getFbSetting, setFbSetting, updateFbPageFields } from '../store.js';
import { _resetPublisher } from './publisher.js';
import { registerCoreRoutes } from './routes.js';
import { _resetStatusCache } from './status.js';
import { futureAt, makePage, seedContent } from './test-fixtures.js';

function setup(): Hono {
  const app = new Hono();
  registerCoreRoutes(app);
  return app;
}

async function call(app: Hono, method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await app.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
  _initTestDatabase(':memory:');
  _resetPublisher();
  _resetStatusCache();
  mocks.execute.mockReset();
  mocks.listConnections.mockReset();
  mocks.resetComposio.mockReset();
  mocks.setEnvKey.mockReset();
  mocks.hasKey.mockReturnValue(true);
  makePage('p1');
});

describe('status', () => {
  it('reports a missing key without calling Composio', async () => {
    mocks.hasKey.mockReturnValue(false);
    const { status, json } = await call(setup(), 'GET', '/status');
    expect(status).toBe(200);
    expect(json.composio).toEqual({ keyConfigured: false, facebook: 'MISSING', metaads: 'MISSING', checkedAt: null });
    expect(mocks.listConnections).not.toHaveBeenCalled();
    expect(json.apiBudgetPerHour).toBe(600);
  });

  it('summarises connections, caches them and shows the next scheduled post', async () => {
    mocks.listConnections.mockResolvedValue([
      { id: 'a', toolkit: 'facebook', status: 'ACTIVE', alias: null, entityId: 'e', authConfigId: '' },
      { id: 'b', toolkit: 'facebook', status: 'EXPIRED', alias: null, entityId: 'e', authConfigId: '' },
      { id: 'c', toolkit: 'metaads', status: 'EXPIRED', alias: null, entityId: 'e', authConfigId: '' },
    ]);
    const at = futureAt(2, '09:00');
    seedContent({ status: 'scheduled', scheduled_at: at + 7200, title: 'Sau' });
    seedContent({ status: 'scheduled', scheduled_at: at, title: 'Trước' });
    setFbSetting('api_budget_per_hour', '120');
    const app = setup();
    const first = await call(app, 'GET', '/status');
    await call(app, 'GET', '/status');
    expect(mocks.listConnections).toHaveBeenCalledTimes(1);
    expect(first.json.composio).toMatchObject({ keyConfigured: true, facebook: 'ACTIVE', metaads: 'EXPIRED' });
    expect(first.json.composio.checkedAt).toBeGreaterThan(0);
    expect(first.json.publisher.next).toMatchObject({ title: 'Trước', pageName: 'Page p1', scheduledAt: at });
    expect(first.json.apiBudgetPerHour).toBe(120);
    expect(first.json.apiCallsThisHour).toBe(0);
  });

  it('degrades to UNKNOWN when Composio is unreachable', async () => {
    mocks.listConnections.mockRejectedValue(new Error('offline'));
    const { json } = await call(setup(), 'GET', '/status');
    expect(json.composio).toMatchObject({ facebook: 'UNKNOWN', metaads: 'UNKNOWN' });
  });
});

describe('settings', () => {
  it('returns the settings without ever returning the key', async () => {
    const { json } = await call(setup(), 'GET', '/settings');
    expect(json).toMatchObject({ composioKeyConfigured: true, apiBudgetPerHour: 600, enabled: false });
    expect(json.mediaDir).toBe(mocks.mediaDir);
    expect(JSON.stringify(json)).not.toMatch(/key"\s*:\s*"/i);
  });

  it('directs legacy key submissions to Integrations without mutating settings', async () => {
    const { status, json } = await call(setup(), 'PUT', '/settings', { composioApiKey: 'ak_test_1234567890', enabled: true });
    expect(status).toBe(400);
    expect(json.error).toContain('Kết nối');
    expect(mocks.setEnvKey).not.toHaveBeenCalled();
    expect(getFbSetting('enabled')).not.toBe('1');
    expect(JSON.stringify(json)).not.toContain('ak_test_1234567890');
  });

  it('still saves operational settings without a key field', async () => {
    const { status, json } = await call(setup(), 'PUT', '/settings', { enabled: true, apiBudgetPerHour: 300 });
    expect(status).toBe(200);
    expect(json).toMatchObject({ enabled: true, apiBudgetPerHour: 300 });
    expect(mocks.setEnvKey).not.toHaveBeenCalled();
  });

  it('rejects keys that could break the .env file and bad numbers', async () => {
    const app = setup();
    expect((await call(app, 'PUT', '/settings', { composioApiKey: 'abc\nEVIL=1' })).status).toBe(400);
    expect((await call(app, 'PUT', '/settings', { composioApiKey: 'short' })).status).toBe(400);
    expect((await call(app, 'PUT', '/settings', { apiBudgetPerHour: 0 })).status).toBe(400);
    expect((await call(app, 'PUT', '/settings', { apiBudgetPerHour: 1.5 })).status).toBe(400);
    expect(mocks.setEnvKey).not.toHaveBeenCalled();
  });


});

describe('pages', () => {
  it('lists, updates and validates', async () => {
    const app = setup();
    const list = await call(app, 'GET', '/pages');
    expect(list.json.pages).toHaveLength(1);
    expect(list.json.pages[0]).toMatchObject({ id: 'p1', name: 'Page p1', enabled: true, approvalRequired: true });
    const patched = await call(app, 'PATCH', '/pages/p1', { approvalRequired: false, maxPostsPerDay: 2 });
    expect(patched.json).toMatchObject({ approvalRequired: false, maxPostsPerDay: 2 });
    expect((await call(app, 'PATCH', '/pages/p1', { maxPostsPerDay: 'many' })).status).toBe(400);
    expect((await call(app, 'PATCH', '/pages/p1', { timezone: 'Nowhere/Land' })).status).toBe(400);
    expect((await call(app, 'PATCH', '/pages/nope', {})).status).toBe(404);
    expect((await call(app, 'PATCH', '/pages/p1', '{not json')).status).toBe(400);
  });

  it('sync answers 503 without a key', async () => {
    mocks.hasKey.mockReturnValue(false);
    const { status, json } = await call(setup(), 'POST', '/pages/sync');
    expect(status).toBe(503);
    expect(json.error).toMatch(/Composio/);
  });
});

describe('content lifecycle', () => {
  it('walks create → review → approve (409 on rule violation) → schedule → unschedule → delete', async () => {
    const app = setup();
    const created = await call(app, 'POST', '/content', { pageId: 'p1', title: 'Bài 1', caption: 'Nội dung', format: 'text', hooks: ['a', 'b', 'c'] });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ status: 'draft', title: 'Bài 1', pageName: 'Page p1' });
    const id = created.json.id as number;

    expect((await call(app, 'PATCH', `/content/${id}`, { status: 'review' })).json.status).toBe('review');
    const at = futureAt(2, '12:00');
    const approved = await call(app, 'POST', `/content/${id}/approve`, { scheduledAt: at });
    expect(approved.json).toMatchObject({ status: 'scheduled', scheduledAt: at });

    const second = (await call(app, 'POST', '/content', { pageId: 'p1', title: 'Bài 2', caption: 'x', status: 'review' })).json.id;
    const conflict = await call(app, 'POST', `/content/${second}/approve`, { scheduledAt: futureAt(2, '13:00') });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toMatch(/tối thiểu/);

    expect((await call(app, 'POST', `/content/${id}/unschedule`)).json.status).toBe('approved');
    const detail = await call(app, 'GET', `/content/${id}`);
    expect(detail.json.log).toEqual([]);
    expect((await call(app, 'DELETE', `/content/${id}`)).json).toEqual({ ok: true });
    expect((await call(app, 'GET', `/content/${id}`)).status).toBe(404);
  });

  it('return stores feedback', async () => {
    const id = seedContent({ status: 'review' });
    const res = await call(setup(), 'POST', `/content/${id}/return`, { feedback: 'Hook yếu' });
    expect(res.json).toMatchObject({ status: 'draft', feedback: 'Hook yếu' });
    expect((await call(setup(), 'POST', `/content/${id}/return`, { feedback: 'x' })).status).toBe(409);
    expect((await call(setup(), 'POST', `/content/${id}/return`, {})).status).toBe(400);
  });

  it('validates ids, bodies and media paths', async () => {
    const app = setup();
    expect((await call(app, 'GET', '/content/abc')).status).toBe(400);
    expect((await call(app, 'GET', '/content/0')).status).toBe(400);
    expect((await call(app, 'POST', '/content', { format: 'story' })).status).toBe(400);
    // unknown keys are ignored, so a client may send back a whole DTO
    expect((await call(app, 'POST', '/content', { surprise: true, id: 5, title: 'x' })).json.title).toBe('x');
    expect((await call(app, 'POST', '/content', '[]')).status).toBe(400);
    const evil = await call(app, 'POST', '/content', { media: [{ path: '/etc/passwd', kind: 'image' }] });
    expect(evil.status).toBe(400);
    expect(evil.json.error).toMatch(/thư mục media/);
  });

  it('lists with filters and counts', async () => {
    seedContent({ status: 'draft', title: 'Alpha' });
    seedContent({ status: 'review', title: 'Beta' });
    const app = setup();
    const all = await call(app, 'GET', '/content');
    expect(all.json.total).toBe(2);
    expect(all.json.counts).toMatchObject({ all: 2, draft: 1, review: 1, published: 0 });
    expect((await call(app, 'GET', '/content?status=review&q=bet')).json.items).toHaveLength(1);
    expect((await call(app, 'GET', '/content?status=bogus')).status).toBe(400);
  });

  it('blocks publish-now and delete-remote cleanly', async () => {
    const app = setup();
    const review = seedContent({ status: 'review' });
    expect((await call(app, 'POST', `/content/${review}/publish-now`)).status).toBe(409);
    expect((await call(app, 'POST', `/content/${review}/delete-remote`)).status).toBe(409);
    mocks.hasKey.mockReturnValue(false);
    expect((await call(app, 'POST', `/content/${seedContent({ status: 'approved' })}/publish-now`)).status).toBe(503);
    mocks.hasKey.mockReturnValue(true);
    updateFbPageFields('p1', { status: 'EXPIRED' });
    expect((await call(app, 'POST', `/content/${seedContent({ status: 'approved' })}/publish-now`)).status).toBe(409);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('publish-now returns the claimed row and the upload finishes in the background', async () => {
    mocks.execute.mockResolvedValue({ id: '5_9' });
    const id = seedContent({ status: 'approved' });
    const res = await call(setup(), 'POST', `/content/${id}/publish-now`);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('publishing');
    await vi.waitFor(() => expect(getFbContent(id)?.status).toBe('published'));
  });
});

describe('calendar', () => {
  it('needs a valid month and filters by Page', async () => {
    const app = setup();
    expect((await call(app, 'GET', '/calendar')).status).toBe(400);
    expect((await call(app, 'GET', '/calendar?month=2026-13')).status).toBe(400);
    const month = new Date(futureAt(3, '09:00') * 1000).toISOString().slice(0, 7);
    seedContent({ status: 'scheduled', scheduled_at: futureAt(3, '09:00') });
    const res = await call(app, 'GET', `/calendar?month=${month}&page=p1`);
    expect(res.status).toBe(200);
    expect(res.json.items.length).toBeGreaterThanOrEqual(1);
    expect((await call(app, 'GET', `/calendar?month=${month}&page=other`)).json.items).toEqual([]);
  });
});

describe('content media previews', () => {
  it('streams attached files with byte ranges and rejects invalid indices/ranges', async () => {
    fs.mkdirSync(mocks.mediaDir, { recursive: true });
    const file = path.join(mocks.mediaDir, 'preview.mp4');
    fs.writeFileSync(file, '0123456789');
    try {
      const id = seedContent({ media_json: JSON.stringify([{ path: file, kind: 'video' }]) });
      const app = setup();
      const url = `/content/${id}/media/0`;
      const full = await app.request(url);
      expect(full.status).toBe(200);
      expect(full.headers.get('content-type')).toBe('video/mp4');
      expect(await full.text()).toBe('0123456789');
      const partial = await app.request(url, { headers: { range: 'bytes=2-5' } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(await partial.text()).toBe('2345');
      expect(await (await app.request(url, { headers: { range: 'bytes=0-0' } })).text()).toBe('0');
      expect(await (await app.request(url, { headers: { range: 'bytes=-3' } })).text()).toBe('789');
      expect((await app.request(url, { headers: { range: 'bytes=20-30' } })).status).toBe(416);
      expect((await app.request(`/content/${id}/media/1`)).status).toBe(404);
      expect((await app.request(`/content/${id}/media/0foo`)).status).toBe(404);
    } finally { fs.rmSync(file, { force: true }); }
  });

  it('rejects stored paths and symlinks outside the studio media directory', async () => {
    fs.mkdirSync(mocks.mediaDir, { recursive: true });
    const link = path.join(mocks.mediaDir, 'outside.jpg');
    fs.symlinkSync(new URL(import.meta.url).pathname, link);
    try {
      const app = setup();
      for (const file of [new URL(import.meta.url).pathname, link]) {
        const id = seedContent({ media_json: JSON.stringify([{ path: file, kind: 'image' }]) });
        expect((await app.request(`/content/${id}/media/0`)).status).toBe(400);
      }
    } finally { fs.rmSync(link, { force: true }); }
  });
});
