/**
 * Background driver of "create" projects (Google Flow via RocketFlow). The owner's build had the director agent loop
 * generate → poll → import → render with tools; here the agent only writes the brief and the plan, and this tick does
 * the rest, one step per scene per round, under the same permission gate (create_brief records the owner's explicit go).
 */
import type { VideoEditStore } from './edit/store.js';
import type { CreationService } from './create/service.js';

export interface AdvanceResult { projectId: string; step: string; ok: boolean; error?: string }

export async function advanceCreations(store: VideoEditStore, creation: CreationService, signal?: AbortSignal): Promise<AdvanceResult[]> {
  const out: AdvanceResult[] = [];
  for (const summary of store.listProjects()) {
    if (summary.mode !== 'create') continue;
    const p = store.loadProject(summary.id);
    if (!p?.creation || !p.creation.brief.generationAuthorized || p.busy) continue;
    if (['brief', 'blocked', 'done', 'rendering'].includes(p.creation.state)) continue;
    const run = async (name: string, args: unknown, step: string) => {
      try { await creation.execute(p.id, p.agentId, name, args, signal); out.push({ projectId: p.id, step, ok: true }); return true; }
      catch (err) { out.push({ projectId: p.id, step, ok: false, error: err instanceof Error ? err.message : String(err) }); return false; }
    };
    const scenes = p.creation.scenes;
    if (!scenes.length) continue;
    for (const scene of scenes) {
      if (signal?.aborted) return out;
      if (scene.state === 'planned') { if (!(await run('create_generate', { sceneId: scene.id }, `generate:${scene.id}`))) break; }
      else if (scene.state === 'submitted') await run('create_poll', { sceneId: scene.id, waitSeconds: 0 }, `poll:${scene.id}`);
      else if (scene.state === 'ready') await run('create_import', { sceneId: scene.id }, `import:${scene.id}`);
    }
    const fresh = store.loadProject(p.id);
    if (fresh?.creation && fresh.creation.scenes.length && fresh.creation.scenes.every((s) => s.state === 'imported') && fresh.creation.state === 'ready') {
      await run('create_render', {}, 'render');
    }
  }
  return out;
}
