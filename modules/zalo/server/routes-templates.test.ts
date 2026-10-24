import fs from 'fs';
import os from 'os';
import path from 'path';

import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Uploads must land in a throwaway dir, never in the real store/.
const store = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-media-test-')) };

import { setZaloDataDir } from './paths.js';
import type { LeanRunInput, LeanRunResult } from '../../../src/modules/sdk.js';
import { getZaloTemplate, listZaloTemplates } from './store.js';
import { _initTestDatabase } from './test-db.js';
import { ZALO_MEDIA_DIR } from './media.js';
import { registerZaloTemplateRoutes } from './routes-templates.js';

setZaloDataDir(store.dir);

let lean: (input: LeanRunInput) => Promise<LeanRunResult> = async () => ({ ok: true, output: '', taskId: 1, runId: null });

function app(): Hono {
  const a = new Hono();
  registerZaloTemplateRoutes(a, { agentIds: () => ['main', 'cskh'], runLean: (i) => lean(i) });
  return a;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function send(a: Hono, method: string, url: string, body?: unknown) {
  return a.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function upload(a: Hono, name: string, data: Buffer, type: string) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(data)], name, { type }));
  const res = await a.request('/media', { method: 'POST', body: form });
  return { res, body: await json(res) };
}

describe('zalo template routes', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterAll(() => {
    fs.rmSync(store.dir, { recursive: true, force: true });
  });

  it('creates, lists, reads, updates and deletes a template', async () => {
    const a = app();
    let res = await send(a, 'POST', '/templates', {
      name: '  Chào khách  ',
      text: '  Xin chào {name}!  ',
      styles: [{ st: 'b', start: 2, len: 8 }, { st: 'bogus', start: 0, len: 2 }],
    });
    expect(res.status).toBe(200);
    const created = (await json(res)).template;
    // trimmed through trimRich: the bold range moved with the text, the bogus code is gone
    expect(created).toMatchObject({ name: 'Chào khách', text: 'Xin chào {name}!', styles: [{ st: 'b', start: 0, len: 8 }], attachments: [] });

    res = await send(a, 'GET', '/templates');
    expect((await json(res)).templates).toHaveLength(1);

    res = await send(a, 'GET', `/templates/${created.id}`);
    expect((await json(res)).template.name).toBe('Chào khách');

    res = await send(a, 'PUT', `/templates/${created.id}`, { name: 'Mới', text: 'Hi {a|b}', styles: [] });
    const updated = await json(res);
    expect(updated.template).toMatchObject({ name: 'Mới', text: 'Hi {a|b}' });
    expect(updated.warnings).toEqual([]);

    res = await send(a, 'DELETE', `/templates/${created.id}`);
    expect(res.status).toBe(200);
    expect(listZaloTemplates()).toHaveLength(0);
    expect((await send(a, 'GET', `/templates/${created.id}`)).status).toBe(404);
    expect((await send(a, 'DELETE', `/templates/${created.id}`)).status).toBe(404);
  });

  it('validates name, text and attachment limits with Vietnamese errors', async () => {
    const a = app();
    expect((await send(a, 'POST', '/templates', { name: '', text: 'x' })).status).toBe(400);
    expect((await send(a, 'POST', '/templates', { name: 'x'.repeat(121), text: 'x' })).status).toBe(400);
    const empty = await send(a, 'POST', '/templates', { name: 'n', text: '   ' });
    expect(empty.status).toBe(400);
    expect((await json(empty)).error).toContain('nội dung');
    expect((await send(a, 'POST', '/templates', { name: 'n', text: 'x'.repeat(4001) })).status).toBe(400);
    expect((await send(a, 'POST', '/templates', { name: 'n', text: 'x', attachmentIds: [999] })).status).toBe(400);
    expect((await send(a, 'GET', '/templates/abc')).status).toBe(404);
  });

  it('uploads media, attaches it, serves it and cleans it up with the template', async () => {
    const a = app();
    const { res, body } = await upload(a, '../ảnh<bad>.png', PNG, 'image/png');
    expect(res.status).toBe(200);
    expect(body.media).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(body.media.name).not.toContain('/');
    expect(body.media.name).not.toContain('<');

    const created = (await json(await send(a, 'POST', '/templates', {
      name: 'Có ảnh', text: 'Xem ảnh', attachmentIds: [body.media.id],
    }))).template;
    expect(created.attachments).toEqual([{ mediaId: body.media.id, name: body.media.name, kind: 'image' }]);

    // Contract row: absolute path inside ZALO_MEDIA_DIR.
    const row = getZaloTemplate(created.id)!;
    expect(row.attachments[0].path.startsWith(ZALO_MEDIA_DIR + path.sep)).toBe(true);
    expect(fs.existsSync(row.attachments[0].path)).toBe(true);

    const raw = await send(a, 'GET', `/media/${body.media.id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('image/png');
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await raw.arrayBuffer()).equals(PNG)).toBe(true);

    await send(a, 'DELETE', `/templates/${created.id}`);
    expect(fs.existsSync(row.attachments[0].path)).toBe(false);
    expect((await send(a, 'GET', `/media/${body.media.id}/raw`)).status).toBe(404);
  });

  it('never serves non-image uploads inline and does not trust a declared image type', async () => {
    const a = app();
    const html = await upload(a, 'x.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
    expect(html.body.media.kind).toBe('file');
    const raw = await send(a, 'GET', `/media/${html.body.media.id}/raw`);
    expect(raw.headers.get('content-type')).toBe('application/octet-stream');
    expect(raw.headers.get('content-disposition')).toContain('attachment');

    const fake = await upload(a, 'fake.png', Buffer.from('not really a png'), 'image/png');
    expect(fake.body.media.kind).toBe('file');
  });

  it('enforces the attachment limits and drops removed uploads on update', async () => {
    const a = app();
    const ids: number[] = [];
    for (let i = 0; i < 13; i++) ids.push((await upload(a, `p${i}.png`, PNG, 'image/png')).body.media.id);
    const tooMany = await send(a, 'POST', '/templates', { name: 'n', text: 'x', attachmentIds: ids });
    expect(tooMany.status).toBe(400);
    expect((await json(tooMany)).error).toContain('12 ảnh');

    const created = (await json(await send(a, 'POST', '/templates', { name: 'n', text: 'x', attachmentIds: ids.slice(0, 2) }))).template;
    await send(a, 'PUT', `/templates/${created.id}`, { name: 'n', text: 'x', attachmentIds: [ids[0]] });
    expect((await send(a, 'GET', `/media/${ids[1]}/raw`)).status).toBe(404);
    expect((await send(a, 'GET', `/media/${ids[0]}/raw`)).status).toBe(200);
  });

  it('rejects an empty upload', async () => {
    const a = app();
    const res = await a.request('/media', { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
  });

  it('renders a preview server-side with remapped styles, seed and var overrides', async () => {
    const a = app();
    const text = '{Chào|Hi} {name}!';
    const styles = [{ st: 'b', start: text.indexOf('{name}'), len: 6 }];
    const res = await send(a, 'POST', '/templates/render', { text, styles, seed: 7, vars: { name: 'Hoa' } });
    const out = await json(res);
    expect(['Chào Hoa!', 'Hi Hoa!']).toContain(out.text);
    const s = out.styles[0];
    expect(out.text.slice(s.start, s.start + s.len)).toBe('Hoa');
    // same seed, same pick
    const again = await json(await send(a, 'POST', '/templates/render', { text, styles, seed: 7, vars: { name: 'Hoa' } }));
    expect(again.text).toBe(out.text);

    const sample = await json(await send(a, 'POST', '/templates/render', { text: '{name}/{sale}/{group}' }));
    expect(sample.text).toBe('Lan/Shop/');
    expect(sample.warnings).toEqual([]);
  });

  it('lists the template variables', async () => {
    const res = await send(app(), 'GET', '/templates/variables');
    expect((await json(res)).variables.map((v: { name: string }) => v.name)).toContain('weekday');
  });

  it('asks the agent through runLean and returns variants that keep the variables', async () => {
    const a = app();
    lean = async (input) => {
      expect(input.agentId).toBe('cskh');
      expect(input.prompt).toContain('Xin chào {name}');
      return { ok: true, output: '["Chào {name} nhé", "Dạ {name} ơi", "Hello bạn"]', taskId: 5, runId: 6 };
    };
    const res = await send(a, 'POST', '/templates/variants', { text: 'Xin chào {name}', agentId: 'cskh', count: 3 });
    expect(res.status).toBe(200);
    expect((await json<{ variants: string[] }>(res)).variants).toEqual(['Chào {name} nhé', 'Dạ {name} ơi']);
    lean = async () => ({ ok: false, output: '', taskId: 7, runId: null, error: 'hết hạn mức' });
    expect((await send(a, 'POST', '/templates/variants', { text: 'Xin chào {name}', agentId: 'cskh' })).status).toBe(502);
  });

  it('validates the variants request', async () => {
    const a = app();
    expect((await send(a, 'POST', '/templates/variants', { text: '' })).status).toBe(400);
    const bad = await send(a, 'POST', '/templates/variants', { text: 'Xin chào', agentId: 'ghost' });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toContain('Agent');
  });
});
