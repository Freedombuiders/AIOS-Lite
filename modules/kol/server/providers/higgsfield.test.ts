import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createHiggsfieldAdapter, HIGGSFIELD_MODELS, hfOutputs } from './higgsfield.js';
import type { ImageRequest, VideoRequest } from './types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kol-hf-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const file = path.join(dir, 'face.png');
fs.writeFileSync(file, PNG);

const creds = () => ({ keyId: 'kid', keySecret: 'ksecret' });
const model = (id: string) => HIGGSFIELD_MODELS.find((m) => m.id === id)!;

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(handler: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = init?.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep */ } }
    const call = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const r = handler(call);
    return new Response(r.json === undefined ? '' : JSON.stringify(r.json), { status: r.status ?? 200 });
  });
  return { fn, calls };
}

function uploads(c: Call): { status?: number; json?: unknown } | null {
  if (c.method === 'POST' && c.url === 'https://api.higgsfield.ai/files/generate-upload-url') {
    return { json: { public_url: 'https://cdn.higgsfield.test/input/face.png', upload_url: 'https://storage.test/presigned', upload_headers: { 'Content-Type': 'image/png', 'x-amz-tagging': 'retention=temporary' } } };
  }
  if (c.method === 'PUT') return { status: 200 };
  return null;
}

const imageReq = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  model: model('higgsfield/marketing-studio/image/flare'), prompt: 'Mia at a rooftop bar', refs: [{ path: file, mime: 'image/png', role: 'identity', label: 'Mia' }],
  aspect: '3:4', quality: 'high', count: 2, idempotencyKey: 'gen-7', ...over,
});

describe('higgsfield models', () => {
  it('are prefixed, have no built-in price and no lipsync', () => {
    expect(HIGGSFIELD_MODELS.every((m) => m.id.startsWith('higgsfield/') && m.provider === 'higgsfield')).toBe(true);
    expect(HIGGSFIELD_MODELS.every((m) => m.priceNote.includes('Chưa có giá'))).toBe(true);
    expect(HIGGSFIELD_MODELS.some((m) => m.kind === 'lipsync')).toBe(false);
  });

  it('reads inline results', () => {
    expect(hfOutputs({ status: 'completed', images: [{ url: 'https://a/1.jpg' }, {}] }, 'image')).toEqual([{ url: 'https://a/1.jpg' }]);
    expect(hfOutputs({ status: 'completed', video: { url: 'https://a/v.mp4' } }, 'video')).toEqual([{ url: 'https://a/v.mp4' }]);
  });
});

describe('higgsfield images', () => {
  it('uploads refs, submits one request per image with idempotency keys and reads inline results', async () => {
    let n = 0;
    const { fn, calls } = fakeFetch((c) => {
      const up = uploads(c);
      if (up) return up;
      if (c.method === 'POST' && c.url === 'https://api.higgsfield.ai/marketing-studio/image/flare') {
        n += 1;
        return { json: { status: 'queued', request_id: `req-${n}`, status_url: `https://api.higgsfield.ai/requests/req-${n}/status` } };
      }
      if (c.method === 'GET' && /\/requests\/req-\d\/status$/.test(c.url)) {
        return { json: { status: 'completed', request_id: 'x', images: [{ url: `https://cdn.higgsfield.test/out-${c.url.match(/req-(\d)/)![1]}.jpg` }] } };
      }
      return { status: 404, json: { detail: 'unexpected' } };
    });
    const a = createHiggsfieldAdapter({ fetchImpl: fn as never, sleep: async () => {}, credentials: creds });
    const res = await a.generateImage(imageReq());
    expect(res.outputs).toEqual([{ url: 'https://cdn.higgsfield.test/out-1.jpg' }, { url: 'https://cdn.higgsfield.test/out-2.jpg' }]);
    const submits = calls.filter((c) => c.url.endsWith('/marketing-studio/image/flare'));
    expect(submits.map((c) => c.headers['idempotency-key'])).toEqual(['gen-7-0', 'gen-7-1']);
    expect(submits[0].headers.authorization).toBe('Key kid:ksecret');
    expect(submits[0].body).toMatchObject({ prompt: 'Mia at a rooftop bar', image_urls: ['https://cdn.higgsfield.test/input/face.png'], quality: 'xhigh', resolution: '2k', aspect_ratio: '3:4' });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.headers['x-amz-tagging']).toBe('retention=temporary');
    expect(put.headers.authorization).toBeUndefined();
  });

  it('reports nsfw as a safety failure and a concurrency 400 as rate limiting', async () => {
    const nsfw = fakeFetch((c) => uploads(c) ?? (c.method === 'POST' ? { json: { request_id: 'r1' } } : { json: { status: 'nsfw', request_id: 'r1' } }));
    const a = createHiggsfieldAdapter({ fetchImpl: nsfw.fn as never, sleep: async () => {}, credentials: creds });
    await expect(a.generateImage(imageReq({ count: 1 }))).rejects.toMatchObject({ kind: 'safety' });
    // The fallback status url is built from the request id.
    expect(nsfw.calls.some((c) => c.url === 'https://api.higgsfield.ai/requests/r1/status')).toBe(true);

    const busy = fakeFetch((c) => uploads(c) ?? { status: 400, json: { detail: 'Maximum number of concurrent requests (4) has been reached' } });
    const b = createHiggsfieldAdapter({ fetchImpl: busy.fn as never, sleep: async () => {}, credentials: creds });
    await expect(b.generateImage(imageReq({ count: 1 }))).rejects.toMatchObject({ kind: 'rate' });
  });

  it('needs both credentials', async () => {
    const a = createHiggsfieldAdapter({ credentials: () => null });
    expect(a.configured()).toBe(false);
    await expect(a.generateImage(imageReq())).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('higgsfield video', () => {
  const videoReq: VideoRequest = {
    model: model('higgsfield/kling-video/v3.0/pro/image-to-video'), prompt: 'Mia waves', startFrame: { path: file, mime: 'image/png', role: 'source', label: 'start' },
    refs: [], audioFile: null, aspect: '9:16', quality: 'standard', durationSec: 10, audio: false, idempotencyKey: 'gen-v',
  };

  it('submits integer durations and the sound flag, then polls to completion', async () => {
    let status: Record<string, unknown> = { status: 'in_progress', request_id: 'v1' };
    const { fn, calls } = fakeFetch((c) => uploads(c) ?? (c.method === 'POST'
      ? { json: { request_id: 'v1', status_url: 'https://evil.example/status' } }
      : { json: status }));
    const a = createHiggsfieldAdapter({ fetchImpl: fn as never, sleep: async () => {}, credentials: creds });
    const { handle } = await a.submitVideo(videoReq);
    const submit = calls.find((c) => c.url === 'https://api.higgsfield.ai/kling-video/v3.0/pro/image-to-video')!;
    expect(submit.body).toMatchObject({ image_url: 'https://cdn.higgsfield.test/input/face.png', prompt: 'Mia waves', duration: 10, sound: 'off' });
    expect(submit.headers['idempotency-key']).toBe('gen-v');
    // A status url on a foreign host is never used.
    expect(JSON.parse(handle).s).toBe('https://api.higgsfield.ai/requests/v1/status');
    expect(await a.pollVideo(handle, videoReq.model)).toEqual({ state: 'pending' });
    status = { status: 'completed', request_id: 'v1', video: { url: 'https://cdn.higgsfield.test/v.mp4' } };
    expect(await a.pollVideo(handle, videoReq.model)).toEqual({ state: 'done', outputs: [{ url: 'https://cdn.higgsfield.test/v.mp4' }], reportedCostUsd: null });
    status = { status: 'failed', request_id: 'v1', error: 'Generation failed' };
    expect(await a.pollVideo(handle, videoReq.model)).toEqual({ state: 'failed', error: 'higgsfield: Generation failed' });
    expect(calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
  });
});
