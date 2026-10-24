/**
 * Video Studio › Sản xuất API (prefix /api/video-edit).
 *
 * GET    /production/engines                     engines, finishing tools, what to fix
 * GET    /production/cast                        KOLs callable with @ (images, videos, HeyGen voice, brand kit)
 * PUT    /production/cast/:kolId/voice           { voiceId, name } | { voiceId: null }
 * PUT    /production/cast/:kolId/brand           Partial<KolBrand>
 * GET    /production/heygen/voices?language=     the workspace's voices (private first)
 * GET    /productions                            summaries
 * POST   /productions                            { brief, cast[], aspect, targetSec, title?, agent? } → host project + Đạo diễn AI turn
 * POST   /productions/series                     { brief, cast[], count, aspect, targetSec } → one production per angle
 * GET    /productions/:id                        production (host project created on demand)
 * PATCH  /productions/:id                        { title?, brief?, cast?, aspect?, targetSec? }
 * DELETE /productions/:id                        production + host project
 * POST   /productions/:id/write                  storyboard by the lead KOL's brain
 * POST   /productions/:id/scenes                 add { kind, …, at? }
 * PATCH  /productions/:id/scenes/:sceneId        edit
 * POST   /productions/:id/scenes/:sceneId/move   { to }
 * DELETE /productions/:id/scenes/:sceneId
 * GET    /productions/:id/estimate?sceneIds=a,b  cost of the batch
 * POST   /productions/:id/generate               { sceneIds? } → spend-approval card (never generates)
 * POST   /productions/:id/finish                 assemble → HyperFrames finishing on the host project
 * GET    /productions/:id/events                 SSE { type: 'production', production }
 * GET    /productions/:id/scenes/:sceneId/{video|thumb}
 * POST   /projects/:id/publish                   { personaId?, version? } → KOL asset + post draft
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { loadSettings } from '../../kol-port.js';
import { voiceConfigured } from '../../kol-port.js';
import { rocketFlowService } from '../../studio/service.js';
import type { DoctorResult } from '../doctor.js';
import { subscribeVideoEvents } from '../events.js';
import type { Pipeline } from '../pipeline/runner.js';
import { serveFile } from '../serve.js';
import { StoreError, type VideoEditStore } from '../store.js';
import type { MediaInfo, VideoProject } from '../types.js';
import { approvalPort } from './approval.js';
import { engineStatuses, pexelsStock, type RocketLike, type StockSource } from './engines.js';
import { createHeygenClient, HeygenError, type HeygenClient } from './heygen.js';
import { kolBridge, type KolBridge } from './kol-bridge.js';
import { publishToKol } from './publish.js';
import { bindProductionService } from './runtime.js';
import { planSeries } from './series.js';
import { createProductionService, type ApprovalPort, type ProductionService } from './service.js';
import { createProductionStore } from './store.js';
import type { AgentRunner } from '../../kol-port.js';
import type { EngineStatus } from './types.js';

const ASPECTS = ['9:16', '16:9', '1:1', '4:5'] as const;
const ENGINES = ['heygen', 'veo', 'fal', 'rocketflow', 'stock', 'clip'] as const;
const SSE_PING_MS = 20_000;

export interface ProductionKit {
  P: string;
  root: string;
  editStore: VideoEditStore;
  pipeline: Pipeline;
  small: (c: Context, next: () => Promise<void>) => Promise<Response | void>;
  probe: (file: string) => Promise<MediaInfo>;
  thumbnail: (src: string, dest: string, durationSec: number) => Promise<void>;
  emitProject: (p: VideoProject) => void;
  doctor: (root: string) => Promise<DoctorResult>;
  defaultAgentId: () => string;
  /** Test seams. */
  heygen?: HeygenClient;
  kol?: KolBridge;
  stock?: StockSource;
  rocket?: RocketLike | null;
  rocketInstalled?: () => boolean;
  rocketDownloadRoot?: string;
  pollMs?: number;
  approvals?: ApprovalPort;
  writer?: AgentRunner;
  /** false: never start director turns (tests). */
  agentTurns?: boolean;
  publish?: Partial<Parameters<typeof publishToKol>[0]>;
}

function statusOf(err: unknown): 400 | 402 | 404 | 409 | 412 | 500 | 502 {
  const s = (err as { status?: number })?.status;
  if (s === 402 || s === 404 || s === 409 || s === 412) return s;
  if (err instanceof HeygenError) return s && s >= 500 ? 502 : 400;
  return 400;
}

export function registerProductionRoutes(app: Hono, kit: ProductionKit): ProductionService & { stopPolling(): void } {
  const { P, small } = kit;
  const store = createProductionStore(kit.root);
  const heygen = kit.heygen ?? createHeygenClient();
  const kol = kit.kol ?? kolBridge;
  const stock = kit.stock ?? pexelsStock;
  const rocket = kit.rocket === undefined ? rocketFlowService : kit.rocket;
  const rocketInstalled = kit.rocketInstalled ?? (() => fs.existsSync(rocketFlowService.bridge.serverPath));
  const agentTurns = kit.agentTurns !== false;

  const startTurn = (projectId: string, note: string): Promise<void> | null => {
    if (!agentTurns) return null;
    try {
      const host = kit.editStore.loadProject(projectId);
      if (!host || host.busy) return null;
      return kit.pipeline.beginTurn(projectId, 'produce', note).done;
    } catch { return null; }
  };
  // A wake that cannot start now (host busy) is retried by the service on its next background round.
  const tryWake = (projectId: string, note: string): boolean => {
    if (!agentTurns) return true;
    const turn = startTurn(projectId, note);
    if (turn) void turn.catch(() => undefined);
    return turn !== null;
  };

  const service = createProductionService({
    engines: {
      heygen, kol, stock, rocket, rocketInstalled, store,
      rocketDownloadRoot: kit.rocketDownloadRoot ?? (process.env.ROCKETFLOW_DOWNLOAD_ROOT || path.join(os.homedir(), 'Downloads', 'RocketFlow')),
    },
    handoff: { editStore: kit.editStore, pipeline: kit.pipeline, probe: kit.probe, thumbnail: kit.thumbnail, emitProject: kit.emitProject, defaultAgentId: kit.defaultAgentId },
    approvals: kit.approvals ?? approvalPort,
    ...(kit.writer ? { writer: kit.writer } : {}),
    priceOverrides: () => { try { return loadSettings().priceOverrides; } catch { return {}; } },
    wake: tryWake,
  });
  bindProductionService(kit.root, service);
  try { service.recover(); } catch { /* store unreadable: nothing to recover */ }

  const guard = (fn: (c: Context) => Response | Promise<Response>) => async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof StoreError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
      if (err instanceof z.ZodError) return c.json({ error: 'Dữ liệu chưa hợp lệ. Kiểm tra lại các trường đã nhập.', code: 'invalid' }, 400);
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message.slice(0, 400) || 'Có lỗi ở máy chủ.' }, statusOf(err));
    }
  };
  const body = async <T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> => schema.parse(await c.req.json().catch(() => null));
  const id = (c: Context) => c.req.param('id') ?? '';
  const sid = (c: Context) => c.req.param('sceneId') ?? '';

  // ── Engines, cast, voices, brand ──
  let doctorCache: { at: number; checks: DoctorResult['checks'] } | null = null;
  async function finishingTools(): Promise<{ hyperframes: EngineStatus; whisper: EngineStatus; elevenlabs: EngineStatus }> {
    if (!doctorCache || Date.now() - doctorCache.at > 60_000) {
      try { doctorCache = { at: Date.now(), checks: (await kit.doctor(kit.root)).checks }; } catch { doctorCache = { at: Date.now(), checks: [] }; }
    }
    const check = (cid: string) => doctorCache!.checks.find((x) => x.id === cid);
    const hf = check('hyperframes'), chrome = check('chrome'), whisper = check('whisper-model');
    const el = voiceConfigured();
    return {
      hyperframes: { id: 'hyperframes', label: 'HyperFrames', role: 'Phụ đề động, hook, hiệu ứng theo lời, ảnh bìa và xuất MP4', ready: Boolean(hf?.ok && chrome?.ok), detail: hf?.ok ? `${hf.detail}${chrome?.ok ? ' · Chrome sẵn sàng' : ' · thiếu Chrome'}` : 'Chưa cài', fix: hf?.ok && chrome?.ok ? null : hf?.fix ?? chrome?.fix ?? 'npx hyperframes' },
      whisper: { id: 'whisper', label: 'Whisper tiếng Việt', role: 'Chép lời cho video quay sẵn (video sản xuất từ kịch bản không cần)', ready: Boolean(whisper?.ok), detail: whisper?.detail ?? 'Chưa kiểm tra', fix: whisper?.ok ? null : whisper?.fix ?? null },
      elevenlabs: { id: 'elevenlabs', label: 'ElevenLabs', role: 'Giọng đọc lồng tiếng (tuỳ chọn)', ready: el, detail: el ? 'Đã kết nối' : 'Chưa có API key', fix: el ? null : 'Integrations › ElevenLabs' },
    };
  }

  app.get(`${P}/production/engines`, guard(async (c) => c.json({ engines: engineStatuses({ heygen, kol, rocketInstalled, stock }, await finishingTools()) })));

  app.get(`${P}/production/cast`, guard((c) => c.json({ cast: kol.listCast(store.voices()).map((m) => ({ ...m, brand: store.brand(m.id) })) })));

  app.put(`${P}/production/cast/:kolId/voice`, small, guard(async (c) => {
    const kolId = c.req.param('kolId') ?? '';
    if (!kol.persona(kolId)) throw new StoreError(404, 'Không tìm thấy KOL này.');
    const b = await body(c, z.object({ voiceId: z.string().trim().min(1).max(120).nullable(), name: z.string().trim().max(120).optional() }).strict());
    const voices = store.setVoice(kolId, b.voiceId ? { provider: 'heygen', voiceId: b.voiceId, name: b.name || b.voiceId } : null);
    return c.json({ voice: voices[kolId] ?? null });
  }));

  app.put(`${P}/production/cast/:kolId/brand`, small, guard(async (c) => {
    const kolId = c.req.param('kolId') ?? '';
    if (!kol.persona(kolId)) throw new StoreError(404, 'Không tìm thấy KOL này.');
    const b = await body(c, z.object({
      styleId: z.string().max(80).nullable(), cta: z.string().max(200), intro: z.string().max(200), outro: z.string().max(200),
      captionNote: z.string().max(300), music: z.enum(['auto', 'none']),
    }).partial().strict());
    return c.json({ brand: store.setBrand(kolId, b) });
  }));

  app.get(`${P}/production/heygen/voices`, guard(async (c) => {
    if (!heygen.configured()) return c.json({ configured: false, voices: [] });
    const language = c.req.query('language') || undefined;
    const pages = async (type: 'private' | 'public', lang: string | undefined, max: number) => {
      const first = await heygen.listVoices({ type, language: lang, limit: 100 });
      let all = first.voices;
      let token = first.next;
      for (let i = 1; token && i < max; i++) {
        const more = await heygen.listVoices({ type, language: lang, limit: 100, token });
        all = all.concat(more.voices);
        token = more.next;
      }
      return all;
    };
    const mine = await pages('private', language, 5);
    // HeyGen's own voices in the language, so a KOL without a cloned voice can still speak (preview before choosing).
    let stock: typeof mine = [];
    if (c.req.query('scope') === 'all') {
      try { stock = await pages('public', language || 'Vietnamese', 3); } catch { /* private voices still work */ }
    }
    return c.json({ configured: true, voices: [...mine, ...stock.filter((v) => !mine.some((m) => m.voiceId === v.voiceId))] });
  }));

  // ── Productions ──
  const createSchema = z.object({
    brief: z.string().trim().min(3).max(6000),
    cast: z.array(z.string().min(1).max(80)).max(6).default([]),
    aspect: z.enum(ASPECTS).default('9:16'),
    targetSec: z.number().int().min(5).max(180).default(45),
    title: z.string().trim().max(90).optional(),
    /** true (default): the Đạo diễn AI writes the storyboard and asks for approval. false: storyboard only. */
    agent: z.boolean().default(true),
    /** Legacy flag from the first UI: write with the KOL brain directly. */
    write: z.boolean().optional(),
  }).strict();

  const checkCast = (cast: string[]) => { for (const k of cast) if (!kol.persona(k)) throw new StoreError(404, 'Có KOL được gọi không còn tồn tại.'); };

  app.get(`${P}/productions`, guard((c) => c.json({ productions: service.list() })));

  app.post(`${P}/productions`, small, guard(async (c) => {
    const b = await body(c, createSchema);
    checkCast(b.cast);
    const created = service.create({ brief: b.brief, cast: b.cast, aspect: b.aspect, targetSec: b.targetSec, ...(b.title ? { title: b.title } : {}) });
    kit.pipeline.appendMessage(created.projectId!, { role: 'user', text: b.brief });
    if (b.agent && b.cast.length && agentTurns) {
      void startTurn(created.projectId!, b.brief);
      return c.json({ production: service.get(created.id), agent: true });
    }
    if (b.write !== false && b.cast.length && !agentTurns) {
      try { return c.json({ production: await service.write(created.id) }); }
      catch (err) { return c.json({ production: service.get(created.id), warning: err instanceof Error ? err.message : String(err) }); }
    }
    return c.json({ production: created });
  }));

  app.post(`${P}/productions/series`, small, guard(async (c) => {
    const b = await body(c, z.object({
      brief: z.string().trim().min(8).max(6000), cast: z.array(z.string().min(1).max(80)).min(1).max(6),
      count: z.number().int().min(2).max(10), aspect: z.enum(ASPECTS).default('9:16'), targetSec: z.number().int().min(5).max(180).default(45),
    }).strict());
    checkCast(b.cast);
    const lead = kol.persona(b.cast[0])!;
    const plan = await planSeries(b.brief, b.count, b.targetSec, lead, kit.writer);
    const seriesId = randomUUID();
    const made = plan.videos.map((v, i) => service.create({
      brief: `${v.brief}\n\n(Video ${i + 1}/${plan.videos.length} của series "${plan.title}". Góc: ${v.angle})`, cast: b.cast, aspect: b.aspect, targetSec: b.targetSec, title: v.title,
      series: { id: seriesId, index: i + 1, total: plan.videos.length, angle: v.angle },
    }));
    for (const m of made) kit.pipeline.appendMessage(m.projectId!, { role: 'user', text: m.brief });
    // One director at a time: each video gets its storyboard and its approval card in turn.
    if (agentTurns) {
      void (async () => { for (const m of made) { const done = startTurn(m.projectId!, m.brief); if (done) await done.catch(() => undefined); } })();
    }
    return c.json({ series: { id: seriesId, title: plan.title }, productions: made.map((m) => service.get(m.id)) });
  }));

  app.get(`${P}/productions/:id`, guard((c) => c.json({ production: service.ensureHost(id(c)) })));

  app.patch(`${P}/productions/:id`, small, guard(async (c) => {
    const b = await body(c, z.object({
      title: z.string().max(90).optional(), brief: z.string().max(6000).optional(), cast: z.array(z.string().min(1).max(80)).max(6).optional(),
      aspect: z.enum(ASPECTS).optional(), targetSec: z.number().int().min(5).max(180).optional(),
    }).strict());
    if (b.cast) checkCast(b.cast);
    return c.json({ production: await service.patch(id(c), b) });
  }));

  app.delete(`${P}/productions/:id`, guard(async (c) => { service.get(id(c)); await service.remove(id(c)); return c.json({ ok: true }); }));

  app.post(`${P}/productions/:id/write`, guard(async (c) => c.json({ production: await service.write(id(c)) })));

  const sceneFields = {
    kind: z.enum(['talking', 'broll', 'clip']),
    kolId: z.string().max(80).nullable(),
    text: z.string().max(2000),
    visual: z.string().max(1200),
    engine: z.enum(ENGINES),
    model: z.string().max(120).nullable(),
    sourceAssetId: z.string().max(80).nullable(),
    clipAssetId: z.string().max(80).nullable(),
    durationSec: z.number().min(1).max(120),
  };

  app.post(`${P}/productions/:id/scenes`, small, guard(async (c) => {
    const b = await body(c, z.object({ ...sceneFields, at: z.number().int().min(0).optional() }).partial({
      kolId: true, text: true, visual: true, engine: true, model: true, sourceAssetId: true, clipAssetId: true, durationSec: true,
    }).strict());
    const { at, ...scene } = b;
    return c.json({ production: await service.addScene(id(c), scene, at) });
  }));

  app.patch(`${P}/productions/:id/scenes/:sceneId`, small, guard(async (c) => {
    const b = await body(c, z.object(sceneFields).partial().strict());
    return c.json({ production: await service.patchScene(id(c), sid(c), b) });
  }));

  app.post(`${P}/productions/:id/scenes/:sceneId/trim`, small, guard(async (c) => {
    const b = await body(c, z.object({ start: z.number().min(0).max(3600).optional(), durationSec: z.number().min(0.5).max(600).optional() }).strict());
    return c.json({ production: await service.trimScene(id(c), sid(c), b) });
  }));

  app.post(`${P}/productions/:id/scenes/:sceneId/move`, small, guard(async (c) => {
    const b = await body(c, z.object({ to: z.number().int().min(0) }).strict());
    return c.json({ production: await service.moveScene(id(c), sid(c), b.to) });
  }));

  app.delete(`${P}/productions/:id/scenes/:sceneId`, guard(async (c) => c.json({ production: await service.removeScene(id(c), sid(c)) })));

  app.get(`${P}/productions/:id/estimate`, guard((c) => {
    const ids = (c.req.query('sceneIds') || '').split(',').map((s) => s.trim()).filter(Boolean);
    return c.json({ estimate: service.estimate(id(c), ids.length ? ids : undefined) });
  }));

  app.post(`${P}/productions/:id/generate`, small, guard(async (c) => {
    const b = await body(c, z.object({ sceneIds: z.array(z.string().uuid()).max(30).optional() }).strict().nullable().catch(null));
    const r = await service.requestGeneration(id(c), b?.sceneIds, 'owner');
    return c.json({ production: r.production, approvalId: r.approvalId, estimate: r.estimate });
  }));

  app.post(`${P}/productions/:id/stop-retries`, guard(async (c) => c.json({ production: await service.stopRetries(id(c)) })));

  app.post(`${P}/productions/:id/finish`, guard(async (c) => c.json({ production: await service.finish(id(c)) })));

  app.get(`${P}/productions/:id/events`, guard((c) => {
    const first = service.get(id(c));
    return streamSSE(c, async (stream) => {
      let closed = false;
      let queue: Promise<unknown> = Promise.resolve();
      const write = (data: string, event?: string) => {
        queue = queue.then(() => (closed ? undefined : stream.writeSSE({ data, ...(event ? { event } : {}) }))).catch(() => { closed = true; });
      };
      write(JSON.stringify({ type: 'production', production: first }));
      const unsubscribe = subscribeVideoEvents(first.id, (evt) => { if (evt.type === 'production') write(JSON.stringify(evt)); });
      const ping = setInterval(() => write('', 'ping'), SSE_PING_MS);
      await new Promise<void>((resolve) => stream.onAbort(() => { closed = true; clearInterval(ping); unsubscribe(); resolve(); }));
    });
  }));

  app.get(`${P}/productions/:id/scenes/:sceneId/:kind{video|thumb}`, guard((c) => {
    const p = service.get(id(c));
    const s = p.scenes.find((x) => x.id === sid(c));
    if (!s?.output) throw new StoreError(404, 'Cảnh chưa có video.');
    const name = c.req.param('kind') === 'thumb' ? s.output.thumb : s.output.file;
    if (!name) throw new StoreError(404, 'Cảnh chưa có ảnh thu nhỏ.');
    return serveFile(c, path.join(store.scenesDir(p.id), path.basename(name)));
  }));

  app.post(`${P}/projects/:id/publish`, small, guard(async (c) => {
    const b = await body(c, z.object({ personaId: z.string().max(80).optional(), version: z.number().int().min(1).optional() }).strict().nullable().catch(null));
    const r = await publishToKol({ editStore: kit.editStore, productions: store, emitProject: kit.emitProject, ...(kit.publish ?? {}) }, id(c), b ?? {});
    return c.json(r);
  }));

  // Background poll of running scenes (and resume after a restart).
  const pollMs = kit.pollMs ?? 8_000;
  let timer: NodeJS.Timeout | undefined;
  if (pollMs > 0) {
    let running = false;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      service.pollAll().finally(() => { running = false; });
    }, pollMs);
    timer.unref?.();
  }

  return Object.assign(service, { stopPolling: () => { if (timer) clearInterval(timer); timer = undefined; } });
}
