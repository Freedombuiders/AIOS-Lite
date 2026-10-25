// Dựng nhanh plan v2 endpoints: structural owner edits gathered into a working draft (POST /plan/ops) and
// the owner's overrides (GET/PUT /overrides). Registered by routes.ts with the editor kit.
import type { Hono } from 'hono';
import { z } from 'zod';
import { droppedElements, emptyOverrides, mergeOverrides, type OverridesPatch } from './overrides.js';
import { applyPlanOps, PlanOpError } from './plan-ops.js';
import { elementSoundSchema, findElement, propValueSchema, type TemplateLookup } from './pipeline/plan.js';
import type { EditorKit } from './routes-editor.js';
import type { EditPlan, PlanOp } from './types.js';

export interface PlanV2RouteOptions {
  /** Template registry lookup (templates/registry.ts getTemplate): checks components of added elements. */
  templates?: TemplateLookup;
}

const elementRef = z.string().trim().min(1).max(60);
const opSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    kind: z.enum(['beat', 'scene', 'graphic', 'broll', 'zoom']),
    element: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({ op: z.literal('remove'), id: elementRef }).strict(),
  z.object({ op: z.literal('split'), id: elementRef, at: z.number().finite().min(0).max(36_000) }).strict(),
  z.object({ op: z.literal('toggleWords'), words: z.array(z.number().int().min(0)).min(1).max(5000) }).strict(),
  z.object({ op: z.literal('restore'), id: elementRef, fromVersion: z.number().int().min(1) }).strict(),
]);
const opsSchema = z.object({ baseVersion: z.number().int().min(1), ops: z.array(opSchema).min(1).max(50) }).strict();

const pct = z.number().finite().min(-100).max(100);
const elementOverrideSchema = z.object({
  t: z.tuple([pct, pct]).nullable(),
  s: z.number().finite().min(0.1).max(5).nullable(),
  text: z.object({
    kicker: z.string().max(80).nullable(),
    title: z.string().max(200).nullable(),
    sub: z.string().max(200).nullable(),
  }).partial().strict().nullable(),
  props: z.record(z.string().min(1).max(40), propValueSchema.nullable()).refine((o) => Object.keys(o).length <= 40).nullable(),
  animIn: z.string().trim().min(1).max(60).nullable(),
  sound: elementSoundSchema.strict().nullable(),
  at: z.number().finite().min(0).max(36_000).nullable(),
  duration: z.number().finite().positive().max(60).nullable(),
  hidden: z.boolean().nullable(),
  assetId: z.string().trim().min(1).max(160).nullable(),
}).partial().strict();

const color = z.string().trim().min(1).max(40);
const captionsSchema = z.object({
  pos: z.number().min(0).max(1).nullable(),
  maxWidthPct: z.number().min(10).max(100).nullable(),
  align: z.enum(['center', 'left']).nullable(),
  font: z.object({
    family: z.string().trim().min(1).max(80),
    sizePct: z.number().positive().max(30),
    weight: z.number().int().min(100).max(1000),
    upper: z.boolean().optional(),
  }).strict().nullable(),
  fill: color.nullable(),
  stroke: z.object({ color, width: z.number().min(0).max(40) }).strict().nullable(),
  shadow: z.string().max(200).nullable(),
  box: z.object({ color, padding: z.number().min(0).max(200), radius: z.number().min(0).max(200) }).strict().nullable(),
  highlight: z.object({ color, mode: z.enum(['color', 'box', 'pop']) }).strict().nullable(),
  maxWordsPerChunk: z.number().int().min(1).max(8).nullable(),
}).partial().strict();

const overridesPutSchema = z.object({
  elements: z.record(elementRef, elementOverrideSchema.nullable()).refine((o) => Object.keys(o).length <= 200),
  captions: captionsSchema.nullable(),
}).partial().strict();

export function registerPlanV2Routes(app: Hono, kit: EditorKit, options: PlanV2RouteOptions = {}) {
  const { P, store, pipeline, fail, small, guard, parse, idOf, requireProject } = kit;

  const currentPlan = (projectId: string, planVersion: number): EditPlan | null =>
    (planVersion > 0 ? store.loadPlan(projectId, planVersion) : null);
  const dropped = (projectId: string, plan: EditPlan | null) =>
    droppedElements(store.readOverrides(projectId) ?? emptyOverrides(), plan, store.listPlanVersions(projectId), (v) => store.loadPlan(projectId, v));

  // ── Structural edits, gathered into the owner's working draft ──
  app.post(`${P}/projects/:id/plan/ops`, small, guard(async (c) => {
    const body = await parse(c, opsSchema);
    const project = requireProject(idOf(c));
    if (project.planVersion < 1) return fail(c, 404, 'Chưa có kế hoạch dựng.', 'no_plan');
    if (project.busy) return fail(c, 409, 'Agent đang sửa kế hoạch. Chờ xong rồi chỉnh.', 'busy');
    if (body.baseVersion !== project.planVersion) {
      return fail(c, 409, `Kế hoạch đã sang phiên bản ${project.planVersion}. Tải lại rồi chỉnh tiếp.`, 'stale');
    }
    const ctx = pipeline.planContext(project.id);
    if (!ctx) return fail(c, 409, 'Chưa có bản chép lời để chỉnh.', 'no_transcript');
    const current = currentPlan(project.id, project.planVersion);
    if (!current) return fail(c, 404, 'Không đọc được kế hoạch hiện tại.', 'no_plan');
    let result: ReturnType<typeof applyPlanOps>;
    try {
      result = applyPlanOps(current, body.ops as PlanOp[], ctx, {
        planStatus: project.planStatus,
        nextVersion: pipeline.nextVersion(project.id),
        loadPlan: (v) => store.loadPlan(project.id, v),
        overrides: store.readOverrides(project.id),
        ...(options.templates ? { templates: options.templates } : {}),
      });
    } catch (err) {
      if (err instanceof PlanOpError) return fail(c, err.kind === 'conflict' ? 409 : 400, err.message, err.kind === 'conflict' ? 'conflict' : 'invalid_op');
      throw err;
    }
    if (!result.changed) return c.json({ plan: current, project });
    if (result.overrides) store.writeOverrides(project.id, result.overrides);
    const saved = pipeline.commitPlan(project.id, result.plan, 'draft');
    return c.json({ plan: result.plan, project: saved });
  }));

  // ── Overrides ──
  app.get(`${P}/projects/:id/overrides`, guard((c) => {
    const project = requireProject(idOf(c));
    const plan = currentPlan(project.id, project.planVersion);
    return c.json({ overrides: store.readOverrides(project.id) ?? emptyOverrides(), dropped: dropped(project.id, plan) });
  }));

  app.put(`${P}/projects/:id/overrides`, small, guard(async (c) => {
    const body = await parse(c, overridesPutSchema) as OverridesPatch;
    const project = requireProject(idOf(c));
    const plan = currentPlan(project.id, project.planVersion);
    // Edits go to elements of the current plan; taking an override away (null) always works.
    for (const [id, patch] of Object.entries(body.elements ?? {})) {
      if (patch !== null && !(plan && findElement(plan, id))) {
        return fail(c, 409, `Không còn phần tử "${id}" trong kế hoạch. Tải lại rồi chỉnh tiếp.`, 'no_element');
      }
    }
    const next = mergeOverrides(store.readOverrides(project.id) ?? emptyOverrides(), body);
    store.writeOverrides(project.id, next);
    return c.json({ overrides: next, dropped: dropped(project.id, plan) });
  }));
}
