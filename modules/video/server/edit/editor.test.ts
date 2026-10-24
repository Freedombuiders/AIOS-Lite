import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findFillers, findRetakes } from './pipeline/analyze.js';
import { decidePlan } from './pipeline/jobs.js';
import { registerVideoEditRoutes } from './routes.js';
import { appendTasteRule } from './routes-editor.js';
import type { AnalysisResult, MediaInfo, Transcript, VideoProject } from './types.js';

const INFO: MediaInfo = { fileName: 'raw.mp4', sizeBytes: 12, durationSec: 12, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', hasAudio: true };

const WORDS: [string, number, number][] = [
  ['Xin', 0.2, 0.5], ['chào', 0.5, 0.8], ['ờ', 0.9, 1.2], ['các', 1.3, 1.5], ['bạn', 1.5, 1.8],
  ['hôm', 3.0, 3.2], ['nay', 3.2, 3.5], ['mình', 3.5, 3.8], ['nói', 3.8, 4.1],
];
const TRANSCRIPT: Transcript = {
  language: 'vi', model: 'fake', durationSec: 12, createdAt: 'x',
  words: WORDS.map(([text, start, end], i) => ({ i, text, start, end })),
};

let root: string;
let app: Hono;
let reg: ReturnType<typeof registerVideoEditRoutes>;
let local = true;
const calls: string[] = [];
const requestApproval = vi.fn();
let director: ReturnType<typeof vi.fn>;

const j = async (res: Response) => (await res.json()) as any;
const send = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = (u: string, b?: unknown) => send('POST', u, b ?? {});
const patch = (u: string, b: unknown) => send('PATCH', u, b);

async function seed(profilePatch: Record<string, unknown> = {}) {
  const profile = (await j(await post('/edit/profiles', { name: 'Kênh thử', ...profilePatch }))).profile;
  const project = (await j(await post('/edit/projects', { profileId: profile.id, styleId: 'kienthuc' }))).project as VideoProject;
  return { profile, project };
}
const upload = (id: string) =>
  app.request(`/edit/projects/${id}/upload`, { method: 'POST', headers: { 'x-file-name': 'clip.mp4' }, body: Buffer.from('0123456789') });
const getProject = async (id: string) => (await j(await app.request(`/edit/projects/${id}`))).project as VideoProject;
const runAll = async () => { reg.pipeline.queue.start(); await reg.pipeline.queue.idle(); };

beforeEach(() => {
  calls.length = 0;
  local = true;
  requestApproval.mockClear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-edit-editor-'));
  director = vi.fn(async () => ({ text: 'Đã xem lời.', durationMs: 3, activity: [] }));
  app = new Hono();
  reg = registerVideoEditRoutes(app, {
    root, autoStart: false, isLocal: () => local,
    probe: (async () => ({ ...INFO })) as never,
    thumbnail: (async (_s: string, d: string) => { fs.writeFileSync(d, 'jpg'); }) as never,
    doctor: (async () => ({ checks: [], ok: 0, total: 0, requiredOk: true })) as never,
    tools: {
      requestApproval,
      runDirector: director as never,
      normalize: (async (i: { outDir: string }) => {
        calls.push('normalize');
        for (const n of ['master.mp4', 'proxy.mp4', 'audio.wav']) fs.writeFileSync(path.join(i.outDir, n), 'xxxx');
        return { master: path.join(i.outDir, 'master.mp4'), proxy: path.join(i.outDir, 'proxy.mp4'), audio: path.join(i.outDir, 'audio.wav') };
      }) as never,
      transcribe: (async (i: { keepWords?: string[] }) => { calls.push(`transcribe:${(i.keepWords ?? []).join(',')}`); return TRANSCRIPT; }) as never,
      analyze: (async (): Promise<AnalysisResult> => {
        calls.push('analyze');
        return { silences: [], fillers: findFillers(TRANSCRIPT.words), retakes: findRetakes(TRANSCRIPT.words), scenes: [], frames: [{ at: 1, file: 'frames/f.jpg' }, { at: 3.5, file: 'frames/g.jpg' }], createdAt: 'x' };
      }) as never,
      render: (async (i: { store: any; project: { id: string }; plan: { version: number; outputDurationSec: number }; log: (s: string, t: string) => void }) => {
        calls.push(`render:v${i.plan.version}`);
        i.log('cut', 'đã cắt');
        fs.mkdirSync(i.store.rendersDir(i.project.id), { recursive: true });
        const f = path.join(i.store.rendersDir(i.project.id), `final.v${i.plan.version}.mp4`);
        fs.writeFileSync(f, 'video-bytes');
        return { version: i.plan.version, file: `renders/final.v${i.plan.version}.mp4`, durationSec: i.plan.outputDurationSec, sizeBytes: 11, createdAt: 'x', warnings: [], qaFiles: [] };
      }) as never,
      covers: (async (i: { store: any; project: { id: string } }) => {
        calls.push('covers');
        fs.mkdirSync(i.store.coversDir(i.project.id), { recursive: true });
        for (const n of [1, 2, 3]) fs.writeFileSync(i.store.coverFile(i.project.id, n), 'jpg');
        return { files: [] };
      }) as never,
    },
  });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('automatic chain', () => {
  it('runs upload → ingest → transcribe → analyze → auto plan → direct and parks for approval', async () => {
    const { project } = await seed({ keepWords: ['FreedomOS'] });
    expect((await upload(project.id)).status).toBe(200);
    await runAll();
    expect(calls).toEqual(['normalize', 'transcribe:FreedomOS', 'analyze']);
    expect(director).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id, reason: 'plan' }));

    const p = await getProject(project.id);
    const status = (k: string) => p.steps.find((s) => s.key === k)!.status;
    expect(['ingest', 'transcribe', 'analyze', 'direct'].map(status)).toEqual(['done', 'done', 'done', 'done']);
    expect(status('approve')).toBe('waiting');
    expect(p).toMatchObject({ status: 'waiting_approval', planVersion: 1, planStatus: 'waiting_approval', busy: false });
    expect(p.steps.find((s) => s.key === 'analyze')!.log?.length).toBeGreaterThan(0);
    expect(requestApproval).toHaveBeenCalledWith(project.id);

    const plan = (await j(await app.request(`/edit/projects/${project.id}/plan`)));
    expect(plan).toMatchObject({ planVersion: 1, planStatus: 'waiting_approval' });
    expect(plan.plan.cutWords).toEqual([2]);
    expect((await j(await app.request(`/edit/projects/${project.id}/transcript`))).words).toHaveLength(9);
    expect((await app.request(`/edit/projects/${project.id}/analysis`)).status).toBe(200);
    // the agent's reply is a chat message
    const msgs = (await j(await app.request(`/edit/projects/${project.id}`))).messages;
    expect(msgs.at(-1)).toMatchObject({ role: 'agent', text: 'Đã xem lời.' });
  });

  it('approve renders, makes covers, finishes the ticket and records the render', async () => {
    const { project } = await seed();
    await upload(project.id);
    await runAll();
    const res = await post(`/edit/projects/${project.id}/plan/decide`, { action: 'approve' });
    expect(res.status).toBe(200);
    await runAll();
    expect(calls.slice(-2)).toEqual(['render:v1', 'covers']);
    const p = await getProject(project.id);
    expect(p).toMatchObject({ status: 'done', planStatus: 'approved', outputs: { final: true, covers: 3 } });
    expect(p.renders).toHaveLength(1);
    expect(p.steps.find((s) => s.key === 'render')!.status).toBe('done');
    expect(p.steps.find((s) => s.key === 'cover')!.status).toBe('done');
    expect(p.steps.find((s) => s.key === 'deliver')!.status).toBe('waiting');
    expect(p.steps.find((s) => s.key === 'cut')!.log?.[0].text).toBe('đã cắt');
    expect(((await j(await app.request(`/edit/projects/${project.id}/renders`))).renders)).toHaveLength(1);
    const media = await app.request(`/edit/projects/${project.id}/media/final`);
    expect(media.status).toBe(200);
    expect((await app.request(`/edit/projects/${project.id}/media/final-v1`)).status).toBe(200);
    expect((await app.request(`/edit/projects/${project.id}/media/cover-2`)).status).toBe(200);
  });

  it('auto-approves when the profile says so, and copies to the delivery folder', async () => {
    const deliver = fs.mkdtempSync(path.join(os.tmpdir(), 'video-deliver-'));
    try {
      const { profile, project } = await seed();
      expect((await patch(`/edit/profiles/${profile.id}`, { autoApprovePlan: true, deliverDir: deliver })).status).toBe(200);
      await upload(project.id);
      await runAll();
      const p = await getProject(project.id);
      expect(p.status).toBe('done');
      expect(requestApproval).not.toHaveBeenCalled();
      const dir = fs.readdirSync(deliver)[0];
      expect(dir).toMatch(/^VID-0001-/);
      expect(fs.readdirSync(path.join(deliver, dir)).sort()).toEqual(['cover-1.v1.jpg', 'cover-2.v1.jpg', 'cover-3.v1.jpg', 'final.v1.mp4', 'meta.v1.txt']);
      expect(p.steps.find((s) => s.key === 'deliver')!.status).toBe('done');
    } finally {
      fs.rmSync(deliver, { recursive: true, force: true });
    }
  });

  it('fails the step and stops the chain when a tool throws', async () => {
    const { project } = await seed();
    reg.pipeline.tools.transcribe = (async () => { throw new Error('whisper chết'); }) as never;
    await upload(project.id);
    await runAll();
    const p = await getProject(project.id);
    expect(p.steps.find((s) => s.key === 'transcribe')).toMatchObject({ status: 'failed', error: 'whisper chết' });
    expect(p.status).toBe('failed');
    expect(calls).not.toContain('analyze');
    const job = reg.pipeline.queue.list(project.id).find((x) => x.kind === 'transcribe')!;
    expect(job.status).toBe('failed');
  });

  it('keeps the automatic plan when the director fails, and revise runs a new turn', async () => {
    director.mockRejectedValueOnce(new Error('LLM tắt'));
    const { project } = await seed();
    await upload(project.id);
    await runAll();
    let p = await getProject(project.id);
    expect(p.planStatus).toBe('waiting_approval');
    expect(p.steps.find((s) => s.key === 'direct')!.log?.some((l) => l.text.includes('dùng bản tự động'))).toBe(true);

    const res = await post(`/edit/projects/${project.id}/plan/decide`, { action: 'revise', note: 'Hook gắt hơn' });
    expect(res.status).toBe(200);
    await runAll();
    expect(director).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'revise', note: 'Hook gắt hơn' }));
    p = await getProject(project.id);
    expect(p.planStatus).toBe('waiting_approval');

    expect((await post(`/edit/projects/${project.id}/plan/decide`, { action: 'reject' })).status).toBe(200);
    expect((await getProject(project.id)).planStatus).toBe('rejected');
    expect((await post(`/edit/projects/${project.id}/plan/decide`, { action: 'approve' })).status).toBe(409);
  });

  it('decidePlan (used by the approval handler) drives the same logic', async () => {
    const { project } = await seed();
    await upload(project.id);
    await runAll();
    await decidePlan(project.id, 'approve');
    await runAll();
    expect((await getProject(project.id)).status).toBe('done');
  });
});

describe('plan editing', () => {
  async function planned() {
    const s = await seed();
    await upload(s.project.id);
    await runAll();
    return s.project;
  }

  it('PATCH toggles words into a new owner draft version and diff explains it', async () => {
    const project = await planned();
    const res = await patch(`/edit/projects/${project.id}/plan`, { toggleWords: [2, 6], gapMs: 400 });
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.plan).toMatchObject({ version: 2, author: 'owner', cutWords: [6], gapMs: 400 });
    expect(body.project).toMatchObject({ planVersion: 2, planStatus: 'draft' });
    const diff = await j(await app.request(`/edit/projects/${project.id}/plan/diff?from=1&to=2`));
    expect(diff.changes.join('\n')).toMatch(/Giữ lại 1 từ/);
    const v1 = await j(await app.request(`/edit/projects/${project.id}/plan?version=1`));
    expect(v1.plan.version).toBe(1);
    expect(v1.planStatus).toBeUndefined();
    expect((await app.request(`/edit/projects/${project.id}/plan?version=9`)).status).toBe(404);
    expect((await patch(`/edit/projects/${project.id}/plan`, { gapMs: -1 })).status).toBe(400);
    expect((await patch(`/edit/projects/${project.id}/plan`, { nope: 1 })).status).toBe(400);
  });

  it('serves the live composition for any version with Range, plus assets-less sources', async () => {
    const project = await planned();
    await patch(`/edit/projects/${project.id}/plan`, { toggleWords: [6] });
    const url = `/edit/projects/${project.id}/composition/preview.html`;
    const latest = await app.request(`${url}?v=2`);
    expect(latest.status).toBe(200);
    expect(latest.headers.get('content-type')).toContain('text/html');
    const html2 = await latest.text();
    const html1 = await (await app.request(`${url}?v=1`)).text();
    expect(html2).toContain('data-composition-id="main"');
    expect(html1).not.toBe(html2);
    expect(html2).toContain('../source/proxy.mp4');
    const part = await app.request(url, { headers: { range: 'bytes=0-9' } });
    expect(part.status).toBe(206);
    expect((await part.text()).length).toBe(10);
    const proxy = await app.request(`/edit/projects/${project.id}/source/proxy.mp4`, { headers: { range: 'bytes=1-2' } });
    expect(proxy.status).toBe(206);
    expect((await app.request(`/edit/projects/${project.id}/source/raw.mp4`)).status).toBe(404);
    expect((await app.request(`/edit/projects/${project.id}/composition/assets/nope.ttf`)).status).toBe(404);
    expect((await app.request(`/edit/projects/${project.id}/composition/assets/..%2F..%2Fproject.json`)).status).toBe(404);
  });
});

describe('marks, brief, feedback', () => {
  it('CRUD marks, send them to the agent and resolve the ones the plan names', async () => {
    const { project } = await seed();
    await upload(project.id);
    await runAll();
    const base = `/edit/projects/${project.id}/marks`;
    const created = await j(await post(base, { start: 1.5, end: 2.5, kind: 'remove', note: 'bỏ đoạn này' }));
    expect(created.mark).toMatchObject({ status: 'draft', kind: 'remove', planVersion: 1 });
    expect((await post(base, { start: 3, kind: 'text', note: 'sửa chữ' })).status).toBe(200);
    expect((await post(base, { start: 3, kind: 'nope' })).status).toBe(400);
    expect((await post(base, { start: 3, end: 1, kind: 'text' })).status).toBe(400);
    const upd = await j(await patch(`${base}/${created.mark.id}`, { note: 'đổi ghi chú', end: null }));
    expect(upd.mark.note).toBe('đổi ghi chú');
    expect(upd.mark.end).toBeUndefined();
    expect((await j(await app.request(base))).marks).toHaveLength(2);

    director.mockImplementationOnce(async () => {
      await post(`/edit/agent/projects/${project.id}/plan`, {
        plan: { cutWords: [2], gapMs: 250, meta: { title: 'T', caption: '', hashtags: [] } },
        note: `[mark:${created.mark.id}] đã bỏ`,
      });
      return { text: 'Xong', durationMs: 1, activity: [] };
    });
    const sent = await post(`${base}/send`);
    expect(sent.status).toBe(200);
    expect(await j(sent)).toMatchObject({ ok: true, sent: 2 });
    expect((await patch(`${base}/${created.mark.id}`, { note: 'x' })).status).toBe(409);
    expect((await post(`${base}/send`)).status).toBe(409);

    await runAll();
    expect(director).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'marks' }));
    const marks = (await j(await app.request(base))).marks;
    expect(marks.find((m: any) => m.id === created.mark.id).status).toBe('resolved');
    expect(marks.filter((m: any) => m.status === 'sent')).toHaveLength(1);
    expect((await app.request(`${base}/zzz`, { method: 'DELETE' })).status).toBe(404);
    expect((await j(await app.request(`${base}/${created.mark.id}`, { method: 'DELETE' }))).ok).toBe(true);
  });

  it('stores the brief on the project and in brief.json', async () => {
    const { project } = await seed();
    const url = `/edit/projects/${project.id}/brief`;
    const res = await send('PUT', url, { brief: { product: 'Hub 8in1', price: '490000', points: ['100W', '4K'] } });
    expect((await j(res)).brief.product).toBe('Hub 8in1');
    expect((await j(await app.request(url))).brief.points).toEqual(['100W', '4K']);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'projects', project.id, 'brief.json'), 'utf8')).price).toBe('490000');
    expect((await getProject(project.id)).brief).toMatchObject({ product: 'Hub 8in1' });
    expect((await send('PUT', url, { brief: { a: 5 } })).status).toBe(400);
  });

  it('feedback appends a rule to the profile taste once and accepts chosenCover on the project', async () => {
    const { profile, project } = await seed();
    const url = `/edit/projects/${project.id}/feedback`;
    const less = await j(await post(url, { quick: 'less-effects' }));
    expect(less.rule).toContain('Bớt hiệu ứng');
    expect(less.profile.taste).toContain('## Luật đã ghi nhớ');
    const again = await j(await post(url, { quick: 'less-effects' }));
    expect(again.rule).toBeUndefined();
    await post(url, { quick: 'fix', note: 'chữ 3 NĂM nhỏ lại' });
    const taste = (await j(await patch(`/edit/profiles/${profile.id}`, {}))).profile.taste as string;
    expect(taste).toContain('Cần sửa: chữ 3 NĂM nhỏ lại');
    expect((await post(url, { quick: 'bad' })).status).toBe(400);
    const res = await patch(`/edit/projects/${project.id}`, { chosenCover: 2 });
    expect((await j(res)).project.chosenCover).toBe(2);
    expect((await j(await patch(`/edit/projects/${project.id}`, { chosenCover: null }))).project.chosenCover).toBeUndefined();
    expect((await patch(`/edit/projects/${project.id}`, { chosenCover: 4 })).status).toBe(400);
  });

  it('appendTasteRule keeps one heading and dedupes', () => {
    const a = appendTasteRule('Thích: nhanh', 'Không nhạc buồn', '2026-10-14');
    expect(a.taste).toBe('Thích: nhanh\n\n## Luật đã ghi nhớ\n- Không nhạc buồn (2026-10-14)\n');
    const b = appendTasteRule(a.taste, 'Không chữ đỏ', '2026-10-15');
    expect(b.taste.match(/## Luật đã ghi nhớ/g)).toHaveLength(1);
    expect(appendTasteRule(b.taste, 'Không nhạc buồn').added).toBe(false);
  });
});

describe('profile fields', () => {
  it('creates with starter presets and the new fields, validates deliverDir and audio', async () => {
    const res = await post('/edit/profiles', { name: 'Neon', starter: 'neon', seriesName: 'Tập 1', keepWords: ['ClaudeClaw'], audio: { speechRate: 1.1, voiceLufs: -16, musicLufs: -30, finalLufs: -14 } });
    const profile = (await j(res)).profile;
    expect(profile).toMatchObject({ starter: 'neon', seriesName: 'Tập 1', keepWords: ['ClaudeClaw'], audio: { musicLufs: -30 } });
    expect(profile.brand.accent).toBe('#22D3EE');
    const plain = (await j(await post('/edit/profiles', { name: 'Mặc định' }))).profile;
    expect(plain.audio).toEqual({ speechRate: 1, voiceLufs: -16, musicLufs: -34, finalLufs: -15.5 });
    expect(plain.keepWords).toEqual([]);
    const url = `/edit/profiles/${plain.id}`;
    expect((await patch(url, { deliverDir: 'relative/dir' })).status).toBe(400);
    expect((await j(await patch(url, { deliverDir: '/tmp/out', brand: { fontCaption: 'Anton', cardBg: '#111111' }, coverStyle: 'tối giản' }))).profile)
      .toMatchObject({ deliverDir: '/tmp/out', coverStyle: 'tối giản', brand: { fontCaption: 'Anton' } });
    expect((await j(await patch(url, { deliverDir: null }))).profile.deliverDir).toBeUndefined();
    expect((await patch(url, { audio: { speechRate: 5, voiceLufs: -16, musicLufs: -34, finalLufs: -15 } })).status).toBe(400);
  });

  it('migrates phase-0 profile and project files on read', async () => {
    const { profile, project } = await seed();
    const pf = path.join(root, 'profiles', `${profile.id}.json`);
    const old = JSON.parse(fs.readFileSync(pf, 'utf8'));
    delete old.audio; delete old.keepWords;
    fs.writeFileSync(pf, JSON.stringify(old));
    const prf = path.join(root, 'projects', project.id, 'project.json');
    const oldP = JSON.parse(fs.readFileSync(prf, 'utf8'));
    delete oldP.planVersion;
    oldP.steps = oldP.steps.map((s: any, i: number) => (i === 0 ? s : { key: s.key, status: 'unavailable', summary: 'Chờ engine — giai đoạn 1' }));
    fs.writeFileSync(prf, JSON.stringify(oldP));
    const list = (await j(await app.request('/edit/profiles'))).profiles;
    expect(list[0]).toMatchObject({ keepWords: [], audio: { voiceLufs: -16, finalLufs: -15.5 } });
    const p = await getProject(project.id);
    expect(p.planVersion).toBe(0);
    expect(p.steps.every((s) => s.status === 'pending')).toBe(true);
  });
});

describe('internal agent routes', () => {
  it('only answer local requests', async () => {
    const { project } = await seed();
    local = false;
    for (const [m, u] of [['GET', `context`], ['POST', 'plan'], ['POST', 'log'], ['POST', 'frames']] as const) {
      const res = await send(m, `/edit/agent/projects/${project.id}/${u}`, m === 'POST' ? {} : undefined);
      expect(res.status, u).toBe(403);
    }
    expect((await post(`/edit/agent/profiles/${project.profileId}/rule`, { text: 'x' })).status).toBe(403);
    // Without a socket (plain app.request) the default check refuses too.
    const bare = new Hono();
    registerVideoEditRoutes(bare, { root, autoStart: false });
    expect((await bare.request(`/edit/agent/projects/${project.id}/context`)).status).toBe(403);
  });

  it('context, log, plan validation/submission and taste rules', async () => {
    const { profile, project } = await seed();
    await upload(project.id);
    await runAll();
    const base = `/edit/agent/projects/${project.id}`;
    const ctx = await j(await app.request(`${base}/context`));
    expect(ctx).toMatchObject({ planVersion: 1, planStatus: 'waiting_approval', transcript: { words: 9 } });
    expect(ctx.profile.id).toBe(profile.id);
    expect(ctx.paths.projectDir).toContain(project.id);

    expect((await post(`${base}/log`, { step: 'direct', text: 'đã bỏ 1 từ đệm' })).status).toBe(200);
    expect((await getProject(project.id)).steps.find((s) => s.key === 'direct')!.log!.at(-1)!.text).toBe('đã bỏ 1 từ đệm');
    expect((await post(`${base}/log`, { step: 'nope', text: 'x' })).status).toBe(400);

    const bad = await post(`${base}/plan`, { plan: { cutWords: [99] } });
    expect(bad.status).toBe(422);
    expect((await j(bad)).errors[0]).toMatch(/cutWords/);
    const dry = await j(await post(`${base}/plan`, { plan: { cutWords: [2] }, validateOnly: true }));
    expect(dry).toMatchObject({ ok: true, validateOnly: true, version: 2 });
    expect((await getProject(project.id)).planVersion).toBe(1);

    const ok = await j(await post(`${base}/plan`, { plan: { cutWords: [2, 3], meta: { title: 'Tiêu đề', caption: 'c', hashtags: ['a'] } }, note: 'Bỏ thêm' }));
    expect(ok).toMatchObject({ ok: true, saved: true, version: 2, planStatus: 'waiting_approval' });
    expect(ok.changes[0]).toBe('Bỏ thêm');
    const p = await getProject(project.id);
    expect(p).toMatchObject({ planVersion: 2, planStatus: 'waiting_approval' });
    expect(p.plan?.author).toBe('agent');

    const rule = await j(await post(`/edit/agent/profiles/${profile.id}/rule`, { text: 'Không dùng nhạc buồn' }));
    expect(rule).toMatchObject({ ok: true, added: true });
    expect(rule.profile.taste).toContain('Không dùng nhạc buồn');
    expect((await j(await post(`/edit/agent/profiles/${profile.id}/rule`, { text: 'Không dùng nhạc buồn' }))).added).toBe(false);
  });

  it('frames needs a source; a bad plan body is a 4xx', async () => {
    const { project } = await seed();
    const base = `/edit/agent/projects/${project.id}`;
    expect((await post(`${base}/frames`, { at: [1] })).status).toBe(409);
    expect((await post(`${base}/frames`, { at: [] })).status).toBe(400);
    expect((await post(`${base}/plan`, { plan: { cutWords: [] } })).status).toBe(409);
  });
});

describe('uploading a new source resets everything derived', () => {
  it('clears plans, transcript and renders', async () => {
    const { project } = await seed();
    await upload(project.id);
    await runAll();
    expect(fs.existsSync(path.join(root, 'projects', project.id, 'transcript.json'))).toBe(true);
    await upload(project.id);
    await runAll();
    // Versions restart at 1 only if the old plans were wiped.
    expect(fs.readdirSync(path.join(root, 'projects', project.id, 'plans'))).toEqual(['plan.v1.json']);
    expect((await getProject(project.id)).planVersion).toBe(1);
  });
});
