import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { createFalAdapter, FAL_MODELS, falOutputs, sizeFor } from './fal.js';
import { ProviderError, type ImageRequest, type VideoRequest } from './types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kol-fal-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
function png(name: string): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, PNG);
  return f;
}

const KEY = 'key-id:key-secret';
const model = (id: string) => FAL_MODELS.find((m) => m.id === id)!;

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(routes: [RegExp, (call: Call) => { status?: number; json?: unknown }][]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = init?.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep */ } }
    const call = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) throw new Error(`unexpected ${call.method} ${url}`);
    const r = route[1](call);
    return new Response(r.json === undefined ? '' : JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  return { fn, calls };
}

const imageReq = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  model: model('fal-ai/nano-banana-pro/edit'), prompt: 'Mia in Hoi An', refs: [{ path: png('a.png'), mime: 'image/png', role: 'identity', label: 'Mia — identity reference' }],
  aspect: '4:5', quality: 'high', count: 1, idempotencyKey: 'gen-1', ...over,
});

const queueRoutes = (app: string, result: () => { status?: number; json?: unknown }, statuses: string[] = ['IN_PROGRESS', 'COMPLETED']): [RegExp, (c: Call) => { status?: number; json?: unknown }][] => {
  let i = 0;
  return [
    [new RegExp(`^POST https://queue\\.fal\\.run/${app.replace(/\//g, '\\/')}`), () => ({
      json: { status: 'IN_QUEUE', request_id: 'r1', status_url: 'https://queue.fal.run/x/y/requests/r1/status', response_url: 'https://queue.fal.run/x/y/requests/r1' },
    })],
    [/^GET https:\/\/queue\.fal\.run\/x\/y\/requests\/r1\/status/, () => ({ status: 200, json: { status: statuses[Math.min(i++, statuses.length - 1)] } })],
    [/^GET https:\/\/queue\.fal\.run\/x\/y\/requests\/r1$/, result],
  ];
};

const uploadRoutes: [RegExp, (c: Call) => { status?: number; json?: unknown }][] = [
  [/^POST https:\/\/rest\.fal\.ai\/storage\/upload\/initiate/, () => ({ json: { upload_url: 'https://upload.storage.test/put/abc', file_url: 'https://v3b.fal.media/files/b/abc/a.png' } })],
  [/^PUT https:\/\/upload\.storage\.test\//, () => ({ status: 200 })],
];

describe('fal models', () => {
  it('lists image, video and lipsync models with prices and one recommendation per kind', () => {
    for (const kind of ['image', 'video', 'lipsync'] as const) {
      const ofKind = FAL_MODELS.filter((m) => m.kind === kind);
      expect(ofKind.length).toBeGreaterThan(0);
      expect(ofKind.filter((m) => m.recommended)).toHaveLength(1);
    }
    expect(FAL_MODELS.every((m) => m.provider === 'fal' && m.priceNote.startsWith('≈'))).toBe(true);
  });

  it('sizes Seedream images by aspect within 4096 px', () => {
    expect(sizeFor('1:1', 2048 * 2048)).toEqual({ width: 2048, height: 2048 });
    const v = sizeFor('9:16', 3584 * 3584);
    expect(Math.max(v.width, v.height)).toBeLessThanOrEqual(4096);
    expect(v.width % 16).toBe(0);
    expect(v.width / v.height).toBeCloseTo(9 / 16, 1);
  });

  it('reads media urls from several output shapes', () => {
    expect(falOutputs({ images: [{ url: 'https://a/1.png', content_type: 'image/png' }] }, 'image')).toEqual([{ url: 'https://a/1.png', mime: 'image/png' }]);
    expect(falOutputs({ image: { url: 'https://a/2.png' } }, 'image')).toEqual([{ url: 'https://a/2.png' }]);
    expect(falOutputs({ video: { url: 'https://a/v.mp4' } }, 'video')).toEqual([{ url: 'https://a/v.mp4' }]);
    expect(falOutputs({ output: { video: 'https://a/w.mp4' } }, 'video')).toEqual([{ url: 'https://a/w.mp4' }]);
    expect(falOutputs({}, 'image')).toEqual([]);
  });
});

describe('fal images', () => {
  it('uploads refs to the CDN, submits to the edit endpoint, polls and reads the result', async () => {
    const { fn, calls } = fakeFetch([
      ...uploadRoutes,
      ...queueRoutes('fal-ai/nano-banana-pro/edit', () => ({ json: { images: [{ url: 'https://v3b.fal.media/files/out.png', content_type: 'image/png' }] } })),
    ]);
    const a = createFalAdapter({ fetchImpl: fn as never, sleep: async () => {}, apiKey: () => KEY });
    const request = imageReq();
    const res = await a.generateImage(request);
    expect(res.outputs).toEqual([{ url: 'https://v3b.fal.media/files/out.png', mime: 'image/png' }]);

    const submit = calls.find((c) => c.method === 'POST' && c.url.startsWith('https://queue.fal.run/'))!;
    expect(submit.url).toBe('https://queue.fal.run/fal-ai/nano-banana-pro/edit');
    expect(submit.body).toMatchObject({ prompt: 'Mia in Hoi An', image_urls: ['https://v3b.fal.media/files/b/abc/a.png'], resolution: '2K', aspect_ratio: '4:5', num_images: 1 });
    expect(submit.headers.authorization).toBe(`Key ${KEY}`);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.headers.authorization).toBeUndefined();
    expect(put.headers['content-type']).toBe('image/png');
    expect(calls.filter((c) => c.url.endsWith('/status'))).toHaveLength(2);

    // The same (unchanged) file is not uploaded twice.
    await a.generateImage(request);
    expect(calls.filter((c) => c.url.includes('/storage/upload/initiate'))).toHaveLength(1);
  });

  it('uses the text-to-image twin when there is no reference (bootstrap)', async () => {
    const { fn, calls } = fakeFetch(queueRoutes('fal-ai/nano-banana-pro', () => ({ json: { images: [{ url: 'https://x/1.png' }, { url: 'https://x/2.png' }] } }), ['COMPLETED']));
    const a = createFalAdapter({ fetchImpl: fn as never, sleep: async () => {}, apiKey: () => KEY });
    const res = await a.generateImage(imageReq({ refs: [], count: 2, quality: 'standard' }));
    expect(res.outputs).toHaveLength(2);
    const submit = calls[0];
    expect(submit.url).toBe('https://queue.fal.run/fal-ai/nano-banana-pro');
    expect(submit.body).not.toHaveProperty('image_urls');
    expect(submit.body).toMatchObject({ num_images: 2, resolution: '1K' });
  });

  it('falls back to a data URI for small images when the upload endpoint is missing', async () => {
    const { fn, calls } = fakeFetch([
      [/^POST https:\/\/rest\.fal\.ai\/storage\/upload\/initiate/, () => ({ status: 404, json: { detail: 'Not Found' } })],
      ...queueRoutes('fal-ai/nano-banana-pro/edit', () => ({ json: { images: [{ url: 'https://x/1.png' }] } }), ['COMPLETED']),
    ]);
    const a = createFalAdapter({ fetchImpl: fn as never, sleep: async () => {}, apiKey: () => KEY });
    await a.generateImage(imageReq({ refs: [{ path: png('b.png'), mime: 'image/png', role: 'identity', label: 'x' }] }));
    const submit = calls.find((c) => c.url === 'https://queue.fal.run/fal-ai/nano-banana-pro/edit')!;
    expect((submit.body as { image_urls: string[] }).image_urls[0]).toMatch(/^data:image\/png;base64,/);
  });

  it('turns a failed result (422) into a rejected ProviderError and a missing key into auth', async () => {
    const { fn } = fakeFetch([...uploadRoutes, ...queueRoutes('fal-ai/nano-banana-pro/edit', () => ({ status: 422, json: { detail: [{ msg: 'image too small' }] } }), ['COMPLETED'])]);
    const a = createFalAdapter({ fetchImpl: fn as never, sleep: async () => {}, apiKey: () => KEY });
    await expect(a.generateImage(imageReq({ refs: [{ path: png('c.png'), mime: 'image/png', role: 'identity', label: 'x' }] }))).rejects.toMatchObject({ kind: 'rejected', status: 422 });
    const none = createFalAdapter({ fetchImpl: fn as never, apiKey: () => null });
    expect(none.configured()).toBe(false);
    await expect(none.generateImage(imageReq())).rejects.toBeInstanceOf(ProviderError);
  });

  it('flags NSFW results as safety', async () => {
    const { fn } = fakeFetch(queueRoutes('fal-ai/nano-banana-pro', () => ({ json: { images: [], has_nsfw_concepts: [true] } }), ['COMPLETED']));
    const a = createFalAdapter({ fetchImpl: fn as never, sleep: async () => {}, apiKey: () => KEY });
    await expect(a.generateImage(imageReq({ refs: [] }))).rejects.toMatchObject({ kind: 'safety' });
  });
});

describe('fal video', () => {
  const videoReq = (over: Partial<VideoRequest> = {}): VideoRequest => ({
    model: model('fal-ai/kling-video/v3/pro/image-to-video'), prompt: 'Mia smiles', startFrame: { path: png('s.png'), mime: 'image/png', role: 'source', label: 'start' },
    refs: [], audioFile: null, aspect: '9:16', quality: 'standard', durationSec: 5, audio: true, idempotencyKey: 'gen-v', ...over,
  });

  it('submits with the per-model field names and polls with the stored handle', async () => {
    let state = 'IN_QUEUE';
    let result: { status?: number; json?: unknown } = { json: { video: { url: 'https://v3b.fal.media/files/v.mp4', content_type: 'video/mp4' } } };
    const { fn, calls } = fakeFetch([
      ...uploadRoutes,
      [/^POST https:\/\/queue\.fal\.run\/fal-ai\/kling-video/, () => ({ json: { request_id: 'r9', status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/r9/status', response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/r9' } })],
      [/^GET https:\/\/queue\.fal\.run\/fal-ai\/kling-video\/requests\/r9\/status/, () => ({ json: { status: state } })],
      [/^GET https:\/\/queue\.fal\.run\/fal-ai\/kling-video\/requests\/r9$/, () => result],
    ]);
    const a = createFalAdapter({ fetchImpl: fn as never, sleep: async () => {}, apiKey: () => KEY });
    const { handle } = await a.submitVideo(videoReq());
    const submit = calls.find((c) => c.url === 'https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video')!;
    expect(submit.body).toMatchObject({ prompt: 'Mia smiles', start_image_url: 'https://v3b.fal.media/files/b/abc/a.png', duration: '5', generate_audio: true });
    expect(JSON.parse(handle)).toMatchObject({ r: 'r9' });

    expect(await a.pollVideo(handle, model('fal-ai/kling-video/v3/pro/image-to-video'))).toEqual({ state: 'pending' });
    state = 'COMPLETED';
    expect(await a.pollVideo(handle, model('fal-ai/kling-video/v3/pro/image-to-video'))).toEqual({ state: 'done', outputs: [{ url: 'https://v3b.fal.media/files/v.mp4', mime: 'video/mp4' }], reportedCostUsd: null });
    result = { status: 422, json: { detail: 'bad input' } };
    expect(await a.pollVideo(handle, model('fal-ai/kling-video/v3/pro/image-to-video'))).toMatchObject({ state: 'failed' });
    result = { status: 503, json: { detail: 'busy' } };
    await expect(a.pollVideo(handle, model('fal-ai/kling-video/v3/pro/image-to-video'))).rejects.toMatchObject({ kind: 'server' });
  });

  it('formats Veo durations as "6s" and sends lipsync audio', async () => {
    const { fn, calls } = fakeFetch([
      [/^POST https:\/\/rest\.fal\.ai\/storage\/upload\/initiate/, (c) => ({ json: { upload_url: 'https://upload.storage.test/put/1', file_url: `https://v3b.fal.media/files/${(c.body as { file_name: string }).file_name}` } })],
      [/^PUT https:\/\/upload\.storage\.test\//, () => ({ status: 200 })],
      [/^POST https:\/\/queue\.fal\.run\//, () => ({ json: { request_id: 'r1' } })],
    ]);
    const a = createFalAdapter({ fetchImpl: fn as never, sleep: async () => {}, apiKey: () => KEY });
    await a.submitVideo(videoReq({ model: model('fal-ai/veo3.1/fast/image-to-video'), durationSec: 6, quality: 'high' }));
    expect(calls.at(-1)!.body).toMatchObject({ image_url: expect.stringContaining('https://'), duration: '6s', resolution: '1080p', aspect_ratio: '9:16' });
    const mp3 = path.join(dir, 'speech.mp3');
    fs.writeFileSync(mp3, Buffer.from('ID3....'));
    const { handle } = await a.submitVideo(videoReq({ model: model('fal-ai/bytedance/omnihuman/v1.5'), audioFile: { path: mp3, mime: 'audio/mpeg', role: 'audio', label: 'speech' } }));
    expect(calls.at(-1)!.body).toMatchObject({ image_url: expect.any(String), audio_url: 'https://v3b.fal.media/files/speech.mp3', resolution: '720p' });
    // Fallback urls use owner/app only.
    expect(JSON.parse(handle)).toMatchObject({ s: 'https://queue.fal.run/fal-ai/bytedance/requests/r1/status', o: 'https://queue.fal.run/fal-ai/bytedance/requests/r1' });
    await expect(a.submitVideo(videoReq({ model: model('fal-ai/bytedance/omnihuman/v1.5') }))).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('never sends the key to a host outside fal', async () => {
    const { fn } = fakeFetch([]);
    const a = createFalAdapter({ fetchImpl: fn as never, apiKey: () => KEY });
    const evil = JSON.stringify({ r: 'r1', s: 'https://evil.example/status', o: 'https://evil.example/result' });
    expect(await a.pollVideo(evil, model('fal-ai/kling-video/v3/pro/image-to-video'))).toMatchObject({ state: 'failed' });
    expect(fn).not.toHaveBeenCalled();
  });
});
