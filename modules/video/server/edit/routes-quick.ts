// Dựng nhanh: POST /projects/:id/ai-edit saves the owner's settings on the project (`quick`) and runs the chain
// the quick way: the director with the template (mode ai) or a machine plan (mode manual). The plan does not
// stop for approval; only "Xuất" renders. Registered by routes.ts with the editor kit.
import type { Hono } from 'hono';
import { z } from 'zod';
import { findAsset } from './library/store.js';
import type { EditorKit } from './routes-editor.js';
import type { TemplateManifest } from './templates/types.js';
import type { QuickSettings } from './types.js';

export interface QuickRouteOptions {
  /** Template registry lookup (templates/registry.ts getTemplate): the chosen template must exist. */
  templates?: (id: string) => TemplateManifest | null;
}

const assetRef = z.string().trim().min(1).max(200);

/** Body of POST /ai-edit: QuickSettings without `startedAt`. */
export const quickSettingsSchema = z.object({
  mode: z.enum(['ai', 'manual']),
  autoCut: z.boolean(),
  cutLevel: z.enum(['nhe', 'vua', 'sat']),
  templateId: z.string().trim().min(1).max(80),
  assets: z.array(z.object({ assetId: assetRef, hint: z.string().trim().max(500).optional() }).strict()).max(30),
  music: z.object({
    mode: z.enum(['ai', 'pick', 'none']),
    assetId: assetRef.optional(),
    duck: z.boolean(),
    snapToBeat: z.boolean(),
    endOnFinal: z.boolean(),
  }).strict(),
  stock: z.boolean(),
  note: z.string().trim().max(4000).optional(),
}).strict();

export function registerQuickRoutes(app: Hono, kit: EditorKit, options: QuickRouteOptions = {}) {
  const { P, store, pipeline, fail, small, guard, parse, idOf, requireProject, emitProject } = kit;

  app.post(`${P}/projects/:id/ai-edit`, small, guard(async (c) => {
    const body = await parse(c, quickSettingsSchema);
    const project = requireProject(idOf(c));
    if (project.mode === 'create' || project.mode === 'produce') return fail(c, 409, 'Dựng nhanh chỉ dùng cho video quay sẵn.', 'wrong_mode');
    if (!project.source || !store.sourceFile(project.id)) return fail(c, 409, 'Chưa có video. Tải video lên trước khi bấm AI edit.', 'no_source');
    if (project.busy) return fail(c, 409, 'AI đang dựng việc này. Chờ xong hoặc bấm dừng.', 'busy');
    if (options.templates && !options.templates(body.templateId)) return fail(c, 400, 'Không tìm thấy mẫu edit này.', 'no_template');
    if (body.music.mode === 'pick' && !body.music.assetId) return fail(c, 400, 'Chọn một bài nhạc, hoặc để AI chọn.', 'no_music');
    const missing = [...body.assets.map((a) => a.assetId), ...(body.music.mode === 'pick' ? [body.music.assetId!] : [])]
      .filter((id) => !findAsset(store.root, id));
    if (missing.length) return fail(c, 400, 'Có tư liệu hoặc bài nhạc không còn trong kho. Tải lại rồi thử lần nữa.', 'no_asset');

    const { note, music, assets, ...rest } = body;
    const quick: QuickSettings = {
      ...rest,
      assets: assets.map((a) => ({ assetId: a.assetId, ...(a.hint ? { hint: a.hint } : {}) })),
      music: { mode: music.mode, ...(music.mode === 'pick' ? { assetId: music.assetId } : {}), duck: music.duck, snapToBeat: music.snapToBeat, endOnFinal: music.endOnFinal },
      ...(note ? { note } : {}),
      startedAt: new Date().toISOString(),
    };
    const saved = store.updateProject(project.id, (p) => {
      p.quick = quick;
      if (p.status === 'draft' || p.status === 'failed') p.status = 'working';
    })!;
    emitProject(saved);
    const job = pipeline.startQuick(project.id);
    return c.json({ project: requireProject(project.id), job });
  }));
}
