// Template endpoints under /api/m/video/edit/templates. routes.ts calls registerTemplateRoutes(app, { root }).
import path from 'node:path';
import fs from 'node:fs';
import type { Context, Hono } from 'hono';
import { serveFile } from '../serve.js';
import { createTemplateRegistry, TemplateError, type TemplateRegistry } from './registry.js';

const P = '/edit';

const TEXT_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
};

export interface TemplateRouteOptions {
  /** The video-edit data root; owner packs live in <root>/templates. */
  root: string;
  /** Replaces the registry (tests). */
  registry?: TemplateRegistry;
}

export function registerTemplateRoutes(app: Hono, options: TemplateRouteOptions): TemplateRegistry {
  const registry = options.registry ?? createTemplateRegistry({ userDir: () => path.join(options.root, 'templates') });

  const fail = (c: Context, status: 400 | 404 | 422 | 500, error: string, code?: string) =>
    c.json({ error, ...(code ? { code } : {}) }, status);

  const guard = (fn: (c: Context) => Response | Promise<Response>) => async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof TemplateError) return fail(c, err.status, err.message, err.code);
      return fail(c, 500, 'Có lỗi ở máy chủ. Thử lại sau ít giây.');
    }
  };

  const idOf = (c: Context) => c.req.param('id') ?? '';
  const summaryOf = (id: string) => registry.list().find((t) => t.id === id);

  app.get(`${P}/templates`, guard((c) => c.json({ templates: registry.list(), problems: registry.problems() })));

  app.get(`${P}/templates/:id`, guard((c) => {
    const template = registry.get(idOf(c));
    if (!template) return fail(c, 404, 'Không tìm thấy mẫu này.', 'not_found');
    return c.json({ template, summary: summaryOf(template.id) });
  }));

  // Pack files (poster, preview, blocks, rules). safeFile refuses "..", absolute and hidden paths and any
  // symlink that resolves outside the pack folder.
  app.get(`${P}/templates/:id/files/:name{.+}`, guard((c) => {
    const id = idOf(c);
    if (!registry.get(id)) return fail(c, 404, 'Không tìm thấy mẫu này.', 'not_found');
    const file = registry.file(id, c.req.param('name') ?? '');
    if (!file) return fail(c, 404, 'Không có tệp này trong mẫu.', 'no_file');
    const ext = path.extname(file).slice(1).toLowerCase();
    if (TEXT_TYPES[ext]) {
      c.header('Cache-Control', 'private, no-cache');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(fs.readFileSync(file, 'utf8'), 200, { 'Content-Type': TEXT_TYPES[ext] });
    }
    // Blocks of an owner-added pack must not run scripts with the app's origin.
    if (ext === 'html') c.header('Content-Security-Policy', 'sandbox allow-scripts');
    return serveFile(c, file);
  }));

  app.post(`${P}/templates/:id/install`, guard((c) => c.json({ template: registry.install(idOf(c)) })));

  return registry;
}
