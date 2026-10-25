import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiEditBody, quickApi, templatePosterUrl, type QuickForm } from './quick-api';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

function reply(url: string): unknown {
  if (url.endsWith('/templates')) {
    return { templates: [{ id: 'th-vang', name: 'Talking head vàng', description: '', tags: ['Talking head'], tier: 'free', installed: true, legacy: false }], problems: [] };
  }
  if (url.endsWith('/ai-edit')) return { project: { id: 'p1' }, job: { id: 'j1', projectId: 'p1', kind: 'direct', status: 'queued', createdAt: '' } };
  if (url.endsWith('/projects')) return { project: { id: 'p2' } };
  return {};
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve(new Response(JSON.stringify(reply(String(url))), { status: 200, headers: { 'content-type': 'application/json' } }));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const form = (patch: Partial<QuickForm> = {}): QuickForm => ({
  autoCut: true,
  cutLevel: 'vua',
  templateId: 'th-vang',
  assets: [],
  music: { mode: 'ai', duck: true, snapToBeat: false, endOnFinal: true },
  stock: true,
  note: '',
  ...patch,
});

describe('quick api', () => {
  it('lists templates from GET /templates', async () => {
    const r = await quickApi.templates();
    expect(calls).toEqual([{ url: '/api/m/video/edit/templates', method: 'GET', body: undefined }]);
    expect(r.templates.map((t) => t.id)).toEqual(['th-vang']);
  });

  it('creates Dựng nhanh projects with flow quick', async () => {
    await quickApi.createProject({ profileId: 'pf', title: 'clip', aspect: '9:16' });
    expect(calls[0]).toEqual({ url: '/api/m/video/edit/projects', method: 'POST', body: { profileId: 'pf', title: 'clip', aspect: '9:16', flow: 'quick' } });
  });

  it('posts the quick settings without startedAt to /projects/:id/ai-edit', async () => {
    const body = aiEditBody(form({ note: '  thêm logo cuối  ', assets: [{ assetId: 'a1', hint: ' chèn khi nói “mở app” ' }, { assetId: 'a2', hint: '  ' }] }), 'ai');
    const r = await quickApi.aiEdit('p 1', body);
    expect(calls[0].url).toBe('/api/m/video/edit/projects/p%201/ai-edit');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      mode: 'ai', autoCut: true, cutLevel: 'vua', templateId: 'th-vang',
      assets: [{ assetId: 'a1', hint: 'chèn khi nói “mở app”' }, { assetId: 'a2' }],
      music: { mode: 'ai', duck: true, snapToBeat: false, endOnFinal: true },
      stock: true, note: 'thêm logo cuối',
    });
    expect(calls[0].body).not.toHaveProperty('startedAt');
    expect(r.job?.kind).toBe('direct');
  });

  it('sends the picked track only in pick mode and leaves out an empty note', () => {
    const pick = aiEditBody(form({ music: { mode: 'pick', assetId: 'bgm-1', duck: false, snapToBeat: false, endOnFinal: true } }), 'manual');
    expect(pick).toEqual({
      mode: 'manual', autoCut: true, cutLevel: 'vua', templateId: 'th-vang', assets: [],
      music: { mode: 'pick', assetId: 'bgm-1', duck: false, snapToBeat: false, endOnFinal: true }, stock: true,
    });
    const none = aiEditBody(form({ autoCut: false, stock: false, music: { mode: 'none', assetId: 'bgm-1', duck: true, snapToBeat: false, endOnFinal: true } }), 'ai');
    expect(none.music).toEqual({ mode: 'none', duck: true, snapToBeat: false, endOnFinal: true });
    expect(none).toMatchObject({ autoCut: false, stock: false });
    expect(none).not.toHaveProperty('note');
  });

  it('adds the token to template posters served by the API', () => {
    expect(templatePosterUrl({})).toBeNull();
    expect(templatePosterUrl({ posterUrl: '/api/m/video/edit/templates/th-vang/files/poster.webp' })).toBe('/api/m/video/edit/templates/th-vang/files/poster.webp');
    localStorage.setItem('aios.token', 'owner');
    expect(templatePosterUrl({ posterUrl: '/api/m/video/edit/templates/th-vang/files/poster.webp' })).toBe('/api/m/video/edit/templates/th-vang/files/poster.webp?token=owner');
  });
});
