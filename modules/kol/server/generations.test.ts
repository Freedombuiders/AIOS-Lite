import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  process.env.VIDEO_EDIT_FFMPEG = '/nonexistent/ffmpeg-for-tests';
  process.env.VIDEO_EDIT_FFPROBE = '/nonexistent/ffprobe-for-tests';
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kol-generations-')) };
});
vi.mock('./config.js', async (orig) => ({ ...(await orig<typeof import('./config.js')>()), STORE_DIR: store.dir, GOOGLE_API_KEY: '' }));

import fs from 'fs';
import path from 'path';

import { _initTestDatabase } from './test-db.js';
import { _reset as resetKillSwitches } from './compat.js';
import { getAsset, getAssetFile } from './assets.js';
import { _setJudgeForTests } from './consistency.js';
import { kolDir, KolError, kolDb, monthKey, nowSec, saveSettings } from './core.js';
import {
  _clearRetryDelaysForTests, _resetWorkerForTests, _runWorkerOnceForTests, _setDownloaderForTests, cancelGeneration, getGeneration, listGenerations, listGenerationsForPost, previewGeneration,
  queueCounts, recoverInterruptedGenerations, requestGeneration, UNKNOWN_NOTE,
} from './generations.js';
import { archivePersona, createPersona, updatePersona } from './personas.js';
import { _setProviderAdapterForTests } from './providers/index.js';
import { ProviderError, type ImageRequest, type ProviderAdapter, type VideoPoll, type VideoRequest } from './providers/types.js';
import { addRefFromUpload, listRefs } from './refs.js';
import { createTemplate } from './templates.js';
import type { GenerationRequest, ModelInfo, ProviderId } from './types.js';
import { _setSpeechForTests } from './voice.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
const ALL = ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9', '5:4', '4:3', '3:2'] as ModelInfo['aspects'];

const IMAGE: ModelInfo = { id: 'gemini-3-pro-image', provider: 'gemini', kind: 'image', label: 'Nano Banana Pro', maxRefs: 14, aspects: ALL, qualities: ['standard', 'high', 'ultra'], priceNote: '', recommended: true };
const VIDEO: ModelInfo = { id: 'veo-3.1-fast-generate-preview', provider: 'gemini', kind: 'video', label: 'Veo 3.1 Fast', maxRefs: 1, aspects: ['9:16', '16:9'], qualities: ['standard', 'high'], durations: [4, 6, 8], audio: true, priceNote: '', recommended: true };
const LIPSYNC: ModelInfo = { id: 'fal-ai/bytedance/omnihuman/v1.5', provider: 'fal', kind: 'lipsync', label: 'OmniHuman', maxRefs: 1, aspects: ALL, qualities: ['standard', 'high'], priceNote: '', recommended: true };
const CHAT_IMAGE: ModelInfo = { id: 'chatgpt-image', provider: 'chatgpt', kind: 'image', label: 'ChatGPT Images', maxRefs: 8, aspects: ALL, qualities: ['standard', 'high'], priceNote: '' };
const HF_IMAGE: ModelInfo = { id: 'higgsfield/marketing-studio/image/flare', provider: 'higgsfield', kind: 'image', label: 'Flare', maxRefs: 16, aspects: ALL, qualities: ['standard'], priceNote: '' };

let generateImage: ReturnType<typeof vi.fn<(req: ImageRequest) => Promise<{ outputs: { bytes: Buffer; mime: string }[] }>>>;
let submitVideo: ReturnType<typeof vi.fn<(req: VideoRequest) => Promise<{ handle: string }>>>;
let pollVideo: ReturnType<typeof vi.fn<(handle: string) => Promise<VideoPoll>>>;
let judge: ReturnType<typeof vi.fn>;

function adapter(id: ProviderId, models: ModelInfo[], configured = true): ProviderAdapter {
  return {
    id, label: id === 'gemini' ? 'Google Gemini' : id, hint: `Cấu hình ${id}.`, configured: () => configured, models: () => models,
    generateImage: (req) => generateImage(req), submitVideo: (req) => submitVideo(req), pollVideo: (h) => pollVideo(h),
  };
}

function tempPng(): string {
  const f = path.join(fs.mkdtempSync(path.join(store.dir, 'up-')), 'x.png');
  fs.writeFileSync(f, PNG);
  return f;
}

async function personaWithAnchor(name = 'Mia'): Promise<string> {
  const p = createPersona({ name, appearance: { gender: 'female', ethnicity: 'Vietnamese', face: 'oval face' } as never, voiceId: 'voice-1' });
  await addRefFromUpload(p.id, tempPng(), { kind: 'anchor' });
  return p.id;
}

function statusOf(fn: () => unknown): { status: number; message: string; code?: string } {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(KolError);
    return { status: (err as KolError).status, message: (err as KolError).message, code: (err as KolError).code };
  }
  return { status: 200, message: '' };
}

const req = (personaId: string, over: Partial<GenerationRequest> = {}): GenerationRequest => ({ personaId, mode: 'compose', ...over });

function spendRows(): { kind: string; cost_usd: number; provider: string; generation_id: string | null }[] {
  return kolDb().prepare('SELECT kind, cost_usd, provider, generation_id FROM kol_spend ORDER BY id').all() as never;
}

beforeEach(() => {
  _initTestDatabase();
  _resetWorkerForTests();
  generateImage = vi.fn(async (r: ImageRequest) => ({ outputs: Array.from({ length: r.count }, () => ({ bytes: PNG, mime: 'image/png' })) }));
  submitVideo = vi.fn(async () => ({ handle: 'op-1' }));
  pollVideo = vi.fn(async (): Promise<VideoPoll> => ({ state: 'done', outputs: [{ bytes: MP4, mime: 'video/mp4' }] }));
  judge = vi.fn(async () => ({ score: 90, samePerson: true, issues: [], inputTokens: 2000, outputTokens: 50 }));
  _setProviderAdapterForTests('gemini', adapter('gemini', [IMAGE, VIDEO]));
  _setProviderAdapterForTests('fal', adapter('fal', [LIPSYNC]));
  _setProviderAdapterForTests('higgsfield', adapter('higgsfield', [HF_IMAGE]));
  _setJudgeForTests(judge as never);
  _setSpeechForTests(async () => MP3);
  saveSettings({ dailyCapUsd: 50, monthlyCapUsd: 500, concurrency: 2 });
});

afterEach(() => {
  _setJudgeForTests(null);
  _setSpeechForTests(null);
  for (const id of ['gemini', 'chatgpt', 'fal', 'higgsfield'] as ProviderId[]) _setProviderAdapterForTests(id, null);
  delete process.env.KOL_GENERATE_ENABLED;
  resetKillSwitches();
});

afterAll(() => fs.rmSync(store.dir, { recursive: true, force: true }));

describe('requestGeneration', () => {
  it('queues a priced compose job with the composed prompt and its image roles', async () => {
    const pid = await personaWithAnchor();
    const g = requestGeneration(req(pid, { selection: { outfitId: 'b-outfit-ao-dai-white', expressionId: 'b-expr-wink' }, params: { aspect: '4:5' }, postId: 'post-1' }), 'owner');
    expect(g).toMatchObject({ status: 'queued', kind: 'image', mode: 'compose', provider: 'gemini', model: 'gemini-3-pro-image', postId: 'post-1', requestedBy: 'owner' });
    expect(g.params).toMatchObject({ model: 'gemini-3-pro-image', aspect: '4:5', quality: 'standard', count: 1 });
    expect(g.refs.map((r) => r.role)).toEqual(['identity']);
    expect(g.prompt).toContain('REPLACE her clothing completely with a traditional white Vietnamese áo dài');
    expect(g.prompt).toContain('Expression: winking one eye');
    expect(g.estimateUsd).toBeCloseTo(0.134 + 0.0011 + 0.002, 6);
    expect(queueCounts()).toEqual({ running: 0, queued: 1 });
    expect(listGenerationsForPost('post-1').map((x) => x.id)).toEqual([g.id]);
  });

  it('answers 404 / 400 / 409 / 412 / 402 with Vietnamese reasons', async () => {
    const pid = await personaWithAnchor();
    expect(statusOf(() => requestGeneration(req('missing'), 'owner')).status).toBe(404);
    expect(statusOf(() => requestGeneration({ personaId: pid, mode: 'paint' } as never, 'owner')).status).toBe(400);

    const bare = createPersona({ name: 'Lan' }).id;
    expect(statusOf(() => requestGeneration(req(bare), 'owner'))).toMatchObject({ status: 400, code: 'no_anchor' });
    expect(statusOf(() => requestGeneration(req(pid, { mode: 'recreate' }), 'owner')).message).toContain('ảnh mẫu');
    expect(statusOf(() => requestGeneration(req(pid, { params: { quality: 'draft' } }), 'owner')).status).toBe(400);
    expect(statusOf(() => requestGeneration(req(pid, { params: { model: 'nope' } }), 'owner')).status).toBe(400);
    expect(statusOf(() => requestGeneration(req(pid, { params: { model: 'veo-3.1-fast-generate-preview' } }), 'owner')).status).toBe(400);
    expect(statusOf(() => requestGeneration(req(pid, { selection: { outfitId: 'b-expr-wink' } }), 'owner')).status).toBe(400);

    // No price for Higgsfield until the owner enters one.
    expect(statusOf(() => requestGeneration(req(pid, { params: { model: HF_IMAGE.id } }), 'owner'))).toMatchObject({ status: 412, code: 'no_price' });
    saveSettings({ priceOverrides: { [HF_IMAGE.id]: 0.09 } });
    expect(requestGeneration(req(pid, { params: { model: HF_IMAGE.id } }), 'owner').estimateUsd).toBeCloseTo(0.09 + 0.002, 6);

    // Provider without a key.
    _setProviderAdapterForTests('gemini', adapter('gemini', [IMAGE, VIDEO], false));
    expect(statusOf(() => requestGeneration(req(pid, { params: { model: IMAGE.id } }), 'owner'))).toMatchObject({ status: 412, code: 'provider_not_configured' });
    // With no model named, the default falls back to a configured provider.
    expect(requestGeneration(req(pid), 'owner').provider).toBe('higgsfield');
    _setProviderAdapterForTests('gemini', adapter('gemini', [IMAGE, VIDEO]));

    saveSettings({ dailyCapUsd: 0.05 });
    expect(statusOf(() => requestGeneration(req(pid), 'owner'))).toMatchObject({ status: 402, code: 'daily_cap' });
    saveSettings({ dailyCapUsd: 50, enabled: false });
    expect(statusOf(() => requestGeneration(req(pid), 'owner'))).toMatchObject({ status: 409, code: 'disabled' });
    saveSettings({ enabled: true });
    process.env.KOL_GENERATE_ENABLED = 'off';
    resetKillSwitches();
    expect(statusOf(() => requestGeneration(req(pid), 'owner'))).toMatchObject({ status: 409, code: 'kill_switch' });
    delete process.env.KOL_GENERATE_ENABLED;
    resetKillSwitches();
    archivePersona(pid);
    expect(statusOf(() => requestGeneration(req(pid), 'owner')).status).toBe(409);
  });

  it('previews without spending and turns blocking problems into warnings', async () => {
    const bare = createPersona({ name: 'Lan' }).id;
    const p = previewGeneration(req(bare, { params: { aspect: '9:16' } }));
    expect(p.model?.id).toBe('gemini-3-pro-image');
    expect(p.estimateUsd).toBeGreaterThan(0);
    expect(p.warnings.join(' | ')).toContain('Chưa có ảnh gốc');
    expect(p.warnings.join(' | ')).toContain('feed Instagram');
    expect(p.prompt).toContain('IDENTITY LOCK');
    expect(listGenerations()).toEqual([]);
    expect(spendRows()).toEqual([]);
  });

  it('combines a camera setup (cameraId + cameraIds) into one Camera line', async () => {
    const pid = await personaWithAnchor();
    const p = previewGeneration(req(pid, { selection: { cameraId: 'b-camera-50mm', cameraIds: ['b-camera-shot-full', 'b-camera-low-angle'] } }));
    expect(p.prompt).toContain('- Camera: 50mm f/1.8 lens: natural perspective close to human vision, gentle background blur; full-body shot, head to toe in frame');
    expect(p.prompt).toContain('; low-angle shot looking up at the subject, empowering perspective.');
    expect(statusOf(() => previewGeneration(req(pid, { selection: { cameraIds: Array(6).fill('b-camera-50mm') } }))).status).toBe(400);
  });

  it('cancels only queued jobs', async () => {
    const pid = await personaWithAnchor();
    const g = requestGeneration(req(pid), 'owner');
    expect(cancelGeneration(g.id).status).toBe('cancelled');
    expect(statusOf(() => cancelGeneration(g.id)).status).toBe(409);
    expect(statusOf(() => cancelGeneration('nope')).status).toBe(404);
  });
});

describe('worker — images', () => {
  it('runs a compose job: provider call, files, spend, identity QA', async () => {
    const pid = await personaWithAnchor();
    const g = requestGeneration(req(pid, { params: { aspect: '4:5', seed: 7 } }), 'agent:main');
    await _runWorkerOnceForTests();
    const done = getGeneration(g.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.startedAt).not.toBeNull();
    expect(done.assetIds).toHaveLength(1);

    const call = generateImage.mock.calls[0][0];
    expect(call).toMatchObject({ aspect: '4:5', quality: 'standard', count: 1, seed: 7, idempotencyKey: g.id, prompt: g.prompt });
    expect(call.refs).toHaveLength(1);
    expect(call.refs[0]).toMatchObject({ role: 'identity', mime: 'image/png' });
    expect(call.refs[0].label).toContain('Mia');
    expect(fs.existsSync(call.refs[0].path)).toBe(true);

    const asset = getAsset(done.assetIds[0])!;
    expect(asset).toMatchObject({ kind: 'image', mime: 'image/png', width: 1, height: 1, model: 'gemini-3-pro-image', provider: 'gemini', status: 'new', thumbUrl: null });
    expect(asset.consistency).toMatchObject({ score: 90, verdict: 'pass' });
    const file = getAssetFile(asset.id)!.abs;
    expect(file).toBe(path.join(kolDir(), 'assets', pid, monthKey(), `${asset.id}.png`));

    const rows = spendRows();
    expect(rows.map((r) => r.kind)).toEqual(['image', 'judge']);
    expect(rows[0].cost_usd).toBeCloseTo(0.134 + 0.0011, 6);
    expect(rows.every((r) => r.generation_id === g.id)).toBe(true);
    expect(done.costUsd).toBeCloseTo(rows.reduce((s, r) => s + r.cost_usd, 0), 6);
    expect(asset.costUsd).toBeCloseTo(0.1351, 6);
  });

  it('bootstrap makes 4 candidates by default and does not judge them', async () => {
    const p = createPersona({ name: 'Mia', appearance: { gender: 'female', face: 'oval' } as never });
    const g = requestGeneration(req(p.id, { mode: 'bootstrap' }), 'owner');
    expect(g.params.count).toBe(4);
    expect(g.refs).toEqual([]);
    await _runWorkerOnceForTests();
    const done = getGeneration(g.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.assetIds).toHaveLength(4);
    expect(judge).not.toHaveBeenCalled();
    expect(getAsset(done.assetIds[0])!.consistency.verdict).toBe('skipped');
    expect(spendRows().map((r) => r.kind)).toEqual(['image']);
    expect(spendRows()[0].cost_usd).toBeCloseTo(4 * 0.134, 6);
  });

  it('sheet adds the result to the identity pack as a generated sheet', async () => {
    const pid = await personaWithAnchor();
    const g = requestGeneration(req(pid, { mode: 'sheet' }), 'owner');
    expect(g.params.aspect).toBe('16:9');
    await _runWorkerOnceForTests();
    const done = getGeneration(g.id)!;
    expect(done.status).toBe('succeeded');
    const sheet = listRefs(pid).find((r) => r.kind === 'sheet');
    expect(sheet).toMatchObject({ source: 'generated', assetId: done.assetIds[0] });
    expect(judge).not.toHaveBeenCalled();
  });

  it('recreate sends the template as Image 1', async () => {
    const pid = await personaWithAnchor();
    const t = await createTemplate(tempPng(), { name: 'Cà phê' });
    const g = requestGeneration(req(pid, { mode: 'recreate', selection: { templateId: t.id } }), 'owner');
    await _runWorkerOnceForTests();
    expect(getGeneration(g.id)!.status).toBe('succeeded');
    expect(generateImage.mock.calls[0][0].refs.map((r) => r.role)).toEqual(['composition', 'identity']);
  });

  it('fails cleanly with a Vietnamese reason and records nothing when the provider refuses', async () => {
    const pid = await personaWithAnchor();
    generateImage.mockRejectedValueOnce(new ProviderError('safety', 'gemini: IMAGE_SAFETY'));
    const g = requestGeneration(req(pid), 'owner');
    await _runWorkerOnceForTests();
    const done = getGeneration(g.id)!;
    expect(done.status).toBe('failed');
    expect(done.error).toContain('Bộ lọc an toàn');
    expect(done.assetIds).toEqual([]);
    expect(spendRows()).toEqual([]);
  });

  it('fails when a reference image was deleted before the job ran', async () => {
    const pid = await personaWithAnchor();
    const g = requestGeneration(req(pid), 'owner');
    for (const r of listRefs(pid)) kolDb().prepare('DELETE FROM kol_refs WHERE id = ?').run(r.id);
    await _runWorkerOnceForTests();
    expect(getGeneration(g.id)!.error).toContain('đã bị xóa');
    expect(generateImage).not.toHaveBeenCalled();
  });

  it('respects concurrency (FIFO) and does not start jobs while switched off', async () => {
    const pid = await personaWithAnchor();
    saveSettings({ concurrency: 1 });
    const a = requestGeneration(req(pid), 'owner');
    const b = requestGeneration(req(pid), 'owner');
    await _runWorkerOnceForTests();
    expect(getGeneration(a.id)!.status).toBe('succeeded');
    expect(getGeneration(b.id)!.status).toBe('queued');
    saveSettings({ enabled: false });
    await _runWorkerOnceForTests();
    expect(getGeneration(b.id)!.status).toBe('queued');
    saveSettings({ enabled: true });
    await _runWorkerOnceForTests();
    expect(getGeneration(b.id)!.status).toBe('succeeded');
  });
});

describe('worker — video', () => {
  async function sourceAsset(pid: string): Promise<string> {
    const g = requestGeneration(req(pid), 'owner');
    await _runWorkerOnceForTests();
    return getGeneration(g.id)!.assetIds[0];
  }

  it('animate: submit, store the request id, poll until done, store the video and its spend', async () => {
    const pid = await personaWithAnchor();
    const src = await sourceAsset(pid);
    const g = requestGeneration(req(pid, { mode: 'animate', selection: { sourceAssetId: src, cameraId: 'b-camera-push-in' } }), 'owner');
    expect(g).toMatchObject({ kind: 'video', model: 'veo-3.1-fast-generate-preview' });
    expect(g.params).toMatchObject({ durationSec: 6, audio: true, aspect: '9:16' });
    expect(g.estimateUsd).toBeCloseTo(6 * 0.15, 6);
    expect(g.prompt).toContain('Camera: slow cinematic push-in toward the face.');

    pollVideo.mockResolvedValueOnce({ state: 'pending' });
    await _runWorkerOnceForTests();
    let row = kolDb().prepare('SELECT status, provider_request_id FROM kol_generations WHERE id = ?').get(g.id) as { status: string; provider_request_id: string };
    expect(row).toEqual({ status: 'running', provider_request_id: 'op-1' });
    expect(submitVideo.mock.calls[0][0]).toMatchObject({ durationSec: 6, audio: true, idempotencyKey: g.id });
    expect(submitVideo.mock.calls[0][0].startFrame?.role).toBe('source');

    await _runWorkerOnceForTests({ ignorePollInterval: true });
    expect(getGeneration(g.id)!.status).toBe('running');
    await _runWorkerOnceForTests({ ignorePollInterval: true });
    const done = getGeneration(g.id)!;
    expect(done.status).toBe('succeeded');
    const video = getAsset(done.assetIds[0])!;
    expect(video).toMatchObject({ kind: 'video', mime: 'video/mp4' });
    expect(spendRows().filter((r) => r.generation_id === g.id).map((r) => [r.kind, r.cost_usd])).toEqual([['video', 0.9]]);
    expect(submitVideo).toHaveBeenCalledTimes(1);
  });

  it('a video job weighs 2 against the concurrency', async () => {
    const pid = await personaWithAnchor();
    const src = await sourceAsset(pid);
    pollVideo.mockResolvedValue({ state: 'pending' });
    const v = requestGeneration(req(pid, { mode: 'animate', selection: { sourceAssetId: src } }), 'owner');
    await _runWorkerOnceForTests();
    const i = requestGeneration(req(pid), 'owner');
    await _runWorkerOnceForTests();
    expect(getGeneration(v.id)!.status).toBe('running');
    expect(getGeneration(i.id)!.status).toBe('queued');
  });

  it('ChatGPT images cost only the judge, run one Codex turn at a time and stop at the daily limit', async () => {
    _setProviderAdapterForTests('chatgpt', adapter('chatgpt', [CHAT_IMAGE]));
    saveSettings({ chatgptDailyLimit: 3 });
    const pid = await personaWithAnchor();
    let release: () => void = () => {};
    generateImage.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ outputs: [{ bytes: PNG, mime: 'image/png' }] }); }));
    const a = requestGeneration(req(pid, { params: { model: 'chatgpt-image', count: 1 } }), 'owner');
    const b = requestGeneration(req(pid, { params: { model: 'chatgpt-image', count: 2 } }), 'owner');
    expect(a).toMatchObject({ provider: 'chatgpt', model: 'chatgpt-image' });
    expect(a.estimateUsd).toBeCloseTo(0.002, 6);
    expect(statusOf(() => requestGeneration(req(pid, { params: { model: 'chatgpt-image', count: 1 } }), 'owner'))).toMatchObject({ status: 409, code: 'chatgpt_daily_limit' });
    expect(previewGeneration(req(pid, { params: { model: 'chatgpt-image' } })).warnings.join(' ')).toContain('3/3 ảnh ChatGPT');
    // The test hook waits for launched jobs, so check the claim while the Codex turn is still open.
    const settled = _runWorkerOnceForTests();
    await new Promise((r) => setTimeout(r, 20));
    expect(getGeneration(a.id)!.status).toBe('running');
    expect(getGeneration(b.id)!.status).toBe('queued');
    release();
    await settled;
    expect(getGeneration(a.id)!.status).toBe('succeeded');
    expect(spendRows().filter((r) => r.generation_id === a.id && r.kind === 'image')).toEqual([{ kind: 'image', cost_usd: 0, provider: 'chatgpt', generation_id: a.id }]);
  });

  it('runs ChatGPT jobs in their own pool: chatgptParallel at once, API jobs alongside', async () => {
    _setProviderAdapterForTests('chatgpt', adapter('chatgpt', [CHAT_IMAGE]));
    saveSettings({ chatgptParallel: 2, concurrency: 1 });
    const pid = await personaWithAnchor();
    const releases: (() => void)[] = [];
    generateImage.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve({ outputs: [{ bytes: PNG, mime: 'image/png' }] })); }));
    const c1 = requestGeneration(req(pid, { params: { model: 'chatgpt-image' } }), 'owner');
    const c2 = requestGeneration(req(pid, { params: { model: 'chatgpt-image' } }), 'owner');
    const c3 = requestGeneration(req(pid, { params: { model: 'chatgpt-image' } }), 'owner');
    const g1 = requestGeneration(req(pid), 'owner');
    const g2 = requestGeneration(req(pid), 'owner');
    const settled = _runWorkerOnceForTests();
    await new Promise((r) => setTimeout(r, 20));
    expect([c1, c2, c3, g1, g2].map((g) => getGeneration(g.id)!.status)).toEqual(['running', 'running', 'queued', 'running', 'queued']);
    expect(statusOf(() => saveSettings({ chatgptParallel: 7 })).status).toBe(400);
    for (const r of releases) r();
    await settled;
  });

  it('retries a ChatGPT image after a dropped connection, at most 3 tries, and never a paid provider', async () => {
    _setProviderAdapterForTests('chatgpt', adapter('chatgpt', [CHAT_IMAGE]));
    const pid = await personaWithAnchor();
    generateImage.mockRejectedValue(new ProviderError('network', 'stream disconnected before completion'));
    const c = requestGeneration(req(pid, { params: { model: 'chatgpt-image' } }), 'owner');
    await _runWorkerOnceForTests();
    expect(getGeneration(c.id)).toMatchObject({ status: 'queued' });
    expect(getGeneration(c.id)!.error).toContain('tự thử lại (lần 2/3)');
    await _runWorkerOnceForTests(); // still waiting out the delay
    expect(generateImage).toHaveBeenCalledTimes(1);
    _clearRetryDelaysForTests();
    await _runWorkerOnceForTests();
    _clearRetryDelaysForTests();
    await _runWorkerOnceForTests();
    expect(generateImage).toHaveBeenCalledTimes(3);
    expect(getGeneration(c.id)!.status).toBe('failed');

    generateImage.mockClear();
    const g = requestGeneration(req(pid), 'owner');
    await _runWorkerOnceForTests();
    expect(getGeneration(g.id)!.status).toBe('failed');
    expect(generateImage).toHaveBeenCalledTimes(1);
  });

  it('keeps a spoken line for video models with audio and refuses it otherwise', async () => {
    const pid = await personaWithAnchor();
    const src = await sourceAsset(pid);
    const ok = requestGeneration(req(pid, { mode: 'animate', selection: { sourceAssetId: src }, params: { script: 'Hi, I am Mia!' } }), 'owner');
    expect(ok.params).toMatchObject({ script: 'Hi, I am Mia!', audio: true });
    expect(ok.prompt).toContain('"Hi, I am Mia!"');
    expect(statusOf(() => requestGeneration(req(pid, { mode: 'animate', selection: { sourceAssetId: src }, params: { script: 'x'.repeat(221) } }), 'owner')).status).toBe(400);
  });

  it('a provider failure fails the job without spend', async () => {
    const pid = await personaWithAnchor();
    const src = await sourceAsset(pid);
    pollVideo.mockResolvedValue({ state: 'failed', error: 'fal: output flagged as NSFW' });
    const g = requestGeneration(req(pid, { mode: 'animate', selection: { sourceAssetId: src } }), 'owner');
    await _runWorkerOnceForTests();
    await _runWorkerOnceForTests({ ignorePollInterval: true });
    const done = getGeneration(g.id)!;
    expect(done.status).toBe('failed');
    expect(done.error).toContain('Bộ lọc an toàn');
    expect(spendRows().filter((r) => r.generation_id === g.id)).toEqual([]);
  });

  it('gives up after 15 minutes without resubmitting', async () => {
    const pid = await personaWithAnchor();
    const src = await sourceAsset(pid);
    pollVideo.mockResolvedValue({ state: 'pending' });
    const g = requestGeneration(req(pid, { mode: 'animate', selection: { sourceAssetId: src } }), 'owner');
    await _runWorkerOnceForTests();
    kolDb().prepare('UPDATE kol_generations SET started_at = ? WHERE id = ?').run(nowSec() - 16 * 60, g.id);
    await _runWorkerOnceForTests({ ignorePollInterval: true });
    const done = getGeneration(g.id)!;
    expect(done.status).toBe('failed');
    expect(done.error).toContain('15 phút');
    expect(submitVideo).toHaveBeenCalledTimes(1);
  });

  it('talking: speech (audio asset + spend) → lipsync → video', async () => {
    const pid = await personaWithAnchor();
    const src = await sourceAsset(pid);
    const script = 'Xin chào cả nhà, hôm nay mình đi cà phê trứng ở phố cổ nè!';
    const g = requestGeneration(req(pid, { mode: 'talking', selection: { sourceAssetId: src }, params: { script } }), 'owner');
    expect(g).toMatchObject({ kind: 'lipsync', provider: 'fal', model: LIPSYNC.id });
    await _runWorkerOnceForTests();
    const call = submitVideo.mock.calls[0][0];
    expect(call.audioFile).toMatchObject({ mime: 'audio/mpeg', role: 'audio' });
    expect(call.startFrame?.role).toBe('source');
    await _runWorkerOnceForTests({ ignorePollInterval: true });
    const done = getGeneration(g.id)!;
    expect(done.status).toBe('succeeded');
    const kinds = done.assetIds.map((id) => getAsset(id)!.kind);
    expect(kinds).toEqual(['audio', 'video']);
    const rows = spendRows().filter((r) => r.generation_id === g.id);
    expect(rows.map((r) => `${r.kind}:${r.provider}`)).toEqual(['speech:elevenlabs', 'lipsync:fal']);
    expect(rows[0].cost_usd).toBeCloseTo(script.length * 0.0002, 6);
  });

  it('talking: a lipsync submit failure after speech keeps the audio and the speech cost on the job', async () => {
    const pid = await personaWithAnchor();
    const src = await sourceAsset(pid);
    submitVideo.mockRejectedValueOnce(new ProviderError('quota', 'fal: quota or plan limit reached (HTTP 402)', 402));
    const g = requestGeneration(req(pid, { mode: 'talking', selection: { sourceAssetId: src }, params: { script: 'Chào cả nhà!' } }), 'owner');
    await _runWorkerOnceForTests();
    const done = getGeneration(g.id)!;
    expect(done.status).toBe('failed');
    expect(done.error).toContain('hết tiền');
    expect(done.costUsd).toBeCloseTo('Chào cả nhà!'.length * 0.0002, 6);
    expect(done.assetIds.map((id) => getAsset(id)!.kind)).toEqual(['audio']);
    expect(recoverInterruptedGenerations()).toBe(0);
  });

  it('talking needs a voice, a script and an ElevenLabs key', async () => {
    const pid = await personaWithAnchor();
    const src = await sourceAsset(pid);
    const talking = (over: Partial<GenerationRequest> = {}) => req(pid, { mode: 'talking', selection: { sourceAssetId: src }, params: { script: 'Chào' }, ...over });
    expect(statusOf(() => requestGeneration(talking({ params: {} }), 'owner')).message).toContain('lời thoại');
    _setSpeechForTests(null, null);
    expect(statusOf(() => requestGeneration(talking(), 'owner'))).toMatchObject({ status: 412, code: 'no_voice_key' });
    _setSpeechForTests(async () => MP3);
    updatePersona(pid, { voiceId: '' });
    expect(statusOf(() => requestGeneration(talking(), 'owner')).message).toContain('giọng đọc');
  });
});

describe('restart recovery', () => {
  function insertRunning(personaId: string, kind: string, mode: string, requestId: string | null, model = 'gemini-3-pro-image', provider = 'gemini'): string {
    const id = `g-${kind}-${Math.random().toString(36).slice(2, 8)}`;
    kolDb().prepare(
      `INSERT INTO kol_generations (id, persona_id, kind, mode, status, provider, model, params_json, estimate_usd, provider_request_id, created_at, started_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, 0.9, ?, ?, ?)`,
    ).run(id, personaId, kind, mode, provider, model, JSON.stringify({ durationSec: 6, quality: 'standard', audio: true }), requestId, nowSec(), nowSec());
    return id;
  }

  it('marks interrupted image/speech jobs unknown, never resubmits, and resumes video polling', async () => {
    const pid = await personaWithAnchor();
    const img = insertRunning(pid, 'image', 'compose', null);
    const talkNoId = insertRunning(pid, 'lipsync', 'talking', null, LIPSYNC.id, 'fal');
    const vid = insertRunning(pid, 'video', 'animate', 'op-resume', VIDEO.id);
    expect(recoverInterruptedGenerations()).toBe(2);
    expect(getGeneration(img.toString())).toMatchObject({ status: 'unknown', error: UNKNOWN_NOTE });
    expect(getGeneration(talkNoId)!.status).toBe('unknown');
    expect(getGeneration(vid)!.status).toBe('running');

    await _runWorkerOnceForTests({ ignorePollInterval: true });
    expect(pollVideo).toHaveBeenCalledWith('op-resume');
    expect(generateImage).not.toHaveBeenCalled();
    expect(submitVideo).not.toHaveBeenCalled();
    const done = getGeneration(vid)!;
    expect(done.status).toBe('succeeded');
    expect(spendRows().filter((r) => r.generation_id === vid).map((r) => r.kind)).toEqual(['video']);
  });

  it('retries a failed download on the next poll and records the spend once', async () => {
    const pid = await personaWithAnchor();
    const vid = insertRunning(pid, 'video', 'animate', 'op-x', VIDEO.id);
    pollVideo.mockResolvedValue({ state: 'done', outputs: [{ url: 'https://cdn.example.test/video.mp4' }] });
    const download = vi.fn()
      .mockRejectedValueOnce(new ProviderError('network', 'download: could not reach the server (network error)'))
      .mockResolvedValueOnce(MP4);
    _setDownloaderForTests(download);
    try {
      await _runWorkerOnceForTests({ ignorePollInterval: true });
      expect(getGeneration(vid)!.status).toBe('running');
      expect(spendRows().filter((r) => r.generation_id === vid)).toEqual([]);
      await _runWorkerOnceForTests({ ignorePollInterval: true });
      expect(getGeneration(vid)!.status).toBe('succeeded');
      expect(spendRows().filter((r) => r.generation_id === vid)).toHaveLength(1);
      expect(download).toHaveBeenCalledWith('https://cdn.example.test/video.mp4', expect.any(Number));
    } finally {
      _setDownloaderForTests(null);
    }
  });

  it('fails a finished video whose output is not downloadable, without spend', async () => {
    const pid = await personaWithAnchor();
    const vid = insertRunning(pid, 'video', 'animate', 'op-y', VIDEO.id);
    pollVideo.mockResolvedValueOnce({ state: 'done', outputs: [{ url: 'http://insecure.example/video.mp4' }] });
    await _runWorkerOnceForTests({ ignorePollInterval: true });
    expect(getGeneration(vid)!.status).toBe('failed');
    expect(spendRows().filter((r) => r.generation_id === vid)).toEqual([]);
  });
});
