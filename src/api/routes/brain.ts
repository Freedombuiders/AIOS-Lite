import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../../core/deps.js';
import { badRequest, notFound } from '../errors.js';
import { adminServices } from '../../shared/admin-services.js';
import { listDirs } from '../../shared/fs-browse.js';
import { body, csv, limitParam, optInt } from '../util.js';

export function brainRoutes(app: Hono, deps: AppDeps): void {
  const folder = (id: string | undefined) => {
    if (!id) throw badRequest('Thiếu tham số folder.');
    if (!deps.brain.folders().some((f) => f.id === id)) throw notFound(`Không tìm thấy thư mục tri thức "${id}".`);
    return id;
  };

  const { brainAdmin } = adminServices(deps);
  const folderInput = z.object({ id: z.string().optional(), name: z.string().min(1).max(120), path: z.string().min(1), description: z.string().max(500).optional() });

  app.get('/api/brain/folders', (c) => c.json({ items: brainAdmin.list() }));

  app.post('/api/brain/folders', async (c) => {
    const input = await body(c, folderInput);
    const created = await brainAdmin.create(input);
    deps.audit.log({ actor: 'user', action: 'brain.folder.add', target: created.id });
    return c.json(created, 201);
  });

  app.put('/api/brain/folders/:id', async (c) => {
    const id = c.req.param('id');
    const patch = await body(c, folderInput.omit({ id: true }).partial());
    const updated = await brainAdmin.update(id, patch);
    deps.audit.log({ actor: 'user', action: 'brain.folder.update', target: id });
    return c.json(updated);
  });

  app.delete('/api/brain/folders/:id', (c) => {
    const id = c.req.param('id');
    const result = brainAdmin.remove(id);
    deps.audit.log({ actor: 'user', action: 'brain.folder.remove', target: id, detail: { agentsUpdated: result.agentsUpdated } });
    return c.json({ ok: true, ...result });
  });

  app.get('/api/fs/dirs', (c) => {
    try {
      return c.json(listDirs(c.req.query('path')));
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
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

  // Whole-file save from the note editor. `vault`/`revision` are the names the web editor sends.
  const fileInput = z
    .object({
      folder: z.string().min(1).optional(),
      vault: z.string().min(1).optional(),
      path: z.string().min(1),
      content: z.string(),
      expectMtimeMs: z.number().nonnegative().optional(),
      revision: z.string().optional(),
    })
    .refine((v) => v.folder || v.vault, { message: 'Thiếu thư mục (folder).', path: ['folder'] });

  app.put('/api/brain/file', async (c) => {
    const input = await body(c, fileInput);
    const id = folder(input.folder ?? input.vault);
    let expect = input.expectMtimeMs;
    if (expect === undefined && input.revision !== undefined && input.revision !== '') {
      expect = Number(input.revision);
      if (!Number.isFinite(expect)) throw badRequest('revision không hợp lệ.');
    }
    const note = deps.notes.write({ folderId: id, relPath: input.path }, input.content, {
      actor: 'owner',
      message: `Sửa ${input.path} trên web`,
      ...(expect !== undefined ? { expectMtimeMs: expect } : {}),
    });
    deps.audit.log({ actor: 'user', action: 'brain.write', target: `${id}:${note.relPath}`, detail: { bytes: Buffer.byteLength(input.content) } });
    return c.json({ folder: id, path: note.relPath, mtimeMs: note.mtimeMs, content: input.content, revision: String(note.mtimeMs) });
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
