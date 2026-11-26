// Dream 100, first version: learn from reference videos the owner pastes. No automatic channel scanning.
// Every route here is for the owner's pages; agents get no action to add links or start an analysis.
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
import { pickAgent } from './label.js';
import type { ToolPaths } from './measure.js';

const queues = new Map<string, JobQueue>();

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
      agents: ctx.agents.list().filter((a) => a.enabled !== false).map((a) => ({ id: a.id, name: a.name, images: ctx.agents.attachments(a.id).images })),
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
  },

  async stop(ctx) {
    const q = queues.get(ctx.id);
    queues.delete(ctx.id);
    await q?.stop();
  },
});
