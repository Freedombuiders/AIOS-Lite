import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerVideoEditRoutes } from '../routes.js';
import { createTemplateRegistry } from './registry.js';
import { registerTemplateRoutes } from './routes.js';

let root: string;
let app: Hono;

const j = async (res: Response) => (await res.json()) as any;
const post = (url: string) => app.request(url, { method: 'POST' });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-templates-routes-'));
  app = new Hono();
  registerTemplateRoutes(app, {
    root,
    registry: createTemplateRegistry({ builtinDir: () => path.resolve('modules/video/templates'), userDir: () => path.join(root, 'templates') }),
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('template routes', () => {
  it('GET /templates lists 22 templates and no problems', async () => {
    const body = await j(await app.request('/edit/templates'));
    expect(body.templates).toHaveLength(22);
    expect(body.templates[0]).toMatchObject({ id: 'th-vang', installed: true, legacy: false });
    expect(body.problems).toEqual([]);
  });

  it('GET /templates/:id returns the manifest, legacy ids included', async () => {
    const th = await j(await app.request('/edit/templates/th-vang'));
    expect(Object.keys(th.template.components)).toHaveLength(5);
    expect(th.summary).toMatchObject({ id: 'th-vang', installed: true });
    for (const url of ['/edit/templates/style:kienthuc', '/edit/templates/style%3Akienthuc']) {
      const legacy = await j(await app.request(url));
      expect(legacy.template).toMatchObject({ id: 'style:kienthuc', legacy: true, styleId: 'kienthuc' });
    }
    const missing = await app.request('/edit/templates/khong-co');
    expect(missing.status).toBe(404);
    expect(await j(missing)).toEqual({ error: 'Không tìm thấy mẫu này.', code: 'not_found' });
  });

  it('GET /templates/:id/files/:name serves pack files and blocks path traversal', async () => {
    const rules = await app.request('/edit/templates/th-vang/files/rules.md');
    expect(rules.status).toBe(200);
    expect(rules.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(await rules.text()).toContain('Nhịp chữ');
    const block = await app.request('/edit/templates/th-vang/files/components/text-beat.html');
    expect(block.status).toBe(200);
    expect(block.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect(await block.text()).toContain('data-composition-id="text-beat"');

    for (const bad of [
      '/edit/templates/th-vang/files/..%2F..%2F..%2Fpackage.json',
      '/edit/templates/th-vang/files/components%2F..%2F..%2Fth-vang%2Frules.md',
      '/edit/templates/th-vang/files/%2Fetc%2Fpasswd',
      '/edit/templates/th-vang/files/components',
      '/edit/templates/th-vang/files/khong-co.txt',
      '/edit/templates/style:kienthuc/files/rules.md',
    ]) {
      const res = await app.request(bad);
      expect(res.status, bad).toBe(404);
    }
    expect((await app.request('/edit/templates/khong-co/files/rules.md')).status).toBe(404);
  });

  it('POST /templates/:id/install marks a template installed and keeps it', async () => {
    const res = await post('/edit/templates/style:review/install');
    expect(res.status).toBe(200);
    expect((await j(res)).template).toMatchObject({ id: 'style:review', installed: true });
    const list = (await j(await app.request('/edit/templates'))).templates;
    expect(list.filter((t: any) => t.installed).map((t: any) => t.id).sort()).toEqual(['style:review', 'th-vang']);
    expect(fs.existsSync(path.join(root, 'templates', 'installed.json'))).toBe(true);
    expect((await post('/edit/templates/khong-co/install')).status).toBe(404);
  });

  it('is registered by the Video Studio routes with owner packs under <root>/templates', async () => {
    const full = new Hono();
    const reg = registerVideoEditRoutes(full, { root, autoStart: false });
    try {
      fs.mkdirSync(path.join(root, 'templates', 'hong'), { recursive: true });
      fs.writeFileSync(path.join(root, 'templates', 'hong', 'template.json'), '{}');
      const body = await j(await full.request('/edit/templates'));
      expect(body.templates.map((t: any) => t.id)).toContain('th-vang');
      expect(body.problems).toEqual([{ id: 'hong', error: expect.stringContaining('Mẫu "hong": template.json chưa hợp lệ') }]);
    } finally {
      reg.stop();
    }
  });
});
