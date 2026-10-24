import fs from 'node:fs';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { badRequest, notFound } from '../errors.js';
import { body, csv, limitParam, optInt } from '../util.js';

export function brainRoutes(app: Hono, deps: AppDeps): void {
  const folder = (id: string | undefined) => {
    if (!id) throw badRequest('Thiếu tham số folder.');
    if (!deps.brain.folders().some((f) => f.id === id)) throw notFound(`Không tìm thấy thư mục tri thức "${id}".`);
    return id;
  };

  app.get('/api/brain/folders', (c) => {
    const count = deps.db.prepare('SELECT COUNT(*) AS n FROM brain_docs WHERE folder_id = ?');
    return c.json({
      items: deps.brain.folders().map((f) => ({ ...f, docs: (count.get(f.id) as { n: number }).n, exists: fs.existsSync(f.path) })),
    });
  });

  app.get('/api/brain/tree', (c) => c.json({ items: deps.brain.tree(folder(c.req.query('folder')), { depth: optInt(c, 'depth') }) }));

  app.get('/api/brain/file', (c) => {
    const id = folder(c.req.query('folder'));
    const rel = c.req.query('path');
    if (!rel) throw badRequest('Thiếu tham số path.');
    try {
      return c.json(deps.brain.read(id, rel));
    } catch {
      throw notFound('Không đọc được tệp này.');
    }
  });

  app.get('/api/brain/search', (c) => {
    const q = c.req.query('q')?.trim();
    if (!q) throw badRequest('Thiếu từ khoá tìm kiếm (q).');
    return c.json({ items: deps.brain.search(q, { folders: csv(c, 'folders'), limit: limitParam(c, 10) }) });
  });

  app.post('/api/brain/reindex', async (c) => {
    const input = await body(c, z.object({ full: z.boolean().optional(), folderId: z.string().optional() }), { optional: true });
    if (input.folderId) folder(input.folderId);
    const result = await deps.brain.reindex(input);
    return c.json(result);
  });
}
