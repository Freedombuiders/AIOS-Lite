// Asset Hub endpoints (Dựng nhanh): search the sources (optionally scored against a B-roll slot), bring a
// candidate into the library, index one library file. routes.ts registers them before the library routes so
// GET /assets/search is not read as an asset id.
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { LibraryError } from '../library/store.js';
import type { EditorKit } from '../routes-editor.js';
import { fetchCandidate } from './fetch.js';
import { bindAssetHub, hub } from './hub.js';
import { indexAsset, startAutoIndex } from './indexer.js';
import { SOURCE_ORDER, searchAssets } from './providers.js';
import { scoreCandidates, spokenLine } from './score.js';
import type { AssetCandidate } from './types.js';

const searchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  kind: z.enum(['video', 'image', 'bgm', 'sfx']).optional(),
  source: z.enum(['project', 'mine', 'pexels', 'pexels-photo']).optional(),
  projectId: z.string().max(64).optional(),
  /** Score the results against this B-roll slot of the project's current plan (its query and spoken line). */
  brollId: z.string().max(60).optional(),
  aspect: z.enum(['9:16', '16:9', '1:1', '4:5']).optional(),
  limit: z.coerce.number().int().min(1).max(30).optional(),
}).strict();

const fetchSchema = z.object({
  ref: z.string().trim().min(1).max(120),
  keywords: z.array(z.string().trim().min(1).max(40)).max(6).optional(),
}).strict();

const indexSchema = z.object({
  assetId: z.string().trim().min(1).max(160),
  force: z.boolean().optional(),
}).strict();

export function registerAssetHubRoutes(app: Hono, kit: Pick<EditorKit, 'P' | 'root' | 'store' | 'fail' | 'small' | 'guard' | 'parse'>): void {
  const { P, fail, small, guard, parse } = kit;
  bindAssetHub(kit.root, kit.store);
  startAutoIndex();

  // Library errors (404 / 422 …) keep their status; everything else goes to the shared guard.
  const safe = (fn: (c: Context) => Promise<Response>) => guard(async (c) => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof LibraryError) return fail(c, err.status, err.message, err.code);
      throw err;
    }
  });

  app.get(`${P}/assets/search`, safe(async (c) => {
    const q = searchSchema.parse(c.req.query());
    const project = q.projectId ? kit.store.loadProject(q.projectId) : null;
    if (q.projectId && !project) return fail(c, 404, 'Không tìm thấy việc dựng này.');
    const plan = project && (project.plan?.version === project.planVersion ? project.plan : kit.store.loadPlan(project.id, project.planVersion));
    const broll = q.brollId ? plan?.brolls.find((b) => b.id === q.brollId) : undefined;
    if (q.brollId && !broll) return fail(c, 404, 'Không tìm thấy cảnh trám này trong kế hoạch.', 'no_broll');

    const keywords = q.q ? q.q.split(/[,\s]+/).filter(Boolean).slice(0, 6) : broll?.query?.keywords ?? [];
    const description = broll?.query?.description ?? broll?.title ?? q.q ?? '';
    if (keywords.length === 0 && !description) return fail(c, 400, 'Nhập từ khoá để tìm.', 'no_query');
    const kinds: AssetCandidate['kind'][] = q.kind ? [q.kind] : ['video', 'image'];
    const sources = q.source ? [q.source] : q.kind === 'bgm' || q.kind === 'sfx' ? ['mine' as const] : SOURCE_ORDER;
    const found = await searchAssets({
      keywords, description, kinds, aspect: q.aspect ?? project?.aspect, ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(broll ? { minSec: broll.duration * 0.8 } : {}), limit: q.limit ?? 6,
    }, sources);

    if (!broll || !project || found.candidates.length === 0) return c.json(found);
    const scored = await scoreCandidates(found.candidates, {
      agentId: project.agentId || hub().defaultAgentId(),
      line: spokenLine(kit.store.readTranscript(project.id), broll.anchorWord, broll.duration),
      description, keywords,
    });
    const candidates = [...scored.candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return c.json({ candidates, notes: scored.error ? [...found.notes, `Chưa chấm được: ${scored.error}.`] : found.notes });
  }));

  app.post(`${P}/assets/fetch`, small, safe(async (c) => {
    const body = await parse(c, fetchSchema);
    const { asset, downloaded } = await fetchCandidate(body.ref, { keywords: body.keywords });
    return c.json({ asset, downloaded }, downloaded ? 201 : 200);
  }));

  app.post(`${P}/assets/index`, small, safe(async (c) => {
    const body = await parse(c, indexSchema);
    return c.json(await indexAsset(body.assetId, { force: body.force }));
  }));
}
