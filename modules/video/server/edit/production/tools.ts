/**
 * "video-produce": the Đạo diễn AI's tools for one production, as a per-turn MCP server (same
 * loopback-gateway pattern as video-create). Identity (project, agent) is fixed when the gateway
 * starts and re-checked on every call; nothing in tool input can widen it.
 *
 * No tool spends money: produce_request_generation only raises the owner's approval card.
 */

import { z } from 'zod';

import { describeEstimate } from './estimate.js';
import type { ProductionService, ProductionView } from './service.js';
import { SCENE_ENGINES, type SceneKind } from './types.js';

const empty = z.object({}).strict();
const uuid = z.string().uuid();
const kolRef = z.string().trim().min(1).max(80).describe('KOL handle (without @), name or id from produce_context');
const sceneInput = z.object({
  id: uuid.optional().describe('Keep an existing scene: fields you leave out keep their value, and an unchanged scene keeps its finished take'),
  kind: z.enum(['talking', 'broll', 'clip']),
  kol: kolRef.nullable().optional().describe('Omit to keep (existing scene) or to use the lead KOL (new talking scene); null = no KOL in the shot'),
  text: z.string().max(1500).optional().describe('talking: exactly what the KOL says (spoken Vietnamese). broll: optional on-screen words'),
  visual: z.string().max(1000).optional().describe('broll: English description for the video model / stock search (never a real person\'s name). talking: setting & gesture (optional)'),
  engine: z.enum(SCENE_ENGINES as [string, ...string[]]).optional(),
  durationSec: z.number().min(1).max(90).optional(),
  sourceAssetId: z.string().max(80).nullable().optional().describe('talking/broll only: KOL IMAGE id for the face (produce_list_media → images; default: newest approved)'),
  clipAssetId: z.string().max(80).nullable().optional().describe('REQUIRED for kind "clip": KOL gallery VIDEO id (produce_list_media → videos)'),
}).strict();

const definitions = [
  ['produce_context', 'Read the production: brief, format, script, running length vs target, every scene with status/problem/error/face/trim, the cast (handles, HeyGen voice, real person or not, brand kit), connected engines, the pending approval and the cost of the remaining scenes. Call first in every turn.', empty],
  ['produce_list_media', "List a KOL's images (face / start-frame candidates: approved first, label = outfit · setting · pose, identityScore = face match 0-100, prefer ≥ 90) and gallery videos (for clip scenes), with ids.", z.object({ kol: kolRef }).strict()],
  ['produce_inspect_scene', 'Look at a generated scene: returns a strip of 4 frames as an image plus planned vs actual length, trim and captions. Use it to judge every new take (right face, matches the visual, no glitches) before telling the owner.', z.object({ sceneId: uuid }).strict()],
  ['produce_trim_scene', 'Trim a finished take without regenerating (free): start = seconds into the clip, durationSec = how much plays.', z.object({ sceneId: uuid, start: z.number().min(0).max(600).optional(), durationSec: z.number().min(0.5).max(600).optional() }).strict()],
  ['produce_update_brief', 'Change title, brief, aspect, target length or the cast (KOL handles) when the owner asks.', z.object({
    title: z.string().max(90).optional(), brief: z.string().max(6000).optional(),
    aspect: z.enum(['9:16', '16:9', '1:1', '4:5']).optional(), targetSec: z.number().int().min(5).max(180).optional(),
    cast: z.array(kolRef).max(6).optional(),
  }).strict()],
  ['produce_write_storyboard', "Let the lead KOL's own brain write script + scenes in the KOL's voice from the brief (replaces the storyboard). Good first draft; refine it with produce_update_scene / produce_set_storyboard. If it takes long it continues in the background and the system tells you when it is done.", empty],
  ['produce_set_storyboard', 'Replace the whole storyboard with your own script and ordered scenes. Pass the id of scenes you keep. Voids a pending approval.', z.object({
    script: z.object({ title: z.string().max(120).optional(), hook: z.string().max(300).optional(), caption: z.string().max(2200).optional(), hashtags: z.array(z.string().max(60)).max(15).optional() }).strict().optional(),
    scenes: z.array(sceneInput).min(1).max(20),
  }).strict()],
  ['produce_update_scene', 'Edit one scene (line, visual, KOL, engine, length, face image, gallery clip). Changing what gets generated sends a finished scene back to draft; only a shorter length re-trims it.', z.object({
    sceneId: uuid, kind: z.enum(['talking', 'broll', 'clip']).optional(), kol: kolRef.nullable().optional(), text: z.string().max(2000).optional(),
    visual: z.string().max(1200).optional(), engine: z.enum(SCENE_ENGINES as [string, ...string[]]).optional(), durationSec: z.number().min(1).max(120).optional(),
    sourceAssetId: z.string().max(80).nullable().optional().describe('talking/broll only: KOL IMAGE id for the face'),
    clipAssetId: z.string().max(80).nullable().optional().describe('kind "clip": KOL gallery VIDEO id (a shorter durationSec trims it)'),
  }).strict()],
  ['produce_add_scene', 'Insert one scene at a position (0-based; default end).', sceneInput.omit({ id: true }).extend({ at: z.number().int().min(0).optional() }).strict()],
  ['produce_move_scene', 'Move a scene to a new 0-based position.', z.object({ sceneId: uuid, to: z.number().int().min(0) }).strict()],
  ['produce_remove_scene', 'Delete a scene.', z.object({ sceneId: uuid }).strict()],
  ['produce_estimate', 'Cost of generating the given scenes (default: drafts + failed): USD for Veo/fal, HeyGen credits, Flow scenes, free scenes.', z.object({ sceneIds: z.array(uuid).max(30).optional() }).strict()],
  ['produce_request_generation', "Ask the owner to approve generating scenes (default: drafts + failed). Raises ONE approval card with the cost in chat, 'Cần tôi' and Telegram. Never generates by itself: after calling it, tell the owner what you asked for and end the turn.", z.object({ sceneIds: z.array(uuid).max(30).optional() }).strict()],
  ['produce_status', 'Short status: state, scenes done/running/failed, pending approval, finishing project.', empty],
  ['produce_finish', 'When every scene is done: assemble the A-roll and hand it to the HyperFrames finishing step (captions, hook, effects, music, covers). Runs in the background.', empty],
] as const;

/** A tool result carrying its own MCP content blocks (text + image) instead of one JSON text block. */
const CONTENT = '__content';
const WRITE_BUDGET_MS = 95_000;


export const produceTools = definitions.map(([name, description, schema]) => ({ name, description, inputSchema: z.toJSONSchema(schema) }));

/** Resolves a KOL reference (handle, name or id) against the cast. */
function kolIdFrom(ref: string | null | undefined, cast: { id: string; name: string; handle: string }[]): string | null {
  if (!ref) return null;
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[@\s]/g, '').toLowerCase();
  const r = fold(ref);
  const hit = cast.find((c) => c.id === ref || fold(c.handle) === r || fold(c.name) === r);
  if (!hit) throw new Error(`Không có KOL "${ref}" trong danh sách được gọi.`);
  return hit.id;
}

function brief(view: ProductionView) {
  const counts = { done: 0, running: 0, failed: 0, draft: 0 };
  for (const s of view.scenes) {
    if (s.status === 'done') counts.done++;
    else if (s.status === 'running' || s.status === 'queued') counts.running++;
    else if (s.status === 'failed') counts.failed++;
    else counts.draft++;
  }
  return counts;
}

export async function executeProduceTool(service: ProductionService, productionId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const p = service.get(productionId);
  const cast = service.castOf(p);
  switch (name) {
    case 'produce_context': {
      const estimate = service.estimate(productionId);
      const plannedSec = Math.round(p.scenes.reduce((t, s) => t + (s.output?.durationSec ?? s.durationSec), 0) * 10) / 10;
      return {
        production: {
          title: p.title, titleLockedByOwner: Boolean(p.titleLocked), brief: p.brief, aspect: p.aspect, targetSec: p.targetSec, plannedSec,
          state: p.state, script: p.script, error: p.error, writing: service.isWriting(productionId),
          scenes: p.scenes.map((s, i) => ({
            n: i + 1, id: s.id, kind: s.kind, kol: cast.find((c) => c.id === s.kolId)?.handle ?? null, text: s.text, visual: s.visual,
            engine: s.engine, durationSec: s.durationSec, face: s.sourceAssetId, clip: s.clipAssetId, take: s.take ?? 0,
            status: s.status, problem: s.problem, error: s.error,
            ...(s.status === 'queued' && s.retry ? { autoRetry: `lần ${s.retry.n + 1}, lúc ${s.retry.at}` } : {}),
            output: s.output ? { playsSec: s.output.durationSec, sourceSec: s.output.sourceSec ?? null, trimStart: s.trimStart ?? 0, credit: s.output.credit ?? null } : null,
          })),
          pendingApproval: p.pendingApproval ? { approvalId: p.pendingApproval.approvalId, scenes: p.pendingApproval.sceneIds.length, cost: describeEstimate(p.pendingApproval.estimate) } : null,
          finishing: p.finishProjectId ? 'Đã có bản ghép (giai đoạn hoàn thiện HyperFrames). Sửa hoặc tạo lại cảnh rồi produce_finish để ghép lại; kế hoạch dựng sẽ làm lại.' : null,
          series: p.series ?? null,
        },
        cast: cast.map((c) => ({
          handle: c.handle, name: c.name, id: c.id, realPerson: c.realPerson, heygenVoice: c.voice?.name ?? null, images: c.images, videos: c.videos, brand: c.brand,
          ...(c.realPerson ? { rule: 'Người thật: chỉ dựng cảnh nói bằng HeyGen; không đưa mặt hay tên vào Veo/B-roll AI.' } : {}),
        })),
        engines: service.engineSummary(),
        remainingCost: describeEstimate(estimate),
      };
    }
    case 'produce_list_media': {
      const kolId = kolIdFrom((args as { kol: string }).kol, cast)!;
      const items = service.media(productionId, kolId);
      return {
        images: items.filter((m) => m.kind === 'image').map((m) => ({ id: m.id, useAs: 'sourceAssetId', status: m.status, identityScore: m.identityScore ?? null, label: m.label })),
        videos: items.filter((m) => m.kind === 'video').map((m) => ({ id: m.id, useAs: 'clipAssetId (kind "clip")', status: m.status, durationSec: m.durationSec, label: m.label })),
      };
    }
    case 'produce_inspect_scene': {
      const r = await service.inspectScene(productionId, (args as { sceneId: string }).sceneId);
      return { [CONTENT]: [{ type: 'text', text: JSON.stringify(r.info) }, ...(r.image ? [{ type: 'image', data: r.image, mimeType: 'image/jpeg' }] : [])] };
    }
    case 'produce_trim_scene': {
      const a = args as { sceneId: string; start?: number; durationSec?: number };
      const v = await service.trimScene(productionId, a.sceneId, { start: a.start, durationSec: a.durationSec });
      const s = v.scenes.find((x) => x.id === a.sceneId)!;
      return { ok: true, trimStart: s.trimStart ?? 0, playsSec: s.output?.durationSec ?? null, sourceSec: s.output?.sourceSec ?? null };
    }
    case 'produce_update_brief': {
      const a = args as { title?: string; brief?: string; aspect?: '9:16' | '16:9' | '1:1' | '4:5'; targetSec?: number; cast?: string[] };
      const all = service.allCast();
      const castIds = a.cast ? a.cast.map((r) => kolIdFrom(r, all)!).filter(Boolean) : undefined;
      const v = await service.patch(productionId, { ...a, ...(castIds ? { cast: castIds } : {}) });
      return { ok: true, title: v.title, cast: v.cast.length, aspect: v.aspect, targetSec: v.targetSec };
    }
    case 'produce_write_storyboard': {
      // The KOL brain can take minutes; the MCP call cannot wait that long. Past the budget it keeps
      // writing in the background and the service posts a system message + wakes the director.
      const job = service.write(productionId);
      const first = await Promise.race([job.then((v) => ({ v })), new Promise<null>((r) => { const t = setTimeout(() => r(null), WRITE_BUDGET_MS); t.unref?.(); })]);
      if (first) return { ok: true, title: first.v.title, scenes: first.v.scenes.length, hook: first.v.script?.hook ?? '' };
      service.backgroundWrite(productionId, job);
      return { ok: true, pending: true, note: 'Bộ não KOL vẫn đang viết. Kết thúc lượt và báo chủ kênh; hệ thống sẽ nhắn khi kịch bản xong.' };
    }
    case 'produce_set_storyboard': {
      const a = args as { script?: Record<string, unknown>; scenes: z.infer<typeof sceneInput>[] };
      const v = await service.setStoryboard(productionId, {
        script: a.script as never,
        scenes: a.scenes.map((s) => {
          const keep = Boolean(s.id && p.scenes.some((x) => x.id === s.id));
          const kolId = s.kol !== undefined ? kolIdFrom(s.kol, cast) : keep ? undefined : s.kind !== 'broll' ? cast[0]?.id ?? null : null;
          return {
            ...(s.id ? { id: s.id } : {}), kind: s.kind as SceneKind,
            ...(kolId !== undefined ? { kolId } : {}),
            ...(s.text !== undefined ? { text: s.text } : {}), ...(s.visual !== undefined ? { visual: s.visual } : {}),
            ...(s.engine ? { engine: s.engine as never } : {}), ...(s.durationSec ? { durationSec: s.durationSec } : {}),
            ...(s.sourceAssetId !== undefined ? { sourceAssetId: s.sourceAssetId } : {}),
            ...(s.clipAssetId !== undefined ? { clipAssetId: s.clipAssetId } : {}),
          };
        }),
      });
      return { ok: true, scenes: v.scenes.map((s, i) => ({ n: i + 1, id: s.id, status: s.status, problem: s.problem })) };
    }
    case 'produce_update_scene': {
      const { sceneId, kol: ref, ...rest } = args as { sceneId: string; kol?: string | null } & Record<string, unknown>;
      const patch = { ...(rest as Record<string, unknown>), ...(ref !== undefined ? { kolId: kolIdFrom(ref, cast) } : {}) };
      const v = await service.patchScene(productionId, sceneId, patch as Parameters<ProductionService['patchScene']>[2]);
      const s = v.scenes.find((x) => x.id === sceneId)!;
      return { ok: true, scene: { id: s.id, status: s.status, problem: s.problem } };
    }
    case 'produce_add_scene': {
      const { at, kol: ref, ...rest } = args as { at?: number; kol?: string | null } & z.infer<typeof sceneInput>;
      const scene = { ...(rest as Record<string, unknown>), kolId: ref !== undefined ? kolIdFrom(ref, cast) : rest.kind !== 'broll' ? cast[0]?.id ?? null : null };
      const v = await service.addScene(productionId, scene as Parameters<ProductionService['addScene']>[1], at);
      return { ok: true, scenes: v.scenes.length };
    }
    case 'produce_move_scene': {
      const a = args as { sceneId: string; to: number };
      await service.moveScene(productionId, a.sceneId, a.to);
      return { ok: true };
    }
    case 'produce_remove_scene': {
      await service.removeScene(productionId, (args as { sceneId: string }).sceneId);
      return { ok: true };
    }
    case 'produce_estimate': {
      const e = service.estimate(productionId, (args as { sceneIds?: string[] }).sceneIds);
      return { summary: describeEstimate(e), ...e };
    }
    case 'produce_request_generation': {
      const r = await service.requestGeneration(productionId, (args as { sceneIds?: string[] }).sceneIds, 'agent');
      return { ok: true, approvalId: r.approvalId, cost: describeEstimate(r.estimate), note: 'Đã gửi thẻ duyệt cho chủ kênh. Không tạo gì cho tới khi chủ duyệt. Kết thúc lượt và nói ngắn gọn đã xin duyệt gì.' };
    }
    case 'produce_status': {
      return { state: p.state, ...brief(p), pendingApproval: Boolean(p.pendingApproval), finishProjectId: p.finishProjectId };
    }
    case 'produce_finish': {
      void service.finish(productionId).catch(() => { /* the error is on the production and in its events */ });
      return { ok: true, note: 'Đang ghép các cảnh và chuyển sang hoàn thiện HyperFrames. Báo chủ kênh: khi kế hoạch hoàn thiện sẵn sàng sẽ có thẻ duyệt.' };
    }
  }
  throw new Error('Unknown tool');
}

/** Validates one tool call from an agent action against the schemas of the owner's MCP tool set. */
export function parseProduceArgs(name: string, args: unknown): Record<string, unknown> {
  const definition = definitions.find((d) => d[0] === name);
  if (!definition) throw new Error('Công cụ không tồn tại.');
  return definition[2].parse(args ?? {}) as Record<string, unknown>;
}
