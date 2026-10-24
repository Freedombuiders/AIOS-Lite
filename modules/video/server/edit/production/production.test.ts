import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerVideoEditRoutes } from '../routes.js';
import { createVideoEditStore } from '../store.js';
import { parseSrt, scriptTranscript, spreadWords } from './assemble.js';
import { pollScene, sceneProblem, startScene, type EngineDeps, type StockSource } from './engines.js';
import { describeEstimate, estimateScenes, sceneFingerprint } from './estimate.js';
import { createHeygenClient, testHeygen, type HeygenClient } from './heygen.js';
import { describeKolPrompt, type KolBridge } from './kol-bridge.js';
import { publishToKol } from './publish.js';
import { planSeries } from './series.js';
import { createProductionService, type ApprovalPort } from './service.js';
import { createProductionStore, estimateSpeechSec, makeScene } from './store.js';
import { executeProduceTool } from './tools.js';
import type { CastMember, KolVoice, Production } from './types.js';
import { pickEngine, scenesFromWriter, writerPrompt } from './writer.js';

const KOL = '11111111-1111-4111-8111-111111111111';
const IMG = '22222222-2222-4222-8222-222222222222';
const VOICE: KolVoice = { provider: 'heygen', voiceId: 'v-tony', name: 'TonyTrieu' };

let root: string;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeHeygen(over: Partial<HeygenClient> = {}): HeygenClient {
  return {
    configured: () => true,
    uploadImage: vi.fn(async () => 'asset-1'),
    createImageVideo: vi.fn(async () => 'vid-1'),
    getVideo: vi.fn(async () => ({ status: 'completed' as const, videoUrl: 'https://x/v.mp4', subtitleUrl: 'https://x/v.srt', durationSec: 9, error: null })),
    listVoices: vi.fn(async () => ({ voices: [], next: null })),
    download: vi.fn(async (_url: string, dest: string) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, dest.endsWith('.srt') ? '1\n00:00:00,000 --> 00:00:02,000\nXin chào\n' : 'mp4'); }),
    ...over,
  } as HeygenClient;
}

function member(): CastMember {
  return { id: KOL, name: 'Tony Trieu', handle: 'tonytrieu', avatarUrl: null, tagline: '', status: 'active', images: [{ id: IMG, url: '/i', thumbUrl: null, width: 1, height: 1 }], videos: [], voice: VOICE };
}

function fakeKol(over: Partial<KolBridge> = {}, identitySource: 'synthetic' | 'licensed' = 'synthetic'): KolBridge {
  return {
    listCast: () => [member()],
    member: (id) => (id === KOL ? { ...member(), realPerson: identitySource === 'licensed' } : null),
    media: () => [{ id: IMG, kind: 'image', status: 'approved', label: 'office, suit · Tony at the office', durationSec: null, createdAt: 1 }],
    persona: (id) => (id === KOL ? ({ id: KOL, name: 'Tony Trieu', handle: 'tonytrieu', identitySource, brainAgent: '@chatgpt', languages: ['vi'], pillars: [], personality: { traits: [], values: [], backstory: '', voiceTone: '', writingStyle: '', catchphrases: [], do: [], dont: [] } } as never) : null),
    imageFile: () => ({ abs: path.join(root, 'face.png'), mime: 'image/png' }),
    videoFile: () => ({ abs: path.join(root, 'clip.mp4'), durationSec: 4 }),
    ready: () => true,
    requestVideo: vi.fn(() => 'gen-1'),
    generation: vi.fn(() => ({ status: 'done' as const, error: '', assetId: 'a-1', costUsd: 1.2 })),
    submitBroll: vi.fn(async () => 'h'),
    pollBroll: vi.fn(async (_h: string, dest: string) => { fs.writeFileSync(dest, 'mp4'); return { done: true as const }; }),
    ...over,
  };
}

function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    heygen: fakeHeygen(), kol: fakeKol(), rocket: null, rocketDownloadRoot: path.join(root, 'rf'), rocketInstalled: () => false,
    store: createProductionStore(root),
    thumbnail: async (_s, dest) => { fs.writeFileSync(dest, 'jpg'); },
    probe: async () => 9,
    ...over,
  };
}

describe('HeyGen client', () => {
  it('uploads, creates an image video with the cloned voice and reads the status', async () => {
    fs.writeFileSync(path.join(root, 'face.png'), 'png');
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v3/assets')) return json(200, { data: { asset_id: 'as-9', url: 'u' } });
      if (url.endsWith('/v3/videos')) return json(200, { data: { video_id: 'vid-9', status: 'waiting' } });
      return json(200, { data: { id: 'vid-9', status: 'completed', video_url: 'https://h/v.mp4', subtitle_url: 'https://h/s.srt', duration: 42.4 } });
    });
    const h = createHeygenClient({ apiKey: () => 'sk', fetchImpl: fetchImpl as never });
    expect(await h.uploadImage(path.join(root, 'face.png'))).toBe('as-9');
    expect(await h.createImageVideo({ assetId: 'as-9', script: 'Xin chào', voiceId: 'v1', aspect: '9:16', title: 't', idempotencyKey: 'k' })).toBe('vid-9');
    const body = JSON.parse(String(calls[1].init?.body));
    expect(body).toMatchObject({ type: 'image', image: { type: 'asset_id', asset_id: 'as-9' }, script: 'Xin chào', voice_id: 'v1', aspect_ratio: '9:16', resolution: '1080p' });
    expect((calls[1].init?.headers as Record<string, string>)['x-api-key']).toBe('sk');
    expect((calls[1].init?.headers as Record<string, string>)['Idempotency-Key']).toBe('k');
    expect(await h.getVideo('vid-9')).toEqual({ status: 'completed', videoUrl: 'https://h/v.mp4', subtitleUrl: 'https://h/s.srt', durationSec: 42.4, error: null });
  });

  it('says what to fix without leaking the key', async () => {
    const h = createHeygenClient({ apiKey: () => null });
    await expect(h.getVideo('x')).rejects.toThrow('Integrations › HeyGen');
    const rejected = await testHeygen({ api_key: 'bad' }, undefined, (async () => json(401, { error: { message: 'nope' } })) as never);
    expect(rejected).toEqual({ ok: false, detail: expect.stringContaining('từ chối API key') });
    const ok = await testHeygen({ api_key: 'sk' }, undefined, (async () => json(200, { data: [{ voice_id: 'v', name: 'TonyTrieu', language: 'Vietnamese', gender: 'male', type: 'private' }] })) as never);
    expect(ok.ok).toBe(true);
  });
});

describe('script transcript', () => {
  it('reads SRT cues and spreads words over time', () => {
    expect(parseSrt('1\n00:00:00,160 --> 00:00:01,800\nTôi từng bán\n\n2\n00:00:01,880 --> 00:00:02,620\náo POD\n')).toEqual([
      { start: 0.16, end: 1.8, text: 'Tôi từng bán' }, { start: 1.88, end: 2.62, text: 'áo POD' },
    ]);
    const w = spreadWords('một hai ba', 1, 4);
    expect(w.map((x) => x.text)).toEqual(['một', 'hai', 'ba']);
    expect(w[0].start).toBe(1);
    expect(w[2].end).toBe(4);
  });

  it('times only talking scenes, offset into the A-roll, using the SRT when there is one', () => {
    const t = scriptTranscript([
      { scene: { kind: 'broll', text: 'không đọc' }, offset: 0, durationSec: 4, srt: null },
      { scene: { kind: 'talking', text: 'Xin chào anh chị' }, offset: 4, durationSec: 3, srt: '1\n00:00:00,500 --> 00:00:02,500\nXin chào anh chị\n' },
      { scene: { kind: 'talking', text: 'Bình luận GENPRINT' }, offset: 7, durationSec: 2, srt: null },
    ], 9);
    expect(t.model).toBe('script');
    expect(t.words.map((w) => w.text)).toEqual(['Xin', 'chào', 'anh', 'chị', 'Bình', 'luận', 'GENPRINT']);
    expect(t.words[0].start).toBe(4.5);
    expect(t.words[3].end).toBe(6.5);
    expect(t.words[4].start).toBeGreaterThanOrEqual(7);
    expect(t.words.at(-1)!.end).toBeLessThanOrEqual(9);
    expect(t.words.map((w) => w.i)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('writer', () => {
  const prod = (): Production => ({ id: 'p', projectId: null, pendingApproval: null, title: 't', cast: [KOL], brief: 'Giới thiệu GenPrint', aspect: '9:16', targetSec: 45, script: null, scenes: [], state: 'brief', finishProjectId: null, error: null, createdAt: '', updatedAt: '' });
  const ready = { heygen: true, veo: true, fal: false, rocketflow: false };

  it('turns the KOL brain answer into scenes with the right engines', () => {
    const out = scenesFromWriter({
      title: 'GenPrint AI', hook: 'Tôi từng bán áo POD', caption: 'c', hashtags: ['#GenPrint', 'POD'],
      scenes: [
        { kind: 'talking', kol: KOL, text: 'Tôi từng bán áo POD trên Amazon.', visual: 'studio', durationSec: 6 },
        { kind: 'broll', kol: null, text: '', visual: 'printer making t-shirts', durationSec: 12 },
        { kind: 'talking', kol: 'someone-else', text: 'Bình luận GENPRINT.', visual: '' },
      ],
    }, prod(), [KOL], ready, { [KOL]: VOICE });
    expect(out.script.hashtags).toEqual(['GenPrint', 'POD']);
    expect(out.scenes.map((s) => [s.kind, s.kolId, s.engine])).toEqual([['talking', KOL, 'heygen'], ['broll', null, 'veo'], ['talking', KOL, 'heygen']]);
    expect(out.scenes[1].durationSec).toBe(8);
    expect(out.scenes.every((s) => s.status === 'draft')).toBe(true);
  });

  it('falls back to Veo for short lines when the KOL has no HeyGen voice, and states the rules', () => {
    expect(pickEngine('talking', 'Câu ngắn.', KOL, ready, {})).toBe('veo');
    expect(pickEngine('broll', '', null, { heygen: false, veo: false, fal: false, rocketflow: true }, {})).toBe('rocketflow');
    const { system, prompt } = writerPrompt(prod(), [fakeKol().persona(KOL)!], ready);
    expect(system).toContain('45 giây');
    expect(system).toContain('Không bịa số liệu');
    expect(prompt).toContain('<untrusted>');
  });
});

describe('engines', () => {
  it('explains why a scene cannot start', () => {
    const d = deps({ heygen: fakeHeygen({ configured: () => false }) });
    expect(sceneProblem(makeScene({ kind: 'talking', kolId: KOL, text: 'x' }), d, {})).toContain('HeyGen');
    expect(sceneProblem(makeScene({ kind: 'talking', kolId: KOL, text: 'x' }), deps(), {})).toContain('giọng HeyGen');
    expect(sceneProblem(makeScene({ kind: 'talking', kolId: KOL, text: 'x'.repeat(260), engine: 'veo' }), deps(), {})).toContain('≤ 200');
    expect(sceneProblem(makeScene({ kind: 'broll', engine: 'rocketflow', visual: 'x' }), deps(), {})).toContain('RocketFlow');
    expect(sceneProblem(makeScene({ kind: 'talking', kolId: KOL, text: 'x' }), deps(), { [KOL]: VOICE })).toBeNull();
  });

  it('runs a HeyGen talking scene end to end: newest approved image, cloned voice, video + SRT on disk', async () => {
    const d = deps();
    const p = d.store.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 30 });
    const scene = makeScene({ kind: 'talking', kolId: KOL, text: 'Xin chào anh chị', visual: 'xưởng in' });
    p.scenes = [scene];
    const started = await startScene(p, scene, d, { [KOL]: VOICE });
    expect('job' in started && started.job.provider).toBe('heygen');
    expect(d.heygen.createImageVideo).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'v-tony', script: 'Xin chào anh chị', aspect: '9:16' }));
    scene.job = (started as { job: NonNullable<typeof scene.job> }).job;
    const polled = await pollScene(p, scene, d);
    expect(polled).toMatchObject({ output: { file: `${scene.id}.mp4`, subtitles: `${scene.id}.srt`, durationSec: 9 } });
  });

  it('asks KOL Studio for identity-locked Veo clips and Veo t2v for KOL-free b-roll', async () => {
    const d = deps();
    const p = d.store.create({ brief: 'b', cast: [KOL], aspect: '4:5', targetSec: 30 });
    const shot = makeScene({ kind: 'broll', kolId: KOL, visual: 'walking in the studio', engine: 'veo', durationSec: 12 });
    const r = await startScene(p, shot, d, {});
    expect(d.kol.requestVideo).toHaveBeenCalledWith(expect.objectContaining({ kolId: KOL, sourceAssetId: IMG, aspect: '9:16', durationSec: 8, audio: false }));
    expect('job' in r && r.job.provider).toBe('kol');
    const free = makeScene({ kind: 'broll', kolId: null, visual: 'printer', engine: 'veo' });
    const r2 = await startScene(p, free, d, {});
    expect('job' in r2 && r2.job.provider).toBe('veo-broll');
  });
});

function fakeApprovals(): ApprovalPort & { requests: Parameters<ApprovalPort['request']>[0][]; expired: string[] } {
  const requests: Parameters<ApprovalPort['request']>[0][] = [];
  const expired: string[] = [];
  return {
    requests, expired,
    request(input) { requests.push(input); return { approvalId: `appr-${input.fingerprint}` }; },
    expire(id) { expired.push(id); },
  };
}

function handoff() {
  const editStore = createVideoEditStore(path.join(root, 've'));
  const messages: { projectId: string; text: string; card?: unknown }[] = [];
  const pipeline = {
    appendMessage: vi.fn((projectId: string, m: { text: string; card?: unknown }) => { messages.push({ projectId, ...m }); return m; }),
    startChain: vi.fn(), beginTurn: vi.fn(() => ({ agentMessageId: 'x', done: Promise.resolve() })), resetForNewSource: vi.fn(),
  };
  return { editStore, pipeline, messages, deps: { editStore, pipeline: pipeline as never, probe: vi.fn() as never, thumbnail: vi.fn() as never, emitProject: vi.fn(), defaultAgentId: () => 'main' } };
}

describe('estimate', () => {
  it('prices Veo per second, HeyGen in credits, Flow and free scenes apart', () => {
    const scenes = [
      makeScene({ kind: 'talking', kolId: KOL, text: Array(30).fill('từ').join(' '), engine: 'heygen' }),
      makeScene({ kind: 'broll', visual: 'printer', engine: 'veo', durationSec: 7 }),
      makeScene({ kind: 'broll', visual: 'city', engine: 'stock' }),
      makeScene({ kind: 'broll', visual: 'x', engine: 'rocketflow' }),
    ];
    const e = estimateScenes(scenes, {}, (_m, o) => ({ usd: o.audio ? 0.4 : 0.15, unit: 'second' }));
    expect(e.usd).toBe(0.9);
    expect(e.heygenCredits).toBe(5);
    expect(e.flowScenes).toBe(1);
    expect(e.freeScenes).toBe(1);
    expect(describeEstimate(e)).toContain('credit HeyGen');
    const fp = sceneFingerprint(scenes);
    expect(sceneFingerprint([...scenes].reverse())).toBe(fp);
    scenes[1].visual = 'another';
    expect(sceneFingerprint(scenes)).not.toBe(fp);
  });
});

describe('service', () => {
  it('hosts every production on a produce-mode project and asks for approval instead of generating', async () => {
    const d = deps({ heygen: fakeHeygen({ getVideo: vi.fn(async () => ({ status: 'processing' as const, videoUrl: null, subtitleUrl: null, durationSec: null, error: null })) }) });
    d.store.setVoice(KOL, VOICE);
    const h = handoff();
    const approvals = fakeApprovals();
    const runner = vi.fn(async () => ({ text: JSON.stringify({ title: 'GenPrint AI', hook: 'h', caption: 'c', hashtags: [], scenes: [{ kind: 'talking', kol: KOL, text: 'Xin chào', visual: '' }, { kind: 'broll', kol: null, text: '', visual: 'printer', durationSec: 5 }] }), model: 'm', costUsd: 0 }));
    const wake = vi.fn();
    const svc = createProductionService({ engines: d, handoff: h.deps, approvals, writer: runner, wake, priceOverrides: () => ({}) });
    const p = svc.create({ brief: 'Giới thiệu GenPrint', cast: [KOL], aspect: '9:16', targetSec: 30 });
    const host = h.editStore.loadProject(p.projectId!)!;
    expect(host).toMatchObject({ mode: 'produce', productionId: p.id });

    const written = await svc.write(p.id);
    expect(written.title).toBe('GenPrint AI');
    expect(h.editStore.loadProject(p.projectId!)!.title).toBe('GenPrint AI');

    const asked = await svc.requestGeneration(p.id, undefined, 'agent');
    expect(asked.production.scenes.map((s) => s.status)).toEqual(['draft', 'draft']);
    expect(approvals.requests).toHaveLength(1);
    expect(approvals.requests[0]).toMatchObject({ productionId: p.id, projectId: p.projectId, agentId: 'main', sceneIds: written.scenes.map((s) => s.id) });
    expect(asked.production.pendingApproval?.approvalId).toBe(asked.approvalId);
    expect(h.messages.find((m) => (m.card as { type?: string })?.type === 'generate_approval')).toBeTruthy();

    // A stale approval (scene edited after the request) cannot start anything.
    const fp = asked.production.pendingApproval!.fingerprint;
    await svc.patchScene(p.id, written.scenes[0].id, { text: 'Xin chào anh chị' });
    expect(approvals.expired).toContain(asked.approvalId);
    await expect(svc.approveGeneration({ productionId: p.id, approvalId: asked.approvalId, sceneIds: asked.production.pendingApproval!.sceneIds, fingerprint: fp })).rejects.toThrow('xin duyệt lại');

    const again = await svc.requestGeneration(p.id);
    const r = await svc.approveGeneration({ productionId: p.id, approvalId: again.approvalId, sceneIds: again.production.pendingApproval!.sceneIds, fingerprint: again.production.pendingApproval!.fingerprint });
    expect(r.queued).toBe(2);
    await vi.waitFor(() => expect(svc.get(p.id).scenes.map((s) => s.status)).toEqual(['running', 'running']));
    expect(svc.get(p.id).pendingApproval).toBeNull();

    await svc.poll(p.id);
    expect(svc.get(p.id).scenes.map((s) => s.status)).toEqual(['running', 'done']);
    (d.heygen.getVideo as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'completed', videoUrl: 'https://x/v.mp4', subtitleUrl: null, durationSec: 3, error: null });
    const done = await svc.poll(p.id);
    expect(done!.state).toBe('ready');
    expect(wake).toHaveBeenCalledWith(p.projectId, expect.stringContaining('Đã tạo xong cả 2 cảnh'));
    await expect(svc.finish(p.id)).rejects.toThrow();
  });

  it('refuses a batch with problems and reports each scene', async () => {
    const d = deps();
    const h = handoff();
    const svc = createProductionService({ engines: d, handoff: h.deps, approvals: fakeApprovals() });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await svc.addScene(p.id, { kind: 'talking', kolId: KOL, text: 'Không có giọng' });
    await expect(svc.requestGeneration(p.id)).rejects.toThrow('Cảnh 1: Chưa chọn giọng HeyGen');
  });

  it('marks queued scenes failed after a restart and adopts a legacy finishing project', async () => {
    const d = deps();
    const h = handoff();
    const svc = createProductionService({ engines: d, handoff: h.deps, approvals: fakeApprovals() });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    d.store.update(p.id, (x) => { x.scenes = [{ ...makeScene({ kind: 'broll', visual: 'v' }), status: 'queued' }]; x.state = 'generating'; });
    expect(svc.recover()).toBe(1);
    expect(svc.get(p.id).scenes[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('duyệt lại') });

    const legacy = d.store.create({ brief: 'cũ', cast: [KOL], aspect: '9:16', targetSec: 20 });
    const profile = h.editStore.createProfile({ name: 'Kênh' });
    const old = h.editStore.createProject({ profileId: profile.id, title: 'cũ', aspect: '9:16', agentId: 'main' });
    d.store.update(legacy.id, (x) => { x.finishProjectId = old.id; });
    expect(svc.ensureHost(legacy.id).projectId).toBe(old.id);
    expect(h.editStore.loadProject(old.id)).toMatchObject({ mode: 'produce', productionId: legacy.id });
  });

  it('estimates speech length from the words', () => {
    expect(estimateSpeechSec('một hai ba bốn năm sáu')).toBe(2);
    expect(estimateSpeechSec(Array(30).fill('từ').join(' '))).toBe(10);
  });
});

describe('director tools', () => {
  it('lets the agent rewrite the storyboard with KOL handles and only raise an approval', async () => {
    const d = deps({ stock: { configured: () => true, find: async () => null, download: async () => undefined } });
    d.store.setVoice(KOL, VOICE);
    const h = handoff();
    const approvals = fakeApprovals();
    const svc = createProductionService({ engines: d, handoff: h.deps, approvals });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    const set = await executeProduceTool(svc, p.id, 'produce_set_storyboard', {
      script: { title: 'Hook mạnh', hook: 'Bạn đang mất 3 giờ mỗi mẫu?' },
      scenes: [{ kind: 'talking', kol: '@TonyTrieu', text: 'Xin chào', visual: '' }, { kind: 'broll', kol: null, text: '', visual: 'printer', engine: 'stock' }],
    }) as { scenes: { id: string }[] };
    expect(set.scenes).toHaveLength(2);
    expect(svc.get(p.id)).toMatchObject({ title: 'Hook mạnh', scenes: [{ kolId: KOL }, { engine: 'stock' }] });
    await expect(executeProduceTool(svc, p.id, 'produce_update_scene', { sceneId: set.scenes[0].id, kol: 'ai-khac' })).rejects.toThrow('Không có KOL');

    const ctx = await executeProduceTool(svc, p.id, 'produce_context', {}) as { cast: { handle: string; heygenVoice: string }[]; engines: { id: string }[] };
    expect(ctx.cast[0]).toMatchObject({ handle: 'tonytrieu', heygenVoice: 'TonyTrieu' });
    expect(ctx.engines.map((e) => e.id)).toContain('stock');

    const asked = await executeProduceTool(svc, p.id, 'produce_request_generation', {}) as { ok: boolean; note: string };
    expect(asked.ok).toBe(true);
    expect(approvals.requests).toHaveLength(1);
    expect(d.heygen.createImageVideo).not.toHaveBeenCalled();
    expect(svc.get(p.id).scenes.every((s) => s.status === 'draft')).toBe(true);
  });
});

describe('stock, publish, series', () => {
  it('fills a b-roll scene from stock footage with the author credit', async () => {
    const stock: StockSource = {
      configured: () => true,
      find: vi.fn(async () => ({ link: 'https://pexels/v.mp4', by: 'Anna', pageUrl: 'https://pexels.com/v/1', durationSec: 9 })),
      download: vi.fn(async (_u: string, dest: string) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'mp4'); }),
    };
    const d = deps({ stock });
    const p = d.store.create({ brief: 'b', cast: [], aspect: '16:9', targetSec: 20 });
    const scene = makeScene({ kind: 'broll', visual: 'printing t-shirts', engine: 'stock', durationSec: 5 });
    const r = await startScene(p, scene, d, {});
    expect(stock.find).toHaveBeenCalledWith('printing t-shirts', '16:9', 5, 0);
    expect(r).toMatchObject({ output: { credit: expect.stringContaining('Anna') } });
  });

  it('publishes the render once per KOL and version', async () => {
    const h = handoff();
    const productions = createProductionStore(root);
    const prod = productions.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    productions.update(prod.id, (x) => { x.script = { title: 'GenPrint', hook: '', caption: 'Cap', hashtags: ['#AI'] }; });
    const profile = h.editStore.createProfile({ name: 'K' });
    const proj = h.editStore.createProject({ profileId: profile.id, title: 't', aspect: '9:16', agentId: 'main' });
    h.editStore.updateProject(proj.id, (x) => { x.mode = 'produce'; x.productionId = prod.id; x.renders = [{ version: 2, file: 'renders/final.v2.mp4', durationSec: 9, sizeBytes: 3, createdAt: '' }]; });
    fs.mkdirSync(path.join(h.editStore.projectDir(proj.id), 'renders'), { recursive: true });
    fs.writeFileSync(path.join(h.editStore.projectDir(proj.id), 'renders', 'final.v2.mp4'), 'mp4');
    const importAsset = vi.fn(async () => ({ id: 'asset-9' }) as never);
    const createPost = vi.fn(() => ({ id: 'post-9' }) as never);
    const pub = { editStore: h.editStore, productions, emitProject: vi.fn(), importAsset, createPost };
    const r = await publishToKol(pub, proj.id, {});
    expect(r).toMatchObject({ postId: 'post-9', assetId: 'asset-9', personaId: KOL, version: 2, reused: false });
    expect(createPost).toHaveBeenCalledWith(KOL, expect.objectContaining({ title: 'GenPrint', caption: 'Cap', hashtags: ['AI'], assetIds: ['asset-9'], format: 'reel' }), expect.objectContaining({ status: 'draft' }));
    const again = await publishToKol(pub, proj.id, {});
    expect(again.reused).toBe(true);
    expect(importAsset).toHaveBeenCalledTimes(1);
  });

  it('plans a series of distinct angles with the lead KOL brain', async () => {
    const runner = vi.fn(async () => ({ text: JSON.stringify({ title: 'GenPrint 101', videos: [
      { title: 'Vì sao', angle: 'nỗi đau', brief: 'Nói về nỗi đau làm design' },
      { title: 'Cách làm', angle: 'hướng dẫn', brief: 'Từng bước từ ý tưởng tới listing' },
      { title: 'Hậu trường', angle: 'build in public', brief: 'Đang xây gì tuần này' },
    ] }), model: 'm', costUsd: 0 }));
    const plan = await planSeries('GenPrint cho chủ shop', 2, 30, fakeKol().persona(KOL)!, runner);
    expect(plan.videos.map((v) => v.title)).toEqual(['Vì sao', 'Cách làm']);
  });
});

describe('routes', () => {
  it('lists engines and cast, stores voice and brand per KOL, and turns generate into an approval', async () => {
    const app = new Hono();
    const approvals = fakeApprovals();
    registerVideoEditRoutes(app, {
      root, autoStart: false,
      doctor: (async () => ({ checks: [{ id: 'hyperframes', label: 'HF', required: false, ok: true, detail: 'phiên bản 0.8.156' }, { id: 'chrome', label: 'Chrome', required: false, ok: true, detail: 'có' }], ok: 2, total: 2, requiredOk: true })) as never,
      production: { heygen: fakeHeygen(), kol: fakeKol(), rocket: null, rocketInstalled: () => false, pollMs: 0, approvals, stock: { configured: () => false, find: async () => null, download: async () => undefined } },
    });
    const send = (method: string, url: string, b?: unknown) => app.request(url, { method, headers: { 'content-type': 'application/json' }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    const engines = (await (await app.request('/edit/production/engines')).json()) as { engines: { id: string; ready: boolean }[] };
    expect(engines.engines.find((e) => e.id === 'heygen')!.ready).toBe(true);
    expect(engines.engines.find((e) => e.id === 'stock')!.ready).toBe(false);
    expect(engines.engines.find((e) => e.id === 'hyperframes')!.ready).toBe(true);

    expect(((await (await send('PUT', `/edit/production/cast/${KOL}/voice`, { voiceId: 'v-tony', name: 'TonyTrieu' })).json()) as { voice: KolVoice }).voice).toEqual(VOICE);
    const brand = ((await (await send('PUT', `/edit/production/cast/${KOL}/brand`, { cta: 'Bình luận HỆ THỐNG', music: 'none' })).json()) as { brand: { cta: string; music: string } }).brand;
    expect(brand).toMatchObject({ cta: 'Bình luận HỆ THỐNG', music: 'none' });
    const cast = (await (await app.request('/edit/production/cast')).json()) as { cast: (CastMember & { brand: { cta: string } })[] };
    expect(cast.cast[0].brand.cta).toBe('Bình luận HỆ THỐNG');

    const created = await send('POST', '/edit/productions', { brief: 'Giới thiệu GenPrint AI', cast: [KOL], write: false });
    const prod = ((await created.json()) as { production: Production }).production;
    expect(prod).toMatchObject({ aspect: '9:16', targetSec: 45, state: 'brief', cast: [KOL], projectId: expect.any(String) });
    // The host project lives on the produce side only.
    const projects = (await (await app.request('/edit/projects')).json()) as { projects: { id: string }[] };
    expect(projects.projects.find((x) => x.id === prod.projectId)).toBeUndefined();
    expect((await app.request(`/edit/projects/${prod.projectId}/upload`, { method: 'POST', headers: { 'x-file-name': 'a.mp4' }, body: 'x' })).status).toBe(409);

    await send('POST', `/edit/productions/${prod.id}/scenes`, { kind: 'talking', kolId: KOL, text: 'Xin chào' });
    const gen = await send('POST', `/edit/productions/${prod.id}/generate`, {});
    const g = (await gen.json()) as { approvalId: string; production: Production };
    expect(g.approvalId).toMatch(/^appr-/);
    expect(g.production.scenes[0].status).toBe('draft');
    expect(approvals.requests).toHaveLength(1);
    const est = (await (await app.request(`/edit/productions/${prod.id}/estimate`)).json()) as { estimate: { heygenCredits: number } };
    expect(est.estimate.heygenCredits).toBeGreaterThan(0);
    expect((await send('POST', '/edit/productions', { brief: 'abc', cast: ['nobody'] })).status).toBe(404);
  });
});

describe('v3.1 hardening', () => {
  function service(over: { engines?: Partial<EngineDeps>; wake?: (projectId: string, note: string) => boolean | void; approvals?: ReturnType<typeof fakeApprovals> & { status?: ApprovalPort['status'] } } = {}) {
    const d = deps(over.engines);
    d.store.setVoice(KOL, VOICE);
    const h = handoff();
    const approvals = over.approvals ?? fakeApprovals();
    const svc = createProductionService({ engines: d, handoff: h.deps, approvals, ...(over.wake ? { wake: over.wake } : {}) });
    return { d, h, approvals, svc };
  }

  async function approved(svc: ReturnType<typeof createProductionService>, id: string) {
    const r = await svc.requestGeneration(id);
    const pa = r.production.pendingApproval!;
    return svc.approveGeneration({ productionId: id, approvalId: pa.approvalId, sceneIds: pa.sceneIds, fingerprint: pa.fingerprint });
  }

  it('never crashes the app when a production disappears while its batch starts, and refuses deletion while generating', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const { d, svc } = service({ engines: { kol: fakeKol({ submitBroll: vi.fn(async () => { await gate; return 'h'; }) }) } });
      const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
      await svc.addScene(p.id, { kind: 'broll', visual: 'printer', engine: 'veo' });
      await svc.addScene(p.id, { kind: 'broll', visual: 'shop', engine: 'veo' });
      await approved(svc, p.id);
      await expect(svc.remove(p.id)).rejects.toThrow('Đang tạo 2 cảnh');
      d.store.remove(p.id); // gone behind the service's back (e.g. a manual cleanup)
      release();
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('clears an approval card that expired elsewhere and tells the chat', async () => {
    const status = vi.fn((_id: string): string | null => 'pending');
    const approvals = Object.assign(fakeApprovals(), { status });
    const { h, svc } = service({ approvals });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await svc.addScene(p.id, { kind: 'talking', kolId: KOL, text: 'Xin chào' });
    await svc.requestGeneration(p.id);
    expect(svc.sweepApprovals()).toBe(0);
    status.mockReturnValue('expired');
    expect(svc.sweepApprovals()).toBe(1);
    expect(svc.get(p.id).pendingApproval).toBeNull();
    expect(h.messages.at(-1)!.text).toContain('hết hạn');
  });

  it('plays only the planned length of a long stock clip, keeps the whole file for re-trimming', async () => {
    const stock: StockSource = { configured: () => true, find: vi.fn(async () => ({ link: 'https://p/v.mp4', by: 'Ann', pageUrl: 'https://p', durationSec: 40 })), download: async (_u, dest) => { fs.writeFileSync(dest, 'mp4'); } };
    const { svc } = service({ engines: { stock, probe: async () => 40 } });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await svc.addScene(p.id, { kind: 'broll', visual: 'printer', engine: 'stock', durationSec: 5 });
    await approved(svc, p.id);
    await vi.waitFor(() => expect(svc.get(p.id).scenes[0].status).toBe('done'));
    const s = svc.get(p.id).scenes[0];
    expect(s.output).toMatchObject({ durationSec: 5, sourceSec: 40 });
    const trimmed = await svc.trimScene(p.id, s.id, { start: 12, durationSec: 4 });
    expect(trimmed.scenes[0]).toMatchObject({ status: 'done', trimStart: 12, output: { durationSec: 4 } });
    const shorter = await svc.patchScene(p.id, s.id, { durationSec: 3 });
    expect(shorter.scenes[0]).toMatchObject({ status: 'done', output: { durationSec: 3 } });
    // A retake asks the stock source for its next match instead of the same clip.
    await approved(svc, p.id).catch(() => undefined);
    const r = await svc.requestGeneration(p.id, [s.id]);
    await svc.approveGeneration({ productionId: p.id, approvalId: r.approvalId, sceneIds: [s.id], fingerprint: r.production.pendingApproval!.fingerprint });
    await vi.waitFor(() => expect((stock.find as ReturnType<typeof vi.fn>).mock.calls.at(-1)![3]).toBe(1));
  });

  it('keeps a real person out of Veo: problem, HeyGen for talking, names scrubbed from prompts', async () => {
    const real = deps({ kol: fakeKol({}, 'licensed') });
    expect(sceneProblem(makeScene({ kind: 'talking', kolId: KOL, text: 'Xin chào', engine: 'veo' }), real, {})).toContain('người thật');
    expect(sceneProblem(makeScene({ kind: 'broll', kolId: KOL, visual: 'walking', engine: 'veo' }), real, {})).toContain('người thật');
    expect(pickEngine('talking', 'Câu ngắn.', KOL, { heygen: false, veo: true, fal: false, rocketflow: false }, {}, true)).toBe('heygen');
    expect(pickEngine('broll', '', null, { heygen: true, veo: true, fal: false, rocketflow: false, stock: true }, {})).toBe('stock');
    const out = scenesFromWriter({ title: 't', scenes: [{ kind: 'broll', kol: KOL, text: '', visual: 'Tony Trieu walks into a print shop' }] },
      { id: 'p', projectId: null, pendingApproval: null, title: 't', cast: [KOL], brief: 'b', aspect: '9:16', targetSec: 30, script: null, scenes: [], state: 'brief', finishProjectId: null, error: null, createdAt: '', updatedAt: '' },
      [KOL], { heygen: true, veo: true, fal: false, rocketflow: false }, {}, [KOL]);
    expect(out.scenes[0]).toMatchObject({ kolId: null, engine: 'veo' });
    const p = real.store.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await startScene(p, out.scenes[0], real, {});
    expect(real.kol.submitBroll).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'the presenter walks into a print shop' }));
  });

  it('fingerprints the frame and the voice, and only the current card can start a batch', async () => {
    const scenes = [makeScene({ kind: 'talking', kolId: KOL, text: 'x' })];
    const fp = sceneFingerprint(scenes, { aspect: '9:16', voices: { [KOL]: VOICE } });
    expect(sceneFingerprint(scenes, { aspect: '16:9', voices: { [KOL]: VOICE } })).not.toBe(fp);
    expect(sceneFingerprint(scenes, { aspect: '9:16', voices: { [KOL]: { ...VOICE, voiceId: 'other' } } })).not.toBe(fp);
    const { svc } = service();
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await svc.addScene(p.id, { kind: 'talking', kolId: KOL, text: 'Xin chào' });
    const r = await svc.requestGeneration(p.id);
    expect(svc.get(p.id).scenes[0].sourceAssetId).toBe(IMG); // the face is pinned before approval
    const pa = r.production.pendingApproval!;
    await expect(svc.approveGeneration({ productionId: p.id, approvalId: 'old-card', sceneIds: pa.sceneIds, fingerprint: pa.fingerprint })).rejects.toThrow('không còn hiệu lực');
    await expect(svc.patch(p.id, { aspect: '16:9' })).resolves.toMatchObject({ aspect: '16:9', pendingApproval: null });
  });

  it('merges a restated storyboard instead of wiping scenes, and keeps the owner title', async () => {
    const runner = vi.fn(async () => ({ text: JSON.stringify({ title: 'Tiêu đề AI', scenes: [{ kind: 'talking', kol: KOL, text: 'Xin chào', visual: 'studio' }] }), model: 'm', costUsd: 0 }));
    const d = deps();
    d.store.setVoice(KOL, VOICE);
    const h = handoff();
    const svc = createProductionService({ engines: d, handoff: h.deps, approvals: fakeApprovals(), writer: runner });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20, title: 'Tên của chủ kênh' });
    const w = await svc.write(p.id);
    expect(w.title).toBe('Tên của chủ kênh');
    d.store.update(p.id, (x) => { x.scenes[0] = { ...x.scenes[0], status: 'done', output: { file: 'a.mp4', durationSec: 3, sourceSec: 3, subtitles: null, thumb: null } }; x.state = 'ready'; });
    const sid = w.scenes[0].id;
    const r = await executeProduceTool(svc, p.id, 'produce_set_storyboard', { scenes: [{ id: sid, kind: 'talking' }, { kind: 'broll', visual: 'printer' }] }) as { scenes: { status: string }[] };
    expect(r.scenes.map((s) => s.status)).toEqual(['done', 'draft']);
    expect(svc.get(p.id).scenes[0]).toMatchObject({ text: 'Xin chào', visual: 'studio', kolId: KOL });
  });

  it('gives up on a provider that never answers and reports it once', async () => {
    const getVideo = vi.fn(async () => { throw new Error('HTTP 500'); });
    const { d, svc } = service({ engines: { heygen: fakeHeygen({ getVideo }) } });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await svc.addScene(p.id, { kind: 'talking', kolId: KOL, text: 'Xin chào' });
    await approved(svc, p.id);
    await vi.waitFor(() => expect(svc.get(p.id).scenes[0].status).toBe('running'));
    for (let i = 0; i < 14; i++) await svc.poll(p.id);
    expect(svc.get(p.id).scenes[0].status).toBe('running');
    await svc.poll(p.id);
    expect(svc.get(p.id).scenes[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('HTTP 500') });
    // A job older than its provider's limit is reported even while the provider says "processing".
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    d.store.update(p.id, (x) => { x.scenes[0] = { ...x.scenes[0], status: 'running', job: { provider: 'heygen', ref: 'vid-1', startedAt: old } }; x.state = 'generating'; });
    getVideo.mockResolvedValue({ status: 'processing', videoUrl: null, subtitleUrl: null, durationSec: null, error: null } as never);
    await svc.poll(p.id);
    expect(svc.get(p.id).scenes[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('chưa trả kết quả') });
  });

  it('lets the director see a take (frames as an image), list KOL media and trim for free', async () => {
    const sheet = vi.fn(async (_f: string, dest: string) => { fs.writeFileSync(dest, 'jpeg-bytes'); });
    const { d, svc } = service({ engines: { sheet } });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await svc.addScene(p.id, { kind: 'broll', visual: 'printer', engine: 'stock' });
    const sid = svc.get(p.id).scenes[0].id;
    d.store.update(p.id, (x) => { x.scenes[0] = { ...x.scenes[0], status: 'done', output: { file: `${sid}.mp4`, durationSec: 5, sourceSec: 9, subtitles: null, thumb: null } }; });
    const seen = await executeProduceTool(svc, p.id, 'produce_inspect_scene', { sceneId: sid }) as { __content: { type: string; data?: string; mimeType?: string }[] };
    expect(seen.__content[1]).toEqual({ type: 'image', data: Buffer.from('jpeg-bytes').toString('base64'), mimeType: 'image/jpeg' });
    expect(JSON.parse((seen.__content[0] as unknown as { text: string }).text)).toMatchObject({ playsSec: 5, sourceSec: 9 });
    const media = await executeProduceTool(svc, p.id, 'produce_list_media', { kol: 'tonytrieu' }) as { images: { id: string }[] };
    expect(media.images[0].id).toBe(IMG);
    const t = await executeProduceTool(svc, p.id, 'produce_trim_scene', { sceneId: sid, start: 2, durationSec: 6 }) as { trimStart: number; playsSec: number };
    expect(t).toMatchObject({ trimStart: 2, playsSec: 6 });
  });

  it('retries a wake that found the director busy, and lets a failed assembly be retried with the reason in chat', async () => {
    const wake = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const { h, svc } = service({ wake });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await svc.addScene(p.id, { kind: 'broll', visual: 'printer', engine: 'veo' });
    await approved(svc, p.id);
    await vi.waitFor(() => expect(svc.get(p.id).scenes[0].status).toBe('running'));
    await svc.poll(p.id);
    expect(wake).toHaveBeenCalledTimes(1);
    await svc.pollAll();
    expect(wake).toHaveBeenCalledTimes(2);
    await svc.pollAll();
    expect(wake).toHaveBeenCalledTimes(2);
    // The only scene is b-roll: finishing needs a talking scene, so make one done and let ffmpeg fail on fake files.
    await svc.addScene(p.id, { kind: 'talking', kolId: KOL, text: 'Xin chào' });
    const sid = svc.get(p.id).scenes[1].id;
    svc.view(svc.get(p.id) as never);
    createProductionStore(root).update(p.id, (x) => { x.scenes[1] = { ...x.scenes[1], status: 'done', output: { file: `${sid}.mp4`, durationSec: 2, subtitles: null, thumb: null } }; x.state = 'ready'; });
    await expect(svc.finish(p.id)).rejects.toThrow();
    expect(svc.get(p.id)).toMatchObject({ state: 'failed', error: expect.any(String) });
    expect(h.messages.at(-1)!.text).toContain('thử lại');
    await expect(svc.finish(p.id)).rejects.toThrow(); // allowed again (not stuck in "assembling")
  });

  it('retries a provider overload by itself (no new approval, nothing billed), but never a safety block or a lost job', async () => {
    let calls = 0;
    const submitBroll = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('gemini: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.');
      if (calls === 2) throw new Error('gemini: blocked by safety filter (third-party content)');
      return 'h';
    });
    const pollBroll = vi.fn(async () => 'pending' as const);
    const { d, h, approvals, svc } = service({ engines: { kol: fakeKol({ submitBroll, pollBroll }) } });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await svc.addScene(p.id, { kind: 'broll', visual: 'printer', engine: 'veo' });
    const sid = svc.get(p.id).scenes[0].id;
    await approved(svc, p.id);
    await vi.waitFor(() => expect(svc.get(p.id).scenes[0].retry?.n).toBe(1));
    expect(svc.get(p.id)).toMatchObject({ state: 'generating', scenes: [{ status: 'queued', error: expect.stringContaining('không cần duyệt lại') }] });
    expect(h.messages.some((m) => m.text.includes('tự thử lại'))).toBe(true);
    await svc.pollAll();
    expect(submitBroll).toHaveBeenCalledTimes(1); // not due yet
    const due = () => d.store.update(p.id, (x) => { x.scenes[0].retry = { n: x.scenes[0].retry!.n, at: new Date(Date.now() - 1000).toISOString() }; });
    due();
    await svc.pollAll();
    expect(svc.get(p.id).scenes[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('safety') }); // a block is never retried
    expect(approvals.requests).toHaveLength(1);

    // Approved again: overload, then the owner stops the retries.
    calls = 0;
    await approved(svc, p.id);
    await vi.waitFor(() => expect(svc.get(p.id).scenes[0].retry?.n).toBe(1));
    const stopped = await svc.stopRetries(p.id);
    expect(stopped).toMatchObject({ state: 'storyboard', scenes: [{ id: sid, status: 'failed', retry: null }] });

    // A restart keeps a waiting retry (it never reached the provider) instead of failing it.
    calls = 0;
    await approved(svc, p.id);
    await vi.waitFor(() => expect(svc.get(p.id).scenes[0].retry?.n).toBe(1));
    svc.recover();
    expect(svc.get(p.id).scenes[0].status).toBe('queued');
    due();
    calls = 2; // next submit succeeds
    await svc.pollAll();
    // Running again; the attempt count stays so the whole batch has a ceiling on retries.
    expect(svc.get(p.id).scenes[0]).toMatchObject({ status: 'running', error: null, retry: { n: 1 } });
  });

  it('does not resubmit a job it merely lost track of (503 while polling)', async () => {
    const getVideo = vi.fn(async () => { throw new Error('HTTP 503 Service Unavailable'); });
    const createImageVideo = vi.fn(async () => 'vid-1');
    const { svc } = service({ engines: { heygen: fakeHeygen({ getVideo, createImageVideo }) } });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await svc.addScene(p.id, { kind: 'talking', kolId: KOL, text: 'Xin chào' });
    await approved(svc, p.id);
    await vi.waitFor(() => expect(svc.get(p.id).scenes[0].status).toBe('running'));
    for (let i = 0; i < 15; i++) await svc.poll(p.id);
    expect(svc.get(p.id).scenes[0]).toMatchObject({ status: 'failed', retry: null });
    expect(createImageVideo).toHaveBeenCalledTimes(1);
  });

  it('labels KOL images by outfit, setting and pose so the director can pick a face that fits the scene', () => {
    const prompt = 'Create a new photorealistic photograph of Tony Trieu.\n\nIDENTITY LOCK: same face.\n\nDIRECTION:\n- Outfit: REPLACE his clothing completely with a navy suit and white shirt. No trace of the old clothing.\n- Setting: a conference stage with warm lights.\n- Pose: speaking with one hand raised.\n\nPHOTO STYLE: candid.\n\nAdditional direction: Vertical presenter shot, waist-up. Clean headroom.';
    expect(describeKolPrompt(prompt, ['event'])).toBe('event · mặc a navy suit and white shirt · a conference stage with warm lights · speaking with one hand raised · Vertical presenter shot, waist-up');
    expect(describeKolPrompt('just a prompt')).toBe('just a prompt');
  });

  it('treats a video id given as the face of a clip scene as the clip, playing it in full unless shortened', async () => {
    const { svc } = service({ engines: { kol: fakeKol({ videoFile: () => ({ abs: path.join(root, 'clip.mp4'), durationSec: 42.4 }) }) } });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    const v = await svc.addScene(p.id, { kind: 'clip', kolId: KOL, sourceAssetId: 'vid-42' });
    expect(v.scenes[0]).toMatchObject({ clipAssetId: 'vid-42', sourceAssetId: null, durationSec: 42.4, problem: null });
    const short = await svc.patchScene(p.id, v.scenes[0].id, { durationSec: 6 });
    expect(short.scenes[0]).toMatchObject({ clipAssetId: 'vid-42', durationSec: 6 });
  });

  it('reports a partial batch honestly (not "all scenes done")', async () => {
    const wake = vi.fn(() => true);
    const { h, svc } = service({ wake, engines: { kol: fakeKol({ videoFile: () => { fs.writeFileSync(path.join(root, 'clip.mp4'), 'mp4'); return { abs: path.join(root, 'clip.mp4'), durationSec: 4 }; } }) } });
    const p = svc.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    await svc.addScene(p.id, { kind: 'clip', kolId: KOL, clipAssetId: 'v1' });
    await svc.addScene(p.id, { kind: 'talking', kolId: KOL, text: 'Xin chào' });
    const r = await svc.requestGeneration(p.id, [svc.get(p.id).scenes[0].id]);
    await svc.approveGeneration({ productionId: p.id, approvalId: r.approvalId, sceneIds: r.production.pendingApproval!.sceneIds, fingerprint: r.production.pendingApproval!.fingerprint });
    await vi.waitFor(() => expect(svc.get(p.id).scenes[0].status).toBe('done'));
    expect(svc.get(p.id).state).toBe('storyboard');
    expect(h.messages.at(-1)!.text).toBe('Lô vừa duyệt đã chạy xong: 1/2 cảnh đã có video. Còn 1 cảnh chưa tạo.');
  });

  it('sends KOL images to Google Flow as ingredients, lets a virtual KOL speak through Flow, and keeps real people out', async () => {
    fs.writeFileSync(path.join(root, 'face.png'), 'png');
    const submit = vi.fn(async (_input: unknown) => ({ id: 'rf-1', state: 'submitted', output: '' }));
    const d = deps({ rocket: { submit }, rocketInstalled: () => true });
    const p = d.store.create({ brief: 'b', cast: [KOL], aspect: '9:16', targetSec: 20 });
    const talk = makeScene({ kind: 'talking', kolId: KOL, text: 'Xin chào cả nhà', visual: 'podcast studio', engine: 'rocketflow' });
    expect(sceneProblem(talk, d, {})).toBeNull();
    await startScene(p, talk, d, {});
    const req = submit.mock.calls[0][0] as unknown as { reference_images: string[]; prompts: string[]; requestId: string };
    expect(req.reference_images).toEqual([path.join(root, 'face.png')]);
    expect(req.prompts[0]).toContain('"Xin chào cả nhà"');
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const real = deps({ kol: fakeKol({}, 'licensed'), rocket: { submit }, rocketInstalled: () => true });
    expect(sceneProblem(talk, real, {})).toContain('người thật');
  });
});
