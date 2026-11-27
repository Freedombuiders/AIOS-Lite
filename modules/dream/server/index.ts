// Dream 100, first version: learn from reference videos the owner pastes. No automatic channel scanning.
// Every route here is for the owner's pages (every write under /api/m/dream/* is an owner route, src/api/owner.ts);
// agents get no action to add links, start an analysis, or create or edit a formula.
// D2: formulas (formulas.ts), the morning suggestions (ideas.ts) and the comparison of posts with their formula
// (compare.ts), fed by learn's durable note feed.
import type { Hono } from 'hono';
import { defineModule, type ModuleContext } from '../../../src/modules/sdk.js';
import { mediaTools } from '../../_lib/media-tools/index.js';
import {
  cleanTmp,
  getVideo,
  JobQueue,
  listVideos,
  machineTools,
  queueVideos,
  requeueInterrupted,
  retryVideo,
  VideoInputError,
  type VideoRow,
} from './analyze.js';
import { addChannels, ChannelError, getChannel, listChannels, MAX_CHANNELS, removeChannel, updateWhy } from './channels.js';
import { createComparer, type Comparer } from './compare.js';
import { COMPARE_MILESTONES, formulaResult, linkSlug, STATE_LABELS } from './formula-stats.js';
import { createFormula, dismissProposal, FORMULA_CAU_TRUC, FORMULA_MO_DAU, formulaVideos, listProposals, readFormulas } from './formulas.js';
import { createIdeas, IDEAS_CRON, vnDay, type Ideas } from './ideas.js';
import { LABEL_TEXT, pickAgent } from './label.js';
import type { ToolPaths } from './measure.js';

const queues = new Map<string, JobQueue>();
const services = new Map<string, { ideas: Ideas; comparer: Comparer }>();

function servicesFor(ctx: ModuleContext): { ideas: Ideas; comparer: Comparer } {
  let s = services.get(ctx.id);
  if (!s) {
    s = { ideas: createIdeas(ctx), comparer: createComparer(ctx) };
    services.set(ctx.id, s);
  }
  return s;
}

/** Test hook: the services of a module context. */
export const _services = servicesFor;

/** How often learn's note feed is read for new 24h / 7d numbers. */
const COMPARE_POLL_MS = 15_000;
/** How often the morning catch-up is checked (module timers do not run while the machine is off). */
const IDEAS_CHECK_MS = 30 * 60_000;

/** Test hook: which tool paths new queues use (fake commands in tests). */
let toolsOverride: (() => ToolPaths) | null = null;
export function _setToolsForTests(fn: (() => ToolPaths) | null): void {
  toolsOverride = fn;
}

function queueFor(ctx: ModuleContext): JobQueue {
  let q = queues.get(ctx.id);
  if (!q) {
    q = new JobQueue(ctx, () => (toolsOverride ?? machineTools)());
    queues.set(ctx.id, q);
  }
  return q;
}

/** Wait until no job runs (tests). */
export async function _idle(ctx: ModuleContext): Promise<void> {
  await queues.get(ctx.id)?.idle();
}

function brainFolder(ctx: ModuleContext): string | null {
  const f = String(ctx.settings.get<string>('brain_folder', '') ?? '').trim();
  return f || null;
}

/** The folder must exist in Second Brain; the notes service is the one that knows. */
function checkFolder(ctx: ModuleContext, folderId: string): string | null {
  try {
    ctx.brain.notes.list(folderId, 'dream-100');
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function requireFolder(ctx: ModuleContext): string {
  const f = brainFolder(ctx);
  if (!f) throw new ChannelError('Chưa chọn thư mục Second Brain để ghi chú. Chọn ở đầu trang Dream 100.');
  const err = checkFolder(ctx, f);
  if (err) throw new ChannelError(err);
  return f;
}

const body = async (c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> => {
  try {
    const v = await c.req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function videoDto(ctx: ModuleContext, v: VideoRow) {
  const ch = v.channel_id ? getChannel(ctx, v.channel_id) : undefined;
  return { ...v, channel_handle: ch?.handle ?? null };
}

const formulaOptions = () => ({
  moDau: FORMULA_MO_DAU.map((v) => ({ value: v, label: LABEL_TEXT[v] ?? v })),
  cauTruc: FORMULA_CAU_TRUC.map((v) => ({ value: v, label: LABEL_TEXT[v] ?? v })),
});

function routes(app: Hono, ctx: ModuleContext): void {
  app.get('/overview', (c) => {
    const folder = brainFolder(ctx);
    const agentId = pickAgent(ctx);
    return c.json({
      folder,
      folderError: folder ? checkFolder(ctx, folder) : null,
      channels: listChannels(ctx).length,
      maxChannels: MAX_CHANNELS,
      agent: agentId ? { id: agentId, name: ctx.agents.get(agentId)?.name ?? agentId, images: ctx.agents.attachments(agentId).images } : null,
      // only GenBot bots that have a key (Open AgenticOS runs every agent on GenBot)
      agents: ctx.agents.list().filter((a) => a.enabled !== false && (ctx.agents.usable?.(a.id) ?? a.runtime === 'genbot')).map((a) => ({ id: a.id, name: a.name, images: ctx.agents.attachments(a.id).images })),
      tools: mediaTools(),
    });
  });

  app.put('/settings', async (c) => {
    const b = await body(c);
    const folder = str(b.brainFolder);
    if (folder !== null) {
      const f = folder.trim();
      if (f) {
        const err = checkFolder(ctx, f);
        if (err) throw new ChannelError(err);
      }
      ctx.settings.set('brain_folder', f);
    }
    const agent = str(b.analystAgent);
    if (agent !== null) {
      const a = agent.trim();
      if (a && !ctx.agents.get(a)) throw new ChannelError(`Không có agent "${a}".`);
      ctx.settings.set('analyst_agent', a);
    }
    return c.json({ ok: true });
  });

  app.get('/doctor', (c) => c.json({ tools: mediaTools() }));

  app.get('/channels', (c) => {
    const counts = new Map(
      (ctx.db.prepare("SELECT channel_id, COUNT(*) AS n FROM dream_videos WHERE channel_id IS NOT NULL AND status = 'done' GROUP BY channel_id").all() as { channel_id: string; n: number }[]).map((r) => [r.channel_id, r.n]),
    );
    return c.json({ items: listChannels(ctx).map((ch) => ({ ...ch, videos: counts.get(ch.id) ?? 0 })), max: MAX_CHANNELS });
  });

  app.post('/channels', async (c) => {
    const b = await body(c);
    const folderId = requireFolder(ctx);
    const r = addChannels(ctx, { text: str(b.text) ?? '', why: str(b.why), folderId });
    return c.json(r, r.added.length ? 201 : 200);
  });

  app.patch('/channels/:id', async (c) => {
    const b = await body(c);
    return c.json(updateWhy(ctx, c.req.param('id'), str(b.why)));
  });

  app.delete('/channels/:id', (c) => {
    if (!removeChannel(ctx, c.req.param('id'))) return c.json({ error: { code: 'not_found', message: 'Không tìm thấy kênh.' } }, 404);
    return c.json({ ok: true });
  });

  app.get('/videos', (c) => c.json({ items: listVideos(ctx).map((v) => videoDto(ctx, v)) }));

  app.get('/videos/:id', (c) => {
    const v = getVideo(ctx, c.req.param('id'));
    if (!v) return c.json({ error: { code: 'not_found', message: 'Không tìm thấy video.' } }, 404);
    return c.json(videoDto(ctx, v));
  });

  app.post('/videos', async (c) => {
    const b = await body(c);
    const folderId = requireFolder(ctx);
    const r = queueVideos(ctx, { text: str(b.text) ?? '', channelId: str(b.channelId), folderId });
    if (r.queued.length) queueFor(ctx).kick();
    return c.json(r, r.queued.length ? 202 : 200);
  });

  app.post('/videos/:id/retry', (c) => {
    const v = retryVideo(ctx, c.req.param('id'));
    queueFor(ctx).kick();
    return c.json(v, 202);
  });

  // ── formulas ──────────────────────────────────────────────────────────

  app.get('/formulas', (c) => {
    const folder = brainFolder(ctx);
    if (!folder || checkFolder(ctx, folder)) return c.json({ folder, formulas: [], proposals: [], options: formulaOptions() });
    return c.json({ folder, formulas: readFormulas(ctx, folder), proposals: listProposals(ctx, folder), options: formulaOptions() });
  });

  app.get('/formulas/:slug', (c) => {
    const folder = requireFolder(ctx);
    const slug = c.req.param('slug');
    const f = readFormulas(ctx, folder).find((x) => x.slug === slug);
    if (!f) return c.json({ error: { code: 'not_found', message: 'Không tìm thấy công thức.' } }, 404);
    const note = ctx.brain.notes.read({ folderId: folder, relPath: f.path });
    let posts: { relPath: string; data: Record<string, unknown> }[] = [];
    try {
      posts = ctx.brain.notes.list(folder, 'noi-dung/bai', { loai: 'bai-dang' }).filter((p) => linkSlug(p.data.cong_thuc) === slug);
    } catch {
      posts = [];
    }
    const result = formulaResult(posts);
    return c.json({
      formula: f,
      body: note?.body ?? '',
      result: { ...result, label: STATE_LABELS[result.trang_thai] },
      posts: posts.map((p) => ({
        path: p.relPath,
        title: typeof p.data.tieu_de === 'string' ? p.data.tieu_de : p.relPath,
        publishedAt: typeof p.data.dang_luc === 'string' ? p.data.dang_luc : null,
        comparisons: Array.isArray(p.data.doi_chieu) ? p.data.doi_chieu : [],
      })),
      videos: formulaVideos(ctx, folder, slug).map((v) => videoDto(ctx, v)),
      remark: (ctx.db.prepare('SELECT value FROM dream_state WHERE key = ?').get(`remark:${folder}:${slug}`) as { value: string } | undefined)?.value ?? null,
      milestones: COMPARE_MILESTONES,
    });
  });

  app.post('/formulas', async (c) => {
    const b = await body(c);
    const folder = requireFolder(ctx);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : v === null || v === undefined || v === '' ? null : Number.NaN);
    const f = createFormula(ctx, folder, {
      name: str(b.name) ?? '',
      slug: str(b.slug) ?? undefined,
      moDau: str(b.moDau) ?? '',
      cauTruc: str(b.cauTruc) ?? '',
      maxLen: num(b.maxLen),
      pillar: str(b.pillar),
      proposalId: typeof b.proposalId === 'number' ? b.proposalId : null,
    });
    return c.json(f, 201);
  });

  app.post('/formulas/proposals/:id/dismiss', (c) => {
    dismissProposal(ctx, requireFolder(ctx), Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  // ── daily suggestions ─────────────────────────────────────────────────

  const { ideas, comparer } = servicesFor(ctx);
  const dayParam = (v: string | undefined) => {
    if (!v) return vnDay(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ChannelError('Ngày cần dạng YYYY-MM-DD.');
    return v;
  };
  const slotParam = (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new ChannelError('Ô đề xuất không hợp lệ.');
    return n;
  };

  app.get('/ideas', (c) => {
    const day = dayParam(c.req.query('day'));
    return c.json({ ...ideas.list(day), today: vnDay(Date.now()), history: ideas.history(30) });
  });

  /** Run today's suggestions now if they have not run yet (the morning job does the same). */
  app.post('/ideas/run', async (c) => {
    requireFolder(ctx);
    return c.json(await ideas.runDay(vnDay(Date.now())));
  });

  app.post('/ideas/:day/:slot/give', (c) => c.json(ideas.give(dayParam(c.req.param('day')), slotParam(c.req.param('slot')))));

  app.post('/ideas/:day/:slot/reject', async (c) => {
    const b = await body(c);
    return c.json(ideas.reject(dayParam(c.req.param('day')), slotParam(c.req.param('slot')), str(b.reason) ?? ''));
  });

  app.post('/ideas/:day/:slot/later', (c) => c.json(ideas.later(dayParam(c.req.param('day')), slotParam(c.req.param('slot')))));

  /** Read learn's note feed now (the timer does the same every 15 seconds). */
  app.post('/compare/run', async (c) => c.json(await comparer.run()));

  app.delete('/videos/:id', (c) => {
    const v = getVideo(ctx, c.req.param('id'));
    if (!v) return c.json({ error: { code: 'not_found', message: 'Không tìm thấy video.' } }, 404);
    if (v.status === 'running') throw new VideoInputError('Video đang phân tích, chờ xong rồi xoá.');
    ctx.db.prepare('DELETE FROM dream_videos WHERE id = ?').run(v.id);
    return c.json({ ok: true });
  });
}

export default defineModule({
  routes,

  start(ctx) {
    const removed = cleanTmp(ctx);
    if (removed) ctx.log.info({ removed }, 'dream: đã dọn thư mục tạm còn sót');
    requeueInterrupted(ctx);
    queueFor(ctx).kick();

    const { ideas, comparer } = servicesFor(ctx);
    // comparison: catch up on learn's feed and on notes written while dream was off, then poll
    const compare = () => comparer.run().then(() => undefined).catch((err) => ctx.log.error({ err }, 'dream: đối chiếu lỗi'));
    void (async () => {
      const folder = brainFolder(ctx);
      if (folder && !checkFolder(ctx, folder)) await comparer.reconcile(folder).catch((err) => ctx.log.error({ err }, 'dream: đối chiếu bù lỗi'));
      await compare();
    })();
    ctx.schedule.every('compare', COMPARE_POLL_MS, compare);
    // morning suggestions: the cron, plus a catch-up on start and every 30 minutes (timers do not run while off).
    // Not awaited: agent turns may take minutes, start() must not wait for them.
    const catchUp = () => ideas.catchUp().then(() => undefined).catch((err) => ctx.log.error({ err }, 'dream: đề xuất hằng ngày lỗi'));
    void catchUp();
    ctx.schedule.every('ideas', IDEAS_CRON, catchUp);
    ctx.schedule.every('ideas-check', IDEAS_CHECK_MS, catchUp);
  },

  async stop(ctx) {
    const q = queues.get(ctx.id);
    queues.delete(ctx.id);
    services.delete(ctx.id);
    await q?.stop();
  },
});
