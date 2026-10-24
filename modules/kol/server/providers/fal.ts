/**
 * fal.ai adapter over the queue API (https://queue.fal.run):
 *   submit POST /{endpoint} → { request_id, status_url, response_url }
 *   poll   GET status_url  → IN_QUEUE | IN_PROGRESS | COMPLETED
 *   result GET response_url → the raw model output (a non-200 here means the request failed)
 * Reference images and audio are uploaded to the fal CDN first
 * (POST rest.fal.ai/storage/upload/initiate → PUT), falling back to a data URI
 * for small images when that endpoint is unavailable.
 *
 * Key: Integrations › fal.ai (`api_key`), or the FAL_KEY connection secret.
 * Field names differ per model, so every model has its own input builder below.
 * Ids, fields and prices come from fal's per-model OpenAPI (researched 2026-10-20);
 * the text-to-image twins used for bootstrap (no refs) are UNVERIFIED ids.
 */

import fs from 'node:fs';
import path from 'node:path';

import { connectionSecret } from '../config.js';
import { loadIntegrationValues } from '../integration-values.js';
import { sendJson } from '../media-http.js';
import { priceNoteFor } from '../pricing.js';
import type { Aspect, ModelInfo, Quality } from '../types.js';
import {
  defaultFetch, defaultSleep, fileCacheKey, isAllowedHost, ProviderError, putBytes, UploadCache, wrapHttpError,
  type FetchLike, type ImageRequest, type ImageResponse, type InputFile, type MediaOut, type ProviderAdapter, type VideoPoll, type VideoRequest,
} from './types.js';

const QUEUE = 'https://queue.fal.run';
const UPLOAD_INITIATE = 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';
const FAL_HOSTS = ['fal.run', 'falrun.com', 'fal.ai'];
const IMAGE_TIMEOUT_MS = 6 * 60_000;
const DATA_URI_MAX = 4 * 1024 * 1024;

const ALL_ASPECTS: Aspect[] = ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9', '5:4', '4:3', '3:2'];

type Body = Record<string, unknown>;

interface ImageCtx { prompt: string; urls: string[]; aspect: Aspect; quality: Quality; count: number; seed?: number }
interface VideoCtx { prompt: string; image: string | null; refs: string[]; audio: string | null; aspect: Aspect; quality: Quality; durationSec: number; withAudio: boolean; seed?: number }

interface FalImageModel {
  info: Omit<ModelInfo, 'provider' | 'kind' | 'priceNote'>;
  /** Endpoint used when reference images are attached. */
  edit: string;
  /** Endpoint used with no reference image (bootstrap). */
  t2i: string;
  build(ctx: ImageCtx): Body;
}

interface FalVideoModel {
  info: Omit<ModelInfo, 'provider' | 'priceNote'> & { kind: 'video' | 'lipsync' };
  endpoint: string;
  build(ctx: VideoCtx): Body;
}

const seedOf = (seed?: number): Body => (seed !== undefined ? { seed } : {});

/** Width/height with the given aspect and pixel area, multiples of 16, longest side ≤ 4096. */
export function sizeFor(aspect: Aspect, area: number): { width: number; height: number } {
  const [a, b] = aspect.split(':').map(Number);
  const r = a / b;
  let w = Math.sqrt(area * r);
  let h = area / w;
  const longest = Math.max(w, h);
  if (longest > 4096) { w = (w * 4096) / longest; h = (h * 4096) / longest; }
  const r16 = (n: number) => Math.max(16, Math.floor(n / 16) * 16);
  return { width: r16(w), height: r16(h) };
}

const nanoBody = (resolutions: Partial<Record<Quality, string>> | null) => (ctx: ImageCtx): Body => ({
  prompt: ctx.prompt,
  num_images: ctx.count,
  aspect_ratio: ctx.aspect,
  output_format: 'png',
  ...(resolutions ? { resolution: resolutions[ctx.quality] ?? resolutions.standard } : {}),
  ...(ctx.urls.length ? { image_urls: ctx.urls } : {}),
  ...seedOf(ctx.seed),
});

/** The one place fal model ids live. */
const IMAGE_MODELS: FalImageModel[] = [
  {
    info: { id: 'fal-ai/nano-banana-pro/edit', label: 'Nano Banana Pro (fal)', maxRefs: 14, aspects: ALL_ASPECTS, qualities: ['standard', 'high', 'ultra'], recommended: true },
    edit: 'fal-ai/nano-banana-pro/edit', t2i: 'fal-ai/nano-banana-pro',
    build: nanoBody({ standard: '1K', high: '2K', ultra: '4K' }),
  },
  {
    info: { id: 'fal-ai/nano-banana-2/edit', label: 'Nano Banana 2 (fal)', maxRefs: 14, aspects: ALL_ASPECTS, qualities: ['draft', 'standard', 'high', 'ultra'] },
    edit: 'fal-ai/nano-banana-2/edit', t2i: 'fal-ai/nano-banana-2',
    build: nanoBody({ draft: '0.5K', standard: '1K', high: '2K', ultra: '4K' }),
  },
  {
    info: { id: 'fal-ai/bytedance/seedream/v4.5/edit', label: 'Seedream 4.5 (fal)', maxRefs: 10, aspects: ALL_ASPECTS, qualities: ['standard', 'ultra'] },
    edit: 'fal-ai/bytedance/seedream/v4.5/edit', t2i: 'fal-ai/bytedance/seedream/v4.5/text-to-image',
    build: (ctx) => ({
      prompt: ctx.prompt,
      image_size: sizeFor(ctx.aspect, ctx.quality === 'ultra' ? 3584 * 3584 : 2048 * 2048),
      num_images: ctx.count,
      max_images: 1,
      enable_safety_checker: true,
      ...(ctx.urls.length ? { image_urls: ctx.urls } : {}),
      ...seedOf(ctx.seed),
    }),
  },
  {
    info: { id: 'fal-ai/nano-banana/edit', label: 'Nano Banana (fal, rẻ)', maxRefs: 3, aspects: ALL_ASPECTS, qualities: ['standard'] },
    edit: 'fal-ai/nano-banana/edit', t2i: 'fal-ai/nano-banana',
    build: nanoBody(null),
  },
];

const res720 = (q: Quality) => (q === 'high' || q === 'ultra' ? '1080p' : '720p');

const VIDEO_MODELS: FalVideoModel[] = [
  {
    info: { id: 'fal-ai/kling-video/v3/pro/image-to-video', kind: 'video', label: 'Kling 3.0 Pro (fal)', maxRefs: 1, aspects: ALL_ASPECTS, qualities: ['standard'], durations: [5, 10, 15], audio: true, recommended: true },
    endpoint: 'fal-ai/kling-video/v3/pro/image-to-video',
    build: (c) => ({
      prompt: c.prompt, start_image_url: c.image, duration: String(c.durationSec), generate_audio: c.withAudio,
      negative_prompt: 'blur, distortion, low quality, face morphing, identity change, extra fingers',
    }),
  },
  {
    info: { id: 'fal-ai/veo3.1/fast/image-to-video', kind: 'video', label: 'Veo 3.1 Fast (fal)', maxRefs: 1, aspects: ['9:16', '16:9'], qualities: ['standard', 'high'], durations: [4, 6, 8], audio: true },
    endpoint: 'fal-ai/veo3.1/fast/image-to-video',
    build: (c) => ({
      prompt: c.prompt, image_url: c.image, duration: `${c.durationSec}s`,
      aspect_ratio: c.aspect === '16:9' || c.aspect === '9:16' ? c.aspect : 'auto', resolution: res720(c.quality), generate_audio: c.withAudio,
    }),
  },
  {
    info: { id: 'fal-ai/veo3.1/image-to-video', kind: 'video', label: 'Veo 3.1 (fal)', maxRefs: 1, aspects: ['9:16', '16:9'], qualities: ['standard', 'high'], durations: [4, 6, 8], audio: true },
    endpoint: 'fal-ai/veo3.1/image-to-video',
    build: (c) => ({
      prompt: c.prompt, image_url: c.image, duration: `${c.durationSec}s`,
      aspect_ratio: c.aspect === '16:9' || c.aspect === '9:16' ? c.aspect : 'auto', resolution: res720(c.quality), generate_audio: c.withAudio,
    }),
  },
  {
    info: { id: 'bytedance/seedance-2.0/image-to-video', kind: 'video', label: 'Seedance 2.0 (fal)', maxRefs: 1, aspects: ['16:9', '4:3', '1:1', '3:4', '9:16'], qualities: ['standard', 'high'], durations: [5, 10, 15], audio: true },
    endpoint: 'bytedance/seedance-2.0/image-to-video',
    build: (c) => ({
      prompt: c.prompt, image_url: c.image, duration: String(c.durationSec), aspect_ratio: 'auto',
      resolution: res720(c.quality), generate_audio: c.withAudio, ...seedOf(c.seed),
    }),
  },
  {
    info: { id: 'fal-ai/bytedance/omnihuman/v1.5', kind: 'lipsync', label: 'OmniHuman 1.5 (fal) — ảnh nói chuyện', maxRefs: 1, aspects: ALL_ASPECTS, qualities: ['standard', 'high'], recommended: true },
    endpoint: 'fal-ai/bytedance/omnihuman/v1.5',
    build: (c) => ({ image_url: c.image, audio_url: c.audio, prompt: c.prompt, resolution: res720(c.quality) }),
  },
  {
    info: { id: 'fal-ai/kling-video/ai-avatar/v2/pro', kind: 'lipsync', label: 'Kling AI Avatar 2 Pro (fal)', maxRefs: 1, aspects: ALL_ASPECTS, qualities: ['standard'] },
    endpoint: 'fal-ai/kling-video/ai-avatar/v2/pro',
    build: (c) => ({ image_url: c.image, audio_url: c.audio, prompt: c.prompt || '.' }),
  },
  {
    info: { id: 'veed/fabric-1.0', kind: 'lipsync', label: 'VEED Fabric 1.0 (fal)', maxRefs: 1, aspects: ALL_ASPECTS, qualities: ['draft', 'standard'] },
    endpoint: 'veed/fabric-1.0',
    build: (c) => ({ image_url: c.image, audio_url: c.audio, resolution: c.quality === 'draft' ? '480p' : '720p' }),
  },
];

export const FAL_MODELS: ModelInfo[] = [
  ...IMAGE_MODELS.map((m) => ({ ...m.info, provider: 'fal' as const, kind: 'image' as const, priceNote: priceNoteFor(m.info.id) })),
  ...VIDEO_MODELS.map((m) => ({ ...m.info, provider: 'fal' as const, priceNote: priceNoteFor(m.info.id) })),
];

// ── Adapter ──────────────────────────────────────────────────────────

export interface FalDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  apiKey?: () => string | null;
}

export function falKeyFromStore(): string | null {
  try {
    const v = loadIntegrationValues('fal')?.api_key?.trim();
    if (v) return v;
  } catch { /* store unreadable: fall through */ }
  return connectionSecret('FAL_KEY') || null;
}

interface QueueStatus { status?: string; request_id?: string; status_url?: string; response_url?: string; error?: unknown }

/** Pulls media urls out of a model output, tolerating the shapes fal models use. */
export function falOutputs(out: unknown, kind: 'image' | 'video'): MediaOut[] {
  const o = (out ?? {}) as Record<string, unknown>;
  const fromItem = (x: unknown): MediaOut | null => {
    if (typeof x === 'string' && /^(https:|data:)/.test(x)) return { url: x };
    if (x && typeof x === 'object') {
      const r = x as Record<string, unknown>;
      if (typeof r.url === 'string') return { url: r.url, ...(typeof r.content_type === 'string' ? { mime: r.content_type } : {}) };
    }
    return null;
  };
  const list: unknown[] = [];
  if (kind === 'image') {
    if (Array.isArray(o.images)) list.push(...o.images);
    if (o.image) list.push(o.image);
    const nested = o.output as Record<string, unknown> | undefined;
    if (nested && Array.isArray(nested.images)) list.push(...nested.images);
  } else {
    if (o.video) list.push(o.video);
    if (Array.isArray(o.videos)) list.push(...o.videos);
    const nested = o.output as Record<string, unknown> | undefined;
    if (nested?.video) list.push(nested.video);
  }
  return list.map(fromItem).filter((x): x is MediaOut => x !== null);
}

export function createFalAdapter(deps: FalDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const sleep = deps.sleep ?? defaultSleep;
  const apiKey = deps.apiKey ?? falKeyFromStore;
  const uploads = new UploadCache(6 * 3600_000);
  const http = { fetchImpl, sleepImpl: sleep };

  function key(): string {
    const k = apiKey();
    if (!k) throw new ProviderError('auth', 'fal: no API key');
    return k;
  }

  async function upload(file: InputFile, k: string): Promise<string> {
    const stat = fs.statSync(file.path);
    const cacheKey = fileCacheKey(file.path, stat);
    const hit = uploads.get(cacheKey);
    if (hit) return hit;
    const bytes = await fs.promises.readFile(file.path);
    try {
      const init = await sendJson<{ upload_url?: string; file_url?: string }>({
        service: 'fal', secret: k, method: 'POST', url: UPLOAD_INITIATE,
        headers: { Authorization: `Key ${k}` },
        json: { content_type: file.mime, file_name: path.basename(file.path) },
      }, http);
      if (!init.upload_url || !init.file_url) throw new ProviderError('unknown', 'fal: upload initiate returned no url');
      await putBytes(fetchImpl, init.upload_url, bytes, { 'Content-Type': file.mime }, 'fal');
      uploads.set(cacheKey, init.file_url);
      return init.file_url;
    } catch (err) {
      const e = wrapHttpError(err, 'fal');
      // Endpoint missing or changed: small images can travel as data URIs.
      if (file.mime.startsWith('image/') && bytes.length <= DATA_URI_MAX && e.kind !== 'auth' && e.kind !== 'quota') {
        return `data:${file.mime};base64,${bytes.toString('base64')}`;
      }
      throw e;
    }
  }

  async function submit(endpoint: string, body: Body, k: string): Promise<{ request_id: string; status_url: string; response_url: string }> {
    let res: QueueStatus;
    try {
      res = await sendJson<QueueStatus>({ service: 'fal', secret: k, method: 'POST', url: `${QUEUE}/${endpoint}`, headers: { Authorization: `Key ${k}` }, json: body }, http);
    } catch (err) {
      throw wrapHttpError(err, 'fal');
    }
    const id = res.request_id;
    if (!id) throw new ProviderError('unknown', 'fal: submit returned no request id');
    // Status/result urls use only owner/app; prefer the ones fal returns (checked to stay on fal hosts).
    const app = endpoint.split('/').slice(0, 2).join('/');
    const statusUrl = res.status_url && isAllowedHost(res.status_url, FAL_HOSTS) ? res.status_url : `${QUEUE}/${app}/requests/${id}/status`;
    const responseUrl = res.response_url && isAllowedHost(res.response_url, FAL_HOSTS) ? res.response_url : `${QUEUE}/${app}/requests/${id}`;
    return { request_id: id, status_url: statusUrl, response_url: responseUrl };
  }

  async function status(statusUrl: string, k: string): Promise<QueueStatus> {
    try {
      return await sendJson<QueueStatus>({ service: 'fal', secret: k, url: statusUrl, headers: { Authorization: `Key ${k}` } }, http);
    } catch (err) {
      throw wrapHttpError(err, 'fal');
    }
  }

  /** The model output, or a ProviderError when the request failed (a failed request still reaches COMPLETED). */
  async function result(responseUrl: string, k: string): Promise<unknown> {
    try {
      return await sendJson<unknown>({ service: 'fal', secret: k, url: responseUrl, headers: { Authorization: `Key ${k}` } }, { ...http, timeoutMs: 60_000 });
    } catch (err) {
      const e = wrapHttpError(err, 'fal');
      if (e.status === 499) throw new ProviderError('rejected', 'fal: request was cancelled', 499);
      if (e.status === 404) throw new ProviderError('rejected', 'fal: result expired or unknown request', 404);
      throw e;
    }
  }

  async function generateImage(req: ImageRequest): Promise<ImageResponse> {
    const spec = IMAGE_MODELS.find((m) => m.info.id === req.model.id);
    if (!spec) throw new ProviderError('unsupported', `fal: unknown image model ${req.model.id}`);
    const k = key();
    const urls: string[] = [];
    for (const ref of req.refs) urls.push(await upload(ref, k));
    const endpoint = urls.length ? spec.edit : spec.t2i;
    const body = spec.build({ prompt: req.prompt, urls, aspect: req.aspect, quality: req.quality, count: Math.max(1, Math.min(4, req.count)), seed: req.seed });
    const job = await submit(endpoint, body, k);
    const deadline = Date.now() + IMAGE_TIMEOUT_MS;
    let wait = 1500;
    for (;;) {
      if (req.signal?.aborted) throw new ProviderError('timeout', 'fal: cancelled');
      const s = await status(job.status_url, k);
      if (s.status === 'COMPLETED') break;
      if (Date.now() > deadline) throw new ProviderError('timeout', 'fal: image not ready after 6 minutes');
      await sleep(wait);
      wait = Math.min(5000, Math.round(wait * 1.4));
    }
    const out = await result(job.response_url, k);
    const outputs = falOutputs(out, 'image');
    if (outputs.length === 0) {
      const nsfw = (out as { has_nsfw_concepts?: unknown })?.has_nsfw_concepts;
      if (Array.isArray(nsfw) && nsfw.some(Boolean)) throw new ProviderError('safety', 'fal: output flagged as NSFW');
      throw new ProviderError('rejected', 'fal: result has no image');
    }
    return { outputs, reportedCostUsd: null };
  }

  async function submitVideo(req: VideoRequest): Promise<{ handle: string }> {
    const spec = VIDEO_MODELS.find((m) => m.info.id === req.model.id);
    if (!spec) throw new ProviderError('unsupported', `fal: unknown video model ${req.model.id}`);
    const k = key();
    const image = req.startFrame ? await upload(req.startFrame, k) : null;
    if (!image) throw new ProviderError('rejected', 'fal: a start image is required');
    const audio = req.audioFile ? await upload(req.audioFile, k) : null;
    if (spec.info.kind === 'lipsync' && !audio) throw new ProviderError('rejected', 'fal: lipsync needs an audio file');
    const refs: string[] = [];
    for (const r of req.refs) refs.push(await upload(r, k));
    const durations = spec.info.durations;
    const durationSec = durations && !durations.includes(req.durationSec) ? durations[0] : req.durationSec;
    const body = spec.build({ prompt: req.prompt, image, refs, audio, aspect: req.aspect, quality: req.quality, durationSec, withAudio: req.audio, seed: req.seed });
    const job = await submit(spec.endpoint, body, k);
    return { handle: JSON.stringify({ p: 'fal', r: job.request_id, s: job.status_url, o: job.response_url }) };
  }

  async function pollVideo(handle: string): Promise<VideoPoll> {
    let h: { r?: string; s?: string; o?: string };
    try { h = JSON.parse(handle) as typeof h; } catch { return { state: 'failed', error: 'fal: unreadable request handle' }; }
    if (!h.s || !h.o || !isAllowedHost(h.s, FAL_HOSTS) || !isAllowedHost(h.o, FAL_HOSTS)) return { state: 'failed', error: 'fal: invalid request handle' };
    const k = key();
    const s = await status(h.s, k);
    if (s.status !== 'COMPLETED') return { state: 'pending' };
    let out: unknown;
    try {
      out = await result(h.o, k);
    } catch (err) {
      const e = wrapHttpError(err, 'fal');
      if (e.kind === 'network' || e.kind === 'timeout' || e.kind === 'rate' || e.kind === 'server') throw e;
      return { state: 'failed', error: e.message };
    }
    const outputs = falOutputs(out, 'video');
    if (outputs.length === 0) return { state: 'failed', error: 'fal: result has no video' };
    return { state: 'done', outputs, reportedCostUsd: null };
  }

  return {
    id: 'fal',
    label: 'fal.ai',
    hint: 'Nhập API key fal.ai ở Integrations › fal.ai (AI tạo ảnh & video).',
    configured: () => Boolean(apiKey()),
    models: () => FAL_MODELS,
    generateImage,
    submitVideo,
    pollVideo,
  };
}

export const falAdapter: ProviderAdapter = createFalAdapter();
