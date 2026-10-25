import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addFile, setLibraryDeps } from './library/store.js';
import { findFillers, findRetakes } from './pipeline/analyze.js';
import type { DirectorTurnInput } from './agent/director.js';
import { registerVideoEditRoutes } from './routes.js';
import type { AnalysisResult, EditPlan, MediaInfo, QuickSettings, Transcript, VideoProject } from './types.js';

const INFO: MediaInfo = { fileName: 'raw.mp4', sizeBytes: 12, durationSec: 12, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', hasAudio: true };

const WORDS: [string, number, number][] = [
  ['Xin', 0.2, 0.5], ['chào', 0.5, 0.8], ['ờ', 0.9, 1.2], ['các', 1.3, 1.5], ['bạn', 1.5, 1.8],
  ['hôm', 3.0, 3.2], ['nay', 3.2, 3.5], ['mình', 3.5, 3.8], ['nói', 3.8, 4.1],
];
const TRANSCRIPT: Transcript = {
  language: 'vi', model: 'fake', durationSec: 12, createdAt: 'x',
  words: WORDS.map(([text, start, end], i) => ({ i, text, start, end })),
};

type QuickBody = Omit<QuickSettings, 'startedAt'>;
const QUICK: QuickBody = {
  mode: 'ai', autoCut: true, cutLevel: 'vua', templateId: 'th-vang', assets: [],
  music: { mode: 'none', duck: true, snapToBeat: false, endOnFinal: false }, stock: true,
};

let root: string;
let app: Hono;
let reg: ReturnType<typeof registerVideoEditRoutes>;
const calls: string[] = [];
const requestApproval = vi.fn();
let director: ReturnType<typeof vi.fn>;
let resolveBrolls: ReturnType<typeof vi.fn>;
/** What the fake director hands in (null: it answers without a plan). */
let agentPlan: ((input: DirectorTurnInput) => Record<string, unknown>) | null;

const j = async (res: Response) => (await res.json()) as any;
const send = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = (u: string, b?: unknown) => send('POST', u, b ?? {});
const patch = (u: string, b: unknown) => send('PATCH', u, b);
const upload = (id: string) =>
  app.request(`/edit/projects/${id}/upload`, { method: 'POST', headers: { 'x-file-name': 'clip.mp4' }, body: Buffer.from('0123456789') });
const getProject = async (id: string) => (await j(await app.request(`/edit/projects/${id}`))).project as VideoProject;
const getPlan = async (id: string) => (await j(await app.request(`/edit/projects/${id}/plan`))).plan as EditPlan;
const runAll = async () => { reg.pipeline.queue.start(); await reg.pipeline.queue.idle(); };
const step = (p: VideoProject, key: string) => p.steps.find((s) => s.key === key)!;
const aiEdit = (id: string, body: Partial<QuickBody> = {}) => post(`/edit/projects/${id}/ai-edit`, { ...QUICK, ...body });

async function seed(opts: { flow?: 'quick'; profile?: Record<string, unknown> } = {}) {
  const profile = (await j(await post('/edit/profiles', { name: 'Kênh thử', ...(opts.profile ?? {}) }))).profile;
  const res = await post('/edit/projects', { profileId: profile.id, ...(opts.flow ? { flow: opts.flow } : {}) });
  return (await j(res)).project as VideoProject;
}

beforeEach(() => {
  calls.length = 0;
  agentPlan = null;
  requestApproval.mockClear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-edit-quick-'));
  setLibraryDeps({ probeDuration: async () => 30 });
  director = vi.fn(async (input: DirectorTurnInput) => {
    calls.push(`director:${input.reason}`);
    if (agentPlan) {
      const r = reg.pipeline.submitAgentPlan(input.projectId, agentPlan(input), 'Đạo diễn dựng theo mẫu');
      if (!r.ok) throw new Error(r.errors.join('; '));
    }
    return { text: 'Đã dựng theo mẫu.', durationMs: 3, activity: [] };
  });
  resolveBrolls = vi.fn(async (_id: string, plan: EditPlan) => ({
    plan: { ...plan, brolls: plan.brolls.map((b) => (b.query && !b.assetId ? { ...b, assetId: 'lib:video:found' } : b)) },
    notes: ['tìm được 1 cảnh trám từ Pexels'],
  }));
  app = new Hono();
  reg = registerVideoEditRoutes(app, {
    root, autoStart: false,
    probe: (async () => ({ ...INFO })) as never,
    thumbnail: (async (_s: string, d: string) => { fs.writeFileSync(d, 'jpg'); }) as never,
    doctor: (async () => ({ checks: [], ok: 0, total: 0, requiredOk: true })) as never,
    tools: {
      requestApproval,
      runDirector: director as never,
      resolveBrolls: resolveBrolls as never,
      shortlist: (async () => ({ projectAssets: [], library: [], music: [], sfx: [] })) as never,
      normalize: (async (i: { outDir: string }) => {
        calls.push('normalize');
        for (const n of ['master.mp4', 'proxy.mp4', 'audio.wav']) fs.writeFileSync(path.join(i.outDir, n), 'xxxx');
        return { master: path.join(i.outDir, 'master.mp4'), proxy: path.join(i.outDir, 'proxy.mp4'), audio: path.join(i.outDir, 'audio.wav') };
      }) as never,
      transcribe: (async () => { calls.push('transcribe'); return TRANSCRIPT; }) as never,
      analyze: (async (): Promise<AnalysisResult> => {
        calls.push('analyze');
        return { silences: [], fillers: findFillers(TRANSCRIPT.words), retakes: findRetakes(TRANSCRIPT.words), scenes: [], frames: [], createdAt: 'x' };
      }) as never,
      render: (async (i: { store: any; project: { id: string }; plan: { version: number; outputDurationSec: number } }) => {
        calls.push(`render:v${i.plan.version}`);
        fs.mkdirSync(i.store.rendersDir(i.project.id), { recursive: true });
        fs.writeFileSync(path.join(i.store.rendersDir(i.project.id), `final.v${i.plan.version}.mp4`), 'video');
        return { version: i.plan.version, file: `renders/final.v${i.plan.version}.mp4`, durationSec: i.plan.outputDurationSec, sizeBytes: 5, createdAt: 'x', warnings: [], qaFiles: [] };
      }) as never,
      covers: (async () => { calls.push('covers'); return { files: [] }; }) as never,
    },
  });
});

afterEach(() => { reg.stop(); setLibraryDeps(null); fs.rmSync(root, { recursive: true, force: true }); });

describe('POST /projects flow', () => {
  it('marks a Dựng nhanh project and leaves other projects without a flow', async () => {
    expect((await seed({ flow: 'quick' })).flow).toBe('quick');
    expect((await seed()).flow).toBeUndefined();
    const profile = (await j(await post('/edit/profiles', { name: 'Khác' }))).profile;
    expect((await post('/edit/projects', { profileId: profile.id, flow: 'slow' })).status).toBe(400);
  });
});

describe('POST /projects/:id/ai-edit', () => {
  it('409 without a source video, 400 for an unknown template, a missing song or an asset not in the library', async () => {
    const project = await seed({ flow: 'quick' });
    const res = await aiEdit(project.id);
    expect(res.status).toBe(409);
    expect((await j(res)).code).toBe('no_source');
    await upload(project.id);
    expect((await j(await aiEdit(project.id, { templateId: 'khong-co' }))).code).toBe('no_template');
    expect((await j(await aiEdit(project.id, { music: { mode: 'pick', duck: true, snapToBeat: false, endOnFinal: false } }))).code).toBe('no_music');
    expect((await j(await aiEdit(project.id, { assets: [{ assetId: 'lib:video:gone' }] }))).code).toBe('no_asset');
    expect((await aiEdit(project.id, { cutLevel: 'manh' as never })).status).toBe(400);
    expect((await getProject(project.id)).quick).toBeUndefined();
  });

  it('saves the settings with startedAt and the footage descriptions', async () => {
    const project = await seed({ flow: 'quick' });
    await upload(project.id);
    const temp = path.join(root, 'clip.png');
    fs.writeFileSync(temp, Buffer.from('89504e470d0a1a0a', 'hex'));
    const asset = await addFile(root, { kind: 'image', tempPath: temp, fileName: 'man-hinh.png' });
    const res = await aiEdit(project.id, { assets: [{ assetId: asset.id, hint: 'màn hình lúc mở app' }], note: 'Giữ câu chào' });
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.project.quick).toMatchObject({ ...QUICK, assets: [{ assetId: asset.id, hint: 'màn hình lúc mở app' }], note: 'Giữ câu chào' });
    expect(Date.parse(body.project.quick.startedAt)).not.toBeNaN();
    // analyze not done yet: the chain's own job is returned
    expect(body.job.kind).toBe('ingest');
  });
});

describe('the chain with and without Dựng nhanh', () => {
  it('a project without a flow keeps the old chain: auto plan, director, approval card', async () => {
    const project = await seed();
    await upload(project.id);
    await runAll();
    expect(calls).toEqual(['normalize', 'transcribe', 'analyze', 'director:plan']);
    const p = await getProject(project.id);
    expect(step(p, 'approve')).toMatchObject({ status: 'waiting', summary: 'Chờ bạn duyệt kế hoạch' });
    expect(requestApproval).toHaveBeenCalledWith(project.id);
  });

  it('flow quick stops after analyze and waits for AI edit; AI edit then runs the director on the template', async () => {
    const project = await seed({ flow: 'quick' });
    await upload(project.id);
    await runAll();
    expect(calls).toEqual(['normalize', 'transcribe', 'analyze']);
    let p = await getProject(project.id);
    expect(step(p, 'direct')).toMatchObject({ status: 'waiting', summary: 'Chờ bạn bấm AI edit' });
    expect(p.planVersion).toBe(0);

    const res = await aiEdit(project.id);
    expect(res.status).toBe(200);
    expect((await j(res)).job.kind).toBe('direct');
    await runAll();
    expect(calls.slice(3)).toEqual(['director:plan']);
    p = await getProject(project.id);
    // the director answered without a plan: the machine plan of the template stands, straight to the editor
    expect(p).toMatchObject({ planVersion: 1, planStatus: 'waiting_approval', status: 'waiting_approval' });
    expect(step(p, 'direct').status).toBe('done');
    expect(step(p, 'approve')).toMatchObject({ status: 'waiting', summary: 'Mở editor để chỉnh, bấm Xuất khi xong' });
    expect(requestApproval).not.toHaveBeenCalled();
    const plan = await getPlan(project.id);
    expect(plan).toMatchObject({ author: 'auto', templateId: 'th-vang', planFormat: 2, autoCut: true, gapMs: 400, cutWords: [2] });
    expect(calls.some((c) => c.startsWith('render'))).toBe(false);
  });

  it('AI edit pressed before analyze finished: the chain goes on the quick way by itself', async () => {
    const project = await seed({ flow: 'quick' });
    await upload(project.id);
    const res = await aiEdit(project.id, { cutLevel: 'sat' });
    expect((await j(res)).job.kind).toBe('ingest');
    await runAll();
    expect(calls).toEqual(['normalize', 'transcribe', 'analyze', 'director:plan']);
    const plan = await getPlan(project.id);
    expect(plan).toMatchObject({ templateId: 'th-vang', gapMs: 250 });
    expect(step(await getProject(project.id), 'approve').summary).toBe('Mở editor để chỉnh, bấm Xuất khi xong');
  });

  it('restarts a failed chain from the step that failed', async () => {
    const project = await seed({ flow: 'quick' });
    await upload(project.id);
    reg.pipeline.tools.transcribe = (async () => { throw new Error('whisper hỏng'); }) as never;
    await runAll();
    expect(step(await getProject(project.id), 'transcribe').status).toBe('failed');
    reg.pipeline.tools.transcribe = (async () => { calls.push('transcribe'); return TRANSCRIPT; }) as never;
    const res = await aiEdit(project.id);
    expect((await j(res)).job.kind).toBe('transcribe');
    await runAll();
    expect(calls.slice(-3)).toEqual(['transcribe', 'analyze', 'director:plan']);
  });
});

describe('mode manual and the owner settings', () => {
  it('"Bỏ qua, tự chỉnh tay" makes the plan by machine: no director, captions of the template, straight to the editor', async () => {
    const project = await seed({ flow: 'quick' });
    await upload(project.id);
    await runAll();
    await aiEdit(project.id, { mode: 'manual', cutLevel: 'nhe' });
    await runAll();
    expect(calls.some((c) => c.startsWith('director'))).toBe(false);
    const p = await getProject(project.id);
    expect(step(p, 'direct')).toMatchObject({ status: 'done' });
    expect(step(p, 'direct').summary).toContain('tự chỉnh tay');
    expect(step(p, 'approve').status).toBe('waiting');
    const plan = await getPlan(project.id);
    expect(plan).toMatchObject({ author: 'auto', templateId: 'th-vang', planFormat: 2, gapMs: 800, cutWords: [2] });
    expect(plan.captions.maxWordsPerChunk).toBe(3);
    expect(plan.summary).toContain('Mở editor');
    expect(calls.some((c) => c.startsWith('render'))).toBe(false);
  });

  it('auto-cut off cuts nothing, in the machine plan and in the plan the director hands in', async () => {
    const project = await seed({ flow: 'quick' });
    await upload(project.id);
    await runAll();
    await aiEdit(project.id, { mode: 'manual', autoCut: false });
    await runAll();
    expect(await getPlan(project.id)).toMatchObject({ autoCut: false, cutWords: [], gapMs: 5000 });

    agentPlan = () => ({ summary: 'Cắt từ đệm cho gọn.', cutWords: [2], gapMs: 250, autoCut: true });
    await aiEdit(project.id, { mode: 'ai', autoCut: false });
    await runAll();
    const plan = await getPlan(project.id);
    expect(plan).toMatchObject({ author: 'agent', autoCut: false, cutWords: [], gapMs: 5000, templateId: 'th-vang' });
  });

  it('the picked song is in the plan; "no music" takes the director\'s music out', async () => {
    const project = await seed({ flow: 'quick' });
    await upload(project.id);
    await runAll();
    const temp = path.join(root, 'song.mp3');
    fs.writeFileSync(temp, Buffer.from('494433', 'hex'));
    const song = await addFile(root, { kind: 'bgm', tempPath: temp, fileName: 'song.mp3' });
    await aiEdit(project.id, { mode: 'manual', music: { mode: 'pick', assetId: song.id, duck: true, snapToBeat: false, endOnFinal: true } });
    await runAll();
    expect((await getPlan(project.id)).music).toMatchObject({ assetId: song.id, duck: true, gainDb: -18 });

    agentPlan = () => ({ summary: 'Thêm nhạc nền vui.', cutWords: [2], gapMs: 300, music: { assetId: song.id, mood: 'vui', gainDb: -3, duck: true } });
    await aiEdit(project.id, { mode: 'ai' });
    await runAll();
    expect((await getPlan(project.id)).music).toBeUndefined();
  });
});

describe('after the director', () => {
  it('owner elements survive the AI plan, and B-roll slots with a query are filled by the Asset Hub', async () => {
    const project = await seed({ flow: 'quick' });
    await upload(project.id);
    await runAll();
    await aiEdit(project.id, { mode: 'manual' });
    await runAll();
    const before = await getProject(project.id);
    const ops = await post(`/edit/projects/${project.id}/plan/ops`, {
      baseVersion: before.planVersion,
      ops: [{ op: 'add', kind: 'beat', element: { component: 'text-beat', anchorWord: 7, duration: 2, title: 'Chủ kênh *thêm*' } }],
    });
    expect(ops.status).toBe(200);
    const ownerId = ((await j(ops)).plan as EditPlan).beats!.find((b) => b.origin === 'owner')!.id;

    agentPlan = () => ({
      summary: 'Chữ theo nhịp và một cảnh trám cần tìm.', cutWords: [2], gapMs: 300,
      beats: [{ component: 'text-beat', anchorWord: 5, duration: 2, title: 'Hôm nay *mình nói*', animIn: 'pop' }],
      brolls: [{ id: 'br1', anchorWord: 3, duration: 2, title: 'Người xem', reason: 'khi nói các bạn', source: 'pexels', layout: 'card', query: { description: 'khán giả vỗ tay', keywords: ['audience', 'clapping'] } }],
    });
    await aiEdit(project.id, { mode: 'ai' });
    await runAll();
    const plan = await getPlan(project.id);
    expect(plan.author).toBe('agent');
    expect(plan.beats!.map((b) => b.id)).toContain(ownerId);
    expect(plan.beats!.find((b) => b.id === ownerId)).toMatchObject({ origin: 'owner', title: 'Chủ kênh *thêm*' });
    expect(resolveBrolls).toHaveBeenCalledTimes(1);
    expect(plan.brolls[0]).toMatchObject({ id: 'br1', assetId: 'lib:video:found' });
    expect(step(await getProject(project.id), 'direct').log!.map((l) => l.text)).toContain('tìm được 1 cảnh trám từ Pexels');
  });

  it('a director plan with a component the template does not have is refused', async () => {
    const project = await seed({ flow: 'quick' });
    await upload(project.id);
    await runAll();
    agentPlan = () => ({ summary: 'Thử component lạ.', cutWords: [2], beats: [{ component: 'khong-co', anchorWord: 5, duration: 2, title: 'Hai từ' }] });
    await aiEdit(project.id);
    await runAll();
    const p = await getProject(project.id);
    // the machine plan stands; the refusal is the director's error
    expect(p.planVersion).toBe(1);
    expect((await getPlan(project.id)).author).toBe('auto');
  });
});

describe('no render until Xuất', () => {
  it('ignores the profile auto-approve, and a revise turn on a quick project does not render either', async () => {
    const project = await seed({ flow: 'quick', profile: {} });
    const profileId = project.profileId;
    expect((await patch(`/edit/profiles/${profileId}`, { autoApprovePlan: true })).status).toBe(200);
    await upload(project.id);
    await runAll();
    await aiEdit(project.id);
    await runAll();
    let p = await getProject(project.id);
    expect(p).toMatchObject({ planStatus: 'waiting_approval', status: 'waiting_approval' });

    agentPlan = () => ({ summary: 'Hook ngắn hơn theo góp ý.', cutWords: [2], gapMs: 300 });
    expect((await post(`/edit/projects/${project.id}/plan/decide`, { action: 'revise', note: 'Ngắn hơn' })).status).toBe(200);
    await runAll();
    expect(calls).toContain('director:revise');
    p = await getProject(project.id);
    expect(p).toMatchObject({ planStatus: 'waiting_approval', planVersion: 2 });
    expect(step(p, 'approve').summary).toBe('Mở editor để chỉnh, bấm Xuất khi xong');
    expect(calls.some((c) => c.startsWith('render'))).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('Xuất approves the owner\'s draft made by plan ops and renders it', async () => {
    const project = await seed({ flow: 'quick' });
    await upload(project.id);
    await runAll();
    await aiEdit(project.id);
    await runAll();
    const before = await getProject(project.id);
    const ops = await post(`/edit/projects/${project.id}/plan/ops`, { baseVersion: before.planVersion, ops: [{ op: 'toggleWords', words: [8] }] });
    expect(ops.status).toBe(200);
    const draft = await getProject(project.id);
    expect(draft).toMatchObject({ planStatus: 'draft', planVersion: before.planVersion + 1 });
    expect((await getPlan(project.id)).author).toBe('owner');

    const res = await post(`/edit/projects/${project.id}/plan/decide`, { action: 'approve' });
    expect(res.status).toBe(200);
    await runAll();
    expect(calls).toContain(`render:v${draft.planVersion}`);
    expect(await getProject(project.id)).toMatchObject({ status: 'done', planStatus: 'approved' });
  });
});
