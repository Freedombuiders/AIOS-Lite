/**
 * Higgsfield adapter (https://api.higgsfield.ai):
 *   submit POST /{endpoint} (+ Idempotency-Key) → { status, request_id, status_url }
 *   poll   GET /requests/{id}/status → queued | in_progress | completed | failed | nsfw | canceled,
 *          with the result inline (images[].url / video.url). Failed and nsfw requests are not charged.
 * Inputs must be public urls: refs go up through POST /files/generate-upload-url → PUT.
 * Auth: `Authorization: Key {key_id}:{key_secret}` from Integrations › Higgsfield.
 *
 * Higgsfield publishes no per-model prices, so these models have no built-in
 * price: the owner enters one in Settings (412 until then). There is no lipsync
 * endpoint in the current catalog. Soul ID (custom references) is future work.
 */

import fs from 'node:fs';

import { loadIntegrationValues } from '../integration-values.js';
import { sendJson } from '../media-http.js';
import { priceNoteFor } from '../pricing.js';
import type { Aspect, ModelInfo, Quality } from '../types.js';
import {
  defaultFetch, defaultSleep, fileCacheKey, isAllowedHost, ProviderError, putBytes, UploadCache, wrapHttpError,
  type FetchLike, type ImageRequest, type ImageResponse, type InputFile, type MediaOut, type ProviderAdapter, type VideoPoll, type VideoRequest,
} from './types.js';

const BASE = 'https://api.higgsfield.ai';
const HF_HOSTS = ['api.higgsfield.ai'];
const IMAGE_TIMEOUT_MS = 8 * 60_000;
/** Ids are prefixed so they never collide with fal ids of the same upstream model. */
export const HF_PREFIX = 'higgsfield/';

const ALL_ASPECTS: Aspect[] = ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9', '5:4', '4:3', '3:2'];
const HF_ASPECTS: Aspect[] = ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'];

type Body = Record<string, unknown>;

interface HfImageModel {
  info: Omit<ModelInfo, 'provider' | 'kind' | 'priceNote'>;
  endpoint: string;
  build(c: { prompt: string; urls: string[]; aspect: Aspect; quality: Quality; seed?: number }): Body;
}
interface HfVideoModel {
  info: Omit<ModelInfo, 'provider' | 'kind' | 'priceNote'>;
  endpoint: string;
  build(c: { prompt: string; image: string; aspect: Aspect; quality: Quality; durationSec: number; withAudio: boolean; seed?: number }): Body;
}

const FLARE_QUALITY: Record<Quality, { quality: string; resolution: string }> = {
  draft: { quality: 'medium', resolution: '1k' },
  standard: { quality: 'high', resolution: '2k' },
  high: { quality: 'xhigh', resolution: '2k' },
  ultra: { quality: 'max', resolution: '4k' },
};

/** The one place Higgsfield model ids live. */
const IMAGE_MODELS: HfImageModel[] = [
  {
    info: { id: `${HF_PREFIX}marketing-studio/image/flare`, label: 'Marketing Studio Image 2.5 Flare (Higgsfield)', maxRefs: 16, aspects: HF_ASPECTS, qualities: ['draft', 'standard', 'high', 'ultra'], recommended: true },
    endpoint: 'marketing-studio/image/flare',
    build: (c) => ({
      prompt: c.prompt.slice(0, 5000), ...FLARE_QUALITY[c.quality], aspect_ratio: c.aspect, enhance_prompt: false,
      ...(c.urls.length ? { image_urls: c.urls } : {}),
    }),
  },
  {
    info: { id: `${HF_PREFIX}xai/grok-imagine-image-2.0`, label: 'Grok Image 2.0 (Higgsfield)', maxRefs: 10, aspects: HF_ASPECTS, qualities: ['draft', 'standard', 'high'] },
    endpoint: 'xai/grok-imagine-image-2.0',
    build: (c) => ({
      prompt: c.prompt, quality: c.quality === 'draft' ? 'low' : 'medium', resolution: c.quality === 'high' ? '2k' : '1k', aspect_ratio: c.aspect,
      ...(c.urls.length ? { image_urls: c.urls } : {}),
    }),
  },
];

const VIDEO_MODELS: HfVideoModel[] = [
  {
    info: { id: `${HF_PREFIX}kling-video/v3.0/pro/image-to-video`, label: 'Kling 3.0 Pro (Higgsfield)', maxRefs: 1, aspects: ALL_ASPECTS, qualities: ['standard'], durations: [5, 10, 15], audio: true, recommended: true },
    endpoint: 'kling-video/v3.0/pro/image-to-video',
    build: (c) => ({ image_url: c.image, prompt: c.prompt, duration: c.durationSec, sound: c.withAudio ? 'on' : 'off' }),
  },
  {
    info: { id: `${HF_PREFIX}bytedance/seedance-2.0/image-to-video`, label: 'Seedance 2.0 (Higgsfield)', maxRefs: 1, aspects: ALL_ASPECTS, qualities: ['standard', 'high'], durations: [5, 10, 15], audio: true },
    endpoint: 'bytedance/seedance-2.0/image-to-video',
    build: (c) => ({
      image_url: c.image, prompt: c.prompt, duration: c.durationSec, resolution: c.quality === 'high' ? '1080p' : '720p',
      generate_audio: c.withAudio, ...(c.seed !== undefined ? { seed: c.seed } : {}),
    }),
  },
];

export const HIGGSFIELD_MODELS: ModelInfo[] = [
  ...IMAGE_MODELS.map((m) => ({ ...m.info, provider: 'higgsfield' as const, kind: 'image' as const, priceNote: priceNoteFor(m.info.id) })),
  ...VIDEO_MODELS.map((m) => ({ ...m.info, provider: 'higgsfield' as const, kind: 'video' as const, priceNote: priceNoteFor(m.info.id) })),
];

export interface HiggsfieldDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  credentials?: () => { keyId: string; keySecret: string } | null;
}

export function higgsfieldCredentialsFromStore(): { keyId: string; keySecret: string } | null {
  try {
    const v = loadIntegrationValues('higgsfield');
    const keyId = v?.key_id?.trim() ?? '';
    const keySecret = v?.key_secret?.trim() ?? '';
    return keyId && keySecret ? { keyId, keySecret } : null;
  } catch {
    return null;
  }
}

interface HfStatus {
  status?: string;
  request_id?: string;
  status_url?: string;
  error?: string | null;
  images?: { url?: string }[];
  video?: { url?: string };
}

const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled', 'cancelled']);

export function hfOutputs(s: HfStatus, kind: 'image' | 'video'): MediaOut[] {
  if (kind === 'image') return (s.images ?? []).map((i) => i?.url).filter((u): u is string => typeof u === 'string').map((url) => ({ url }));
  const url = s.video?.url;
  return typeof url === 'string' ? [{ url }] : [];
}

export function createHiggsfieldAdapter(deps: HiggsfieldDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const sleep = deps.sleep ?? defaultSleep;
  const credentials = deps.credentials ?? higgsfieldCredentialsFromStore;
  const uploads = new UploadCache(45 * 60_000);
  const http = { fetchImpl, sleepImpl: sleep };

  function auth(): { header: string; secret: string } {
    const c = credentials();
    if (!c) throw new ProviderError('auth', 'higgsfield: no API key');
    return { header: `Key ${c.keyId}:${c.keySecret}`, secret: c.keySecret };
  }

  async function upload(file: InputFile, a: { header: string; secret: string }): Promise<string> {
    const stat = fs.statSync(file.path);
    const cacheKey = fileCacheKey(file.path, stat);
    const hit = uploads.get(cacheKey);
    if (hit) return hit;
    try {
      const res = await sendJson<{ public_url?: string; upload_url?: string; upload_headers?: Record<string, string> }>({
        service: 'higgsfield', secret: a.secret, method: 'POST', url: `${BASE}/files/generate-upload-url`,
        headers: { Authorization: a.header }, json: { content_type: file.mime },
      }, http);
      if (!res.public_url || !res.upload_url) throw new ProviderError('unknown', 'higgsfield: upload url missing');
      const bytes = await fs.promises.readFile(file.path);
      await putBytes(fetchImpl, res.upload_url, bytes, res.upload_headers ?? { 'Content-Type': file.mime }, 'higgsfield');
      uploads.set(cacheKey, res.public_url);
      return res.public_url;
    } catch (err) {
      throw wrapHttpError(err, 'higgsfield');
    }
  }

  async function submit(endpoint: string, body: Body, idempotencyKey: string, a: { header: string; secret: string }): Promise<{ id: string; statusUrl: string }> {
    let res: HfStatus;
    try {
      res = await sendJson<HfStatus>({
        service: 'higgsfield', secret: a.secret, method: 'POST', url: `${BASE}/${endpoint}`,
        headers: { Authorization: a.header, 'Idempotency-Key': idempotencyKey.slice(0, 255) }, json: body,
      }, http);
    } catch (err) {
      throw wrapHttpError(err, 'higgsfield');
    }
    if (!res.request_id) throw new ProviderError('unknown', 'higgsfield: submit returned no request id');
    const statusUrl = res.status_url && isAllowedHost(res.status_url, HF_HOSTS) ? res.status_url : `${BASE}/requests/${encodeURIComponent(res.request_id)}/status`;
    return { id: res.request_id, statusUrl };
  }

  async function status(statusUrl: string, a: { header: string; secret: string }): Promise<HfStatus> {
    try {
      return await sendJson<HfStatus>({ service: 'higgsfield', secret: a.secret, url: statusUrl, headers: { Authorization: a.header } }, http);
    } catch (err) {
      throw wrapHttpError(err, 'higgsfield');
    }
  }

  function failure(s: HfStatus): ProviderError {
    if (s.status === 'nsfw') return new ProviderError('safety', 'higgsfield: blocked as NSFW');
    if (s.status === 'canceled' || s.status === 'cancelled') return new ProviderError('rejected', 'higgsfield: request was cancelled');
    return new ProviderError('rejected', `higgsfield: ${String(s.error ?? 'generation failed').slice(0, 200)}`);
  }

  async function generateImage(req: ImageRequest): Promise<ImageResponse> {
    const spec = IMAGE_MODELS.find((m) => m.info.id === req.model.id);
    if (!spec) throw new ProviderError('unsupported', `higgsfield: unknown image model ${req.model.id}`);
    const a = auth();
    const urls: string[] = [];
    for (const ref of req.refs) urls.push(await upload(ref, a));
    const body = spec.build({ prompt: req.prompt, urls, aspect: req.aspect, quality: req.quality, seed: req.seed });
    // One request per image (the edit models have no batch field). Each has its own idempotency key.
    const jobs: { id: string; statusUrl: string }[] = [];
    let submitError: ProviderError | null = null;
    for (let i = 0; i < Math.max(1, Math.min(4, req.count)); i++) {
      try {
        jobs.push(await submit(spec.endpoint, body, `${req.idempotencyKey}-${i}`, a));
      } catch (err) {
        submitError = wrapHttpError(err, 'higgsfield');
        break;
      }
    }
    if (jobs.length === 0) throw submitError ?? new ProviderError('unknown', 'higgsfield: nothing submitted');
    const outputs: MediaOut[] = [];
    let lastFailure: ProviderError | null = submitError;
    const deadline = Date.now() + IMAGE_TIMEOUT_MS;
    for (const job of jobs) {
      let wait = 2000;
      for (;;) {
        const s = await status(job.statusUrl, a);
        if (s.status && TERMINAL.has(s.status)) {
          if (s.status === 'completed') outputs.push(...hfOutputs(s, 'image'));
          else lastFailure = failure(s);
          break;
        }
        if (Date.now() > deadline) { lastFailure = new ProviderError('timeout', 'higgsfield: image not ready after 8 minutes'); break; }
        await sleep(wait + Math.floor(Math.random() * 300));
        wait = Math.min(10_000, Math.round(wait * 1.5));
      }
    }
    if (outputs.length === 0) throw lastFailure ?? new ProviderError('rejected', 'higgsfield: no image returned');
    return { outputs, reportedCostUsd: null };
  }

  async function submitVideo(req: VideoRequest): Promise<{ handle: string }> {
    const spec = VIDEO_MODELS.find((m) => m.info.id === req.model.id);
    if (!spec) throw new ProviderError('unsupported', `higgsfield: unknown video model ${req.model.id}`);
    if (!req.startFrame) throw new ProviderError('rejected', 'higgsfield: a start image is required');
    const a = auth();
    const image = await upload(req.startFrame, a);
    const durations = spec.info.durations ?? [5];
    const durationSec = durations.includes(req.durationSec) ? req.durationSec : durations[0];
    const body = spec.build({ prompt: req.prompt, image, aspect: req.aspect, quality: req.quality, durationSec, withAudio: req.audio, seed: req.seed });
    const job = await submit(spec.endpoint, body, req.idempotencyKey, a);
    return { handle: JSON.stringify({ p: 'higgsfield', r: job.id, s: job.statusUrl }) };
  }

  async function pollVideo(handle: string): Promise<VideoPoll> {
    let h: { r?: string; s?: string };
    try { h = JSON.parse(handle) as typeof h; } catch { return { state: 'failed', error: 'higgsfield: unreadable request handle' }; }
    const statusUrl = h.s && isAllowedHost(h.s, HF_HOSTS) ? h.s : h.r ? `${BASE}/requests/${encodeURIComponent(h.r)}/status` : null;
    if (!statusUrl) return { state: 'failed', error: 'higgsfield: invalid request handle' };
    const a = auth();
    const s = await status(statusUrl, a);
    if (!s.status || !TERMINAL.has(s.status)) return { state: 'pending' };
    if (s.status !== 'completed') return { state: 'failed', error: failure(s).message };
    const outputs = hfOutputs(s, 'video');
    if (outputs.length === 0) return { state: 'failed', error: 'higgsfield: result has no video' };
    return { state: 'done', outputs, reportedCostUsd: null };
  }

  return {
    id: 'higgsfield',
    label: 'Higgsfield',
    hint: 'Nhập Key ID và Key Secret của Higgsfield ở Integrations › Higgsfield (AI tạo ảnh & video).',
    configured: () => credentials() !== null,
    models: () => HIGGSFIELD_MODELS,
    generateImage,
    submitVideo,
    pollVideo,
  };
}

export const higgsfieldAdapter: ProviderAdapter = createHiggsfieldAdapter();
