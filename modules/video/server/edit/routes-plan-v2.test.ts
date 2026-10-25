import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findFillers, findRetakes } from './pipeline/analyze.js';
import { registerVideoEditRoutes } from './routes.js';
import type { AnalysisResult, EditPlan, MediaInfo, Transcript, VideoProject } from './types.js';

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

const j = async (res: Response) => (await res.json()) as any;
const send = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = (u: string, b?: unknown) => send('POST', u, b ?? {});
const put = (u: string, b: unknown) => send('PUT', u, b);

const beats = [
  { id: 'b1', anchorWord: 3, duration: 1.2, title: 'Xin *chào* bạn' },
  { id: 'b2', at: 1.5, duration: 0.8, title: 'Hôm nay nói' },
];

/** A project with the automatic plan v1 and an agent plan v2 (beats b1, b2). */
async function seeded(): Promise<VideoProject> {
  const profile = (await j(await post('/edit/profiles', { name: 'Kênh thử' }))).profile;
  const project = (await j(await post('/edit/projects', { profileId: profile.id, styleId: 'kienthuc' }))).project as VideoProject;
  await app.request(`/edit/projects/${project.id}/upload`, { method: 'POST', headers: { 'x-file-name': 'clip.mp4' }, body: Buffer.from('0123456789') });
  reg.pipeline.queue.start();
  await reg.pipeline.queue.idle();
  await agentPlan(project.id, { templateId: 'th-vang', cutWords: [2], beats });
  return project;
}
async function agentPlan(id: string, plan: Record<string, unknown>) {
  const res = await post(`/edit/agent/projects/${id}/plan`, { plan });
  expect(res.status).toBe(200);
  return j(res);
}
const ops = (id: string, baseVersion: number, list: unknown[]) => post(`/edit/projects/${id}/plan/ops`, { baseVersion, ops: list });
const currentPlan = async (id: string) => (await j(await app.request(`/edit/projects/${id}/plan`))) as { plan: EditPlan; planVersion: number; planStatus?: string; versions: number[] };
const overrides = async (id: string) => j(await app.request(`/edit/projects/${id}/overrides`));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-edit-plan-v2-'));
  app = new Hono();
  reg = registerVideoEditRoutes(app, {
    root, autoStart: false, isLocal: () => true,
    probe: (async () => ({ ...INFO })) as never,
    thumbnail: (async (_s: string, d: string) => { fs.writeFileSync(d, 'jpg'); }) as never,
    doctor: (async () => ({ checks: [], ok: 0, total: 0, requiredOk: true })) as never,
    tools: {
      requestApproval: vi.fn(),
      runDirector: (async () => ({ text: 'Đã xem.', durationMs: 1, activity: [] })) as never,
      normalize: (async (i: { outDir: string }) => {
        for (const n of ['master.mp4', 'proxy.mp4', 'audio.wav']) fs.writeFileSync(path.join(i.outDir, n), 'xxxx');
        return { master: path.join(i.outDir, 'master.mp4'), proxy: path.join(i.outDir, 'proxy.mp4'), audio: path.join(i.outDir, 'audio.wav') };
      }) as never,
      transcribe: (async () => TRANSCRIPT) as never,
      analyze: (async (): Promise<AnalysisResult> => ({
        silences: [], fillers: findFillers(TRANSCRIPT.words), retakes: findRetakes(TRANSCRIPT.words), scenes: [], frames: [], createdAt: 'x',
      })) as never,
    },
  });
});

afterEach(() => {
  reg.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('POST /projects/:id/plan/ops', () => {
  it('gathers owner edits into one draft and answers 409 when the base is stale or the agent is busy', async () => {
    const project = await seeded();
    expect(await currentPlan(project.id)).toMatchObject({ planVersion: 2, planStatus: 'waiting_approval', plan: { author: 'agent', planFormat: 2 } });

    const stale = await ops(project.id, 1, [{ op: 'toggleWords', words: [8] }]);
    expect(stale.status).toBe(409);
    expect((await j(stale)).code).toBe('stale');

    const first = await j(await ops(project.id, 2, [{ op: 'add', kind: 'beat', element: { at: 0.2, duration: 0.5, title: 'Một hai' } }]));
    expect(first.plan).toMatchObject({ version: 3, author: 'owner', changes: ['Thêm chữ «Một hai»'] });
    expect(first.project).toMatchObject({ planVersion: 3, planStatus: 'draft' });

    const second = await j(await ops(project.id, 3, [{ op: 'toggleWords', words: [8] }, { op: 'split', id: 'b2', at: 1.9 }]));
    expect(second.plan).toMatchObject({ version: 3, rev: 1 });
    expect(second.plan.beats.map((b: { id: string }) => b.id)).toEqual(['b1', 'b2', 'b2-b', 'b3']);
    const now = await currentPlan(project.id);
    expect(now).toMatchObject({ planVersion: 3, planStatus: 'draft', versions: [1, 2, 3], plan: { rev: 1 } });
    expect(now.plan.changes).toEqual(expect.arrayContaining(['Thêm chữ «Một hai»', 'Bỏ 1 từ: «nói»']));

    const ai = await ops(project.id, 3, [{ op: 'remove', id: 'b1' }]);
    expect(ai.status).toBe(400);
    expect((await j(ai)).code).toBe('invalid_op');
    expect((await ops(project.id, 3, [{ op: 'remove', id: 'gone' }])).status).toBe(409);
    expect((await ops(project.id, 3, [{ op: 'jump' }])).status).toBe(400);
    expect((await ops(project.id, 3, [])).status).toBe(400);

    reg.store.updateProject(project.id, (p) => { p.busy = true; });
    const busy = await ops(project.id, 3, [{ op: 'toggleWords', words: [7] }]);
    expect(busy.status).toBe(409);
    expect((await j(busy)).code).toBe('busy');
  });

  it('a no-op saves nothing', async () => {
    const project = await seeded();
    const res = await j(await ops(project.id, 2, [{ op: 'restore', id: 'b1', fromVersion: 2 }]));
    expect(res.plan).toMatchObject({ version: 2, author: 'agent' });
    expect((await currentPlan(project.id)).versions).toEqual([1, 2]);
  });
});

describe('GET/PUT /projects/:id/overrides', () => {
  it('merges per element, refuses unknown elements and keeps the AI out', async () => {
    const project = await seeded();
    const url = `/edit/projects/${project.id}/overrides`;
    expect(await overrides(project.id)).toMatchObject({ overrides: { version: 1, elements: {} }, dropped: [] });

    await put(url, { elements: { b1: { t: [3, 4] } } });
    const merged = await j(await put(url, { elements: { b1: { text: { title: 'Sửa *tay*' } } }, captions: { fill: '#ffffff' } }));
    expect(merged.overrides.elements.b1).toMatchObject({ t: [3, 4], text: { title: 'Sửa *tay*' } });
    expect(merged.overrides.captions).toEqual({ fill: '#ffffff' });
    const file = JSON.parse(fs.readFileSync(path.join(root, 'projects', project.id, 'overrides.json'), 'utf8'));
    expect(file.elements.b1.t).toEqual([3, 4]);

    const unknown = await put(url, { elements: { nope: { s: 1.2 } } });
    expect(unknown.status).toBe(409);
    expect((await j(unknown)).code).toBe('no_element');
    expect((await put(url, { elements: { nope: null } })).status).toBe(200);
    expect((await put(url, { elements: { b1: { t: [500, 0] } } })).status).toBe(400);
    expect((await put(url, { elements: { b1: { color: 'red' } } })).status).toBe(400);

    // An AI revision that drops b1: listed as dropped, the override itself untouched.
    await agentPlan(project.id, { templateId: 'th-vang', cutWords: [2], beats: [beats[1]] });
    const after = await overrides(project.id);
    expect(after.dropped).toEqual([{ id: 'b1', kind: 'beat', label: 'Xin chào bạn', fromVersion: 2 }]);
    expect(after.overrides.elements.b1.t).toEqual([3, 4]);

    // Restored by the owner: it is the owner's now and survives the next AI revision.
    const restored = await j(await ops(project.id, 3, [{ op: 'restore', id: 'b1', fromVersion: 2 }]));
    expect(restored.plan.beats.find((b: { id: string }) => b.id === 'b1')).toMatchObject({ origin: 'owner' });
    expect((await overrides(project.id)).dropped).toEqual([]);
    const revised = await agentPlan(project.id, { templateId: 'th-vang', cutWords: [2], beats: [beats[1]] });
    expect(revised.changes).toEqual(expect.arrayContaining(['Giữ chữ bạn đã thêm: «Xin chào bạn»']));
    expect((await currentPlan(project.id)).plan.beats!.map((b) => b.id)).toEqual(['b2', 'b1']);
  });

  it('removing an owner element takes its override away; splitting shares it', async () => {
    const project = await seeded();
    const url = `/edit/projects/${project.id}/overrides`;
    await ops(project.id, 2, [{ op: 'add', kind: 'beat', element: { at: 0.2, duration: 1, title: 'Một hai' } }]);
    await put(url, { elements: { b3: { s: 1.3 }, b2: { t: [1, 2] } } });
    await ops(project.id, 3, [{ op: 'split', id: 'b2', at: 1.9 }, { op: 'remove', id: 'b3' }]);
    const doc = (await overrides(project.id)).overrides;
    expect(Object.keys(doc.elements).sort()).toEqual(['b2', 'b2-b']);
    expect(doc.elements['b2-b'].t).toEqual([1, 2]);
  });
});

describe('GET /projects/:id/composition/preview.html (template plan)', () => {
  it('builds the plan from the template blocks with the latest overrides, rebuilt on every request', async () => {
    const project = await seeded();
    const url = `/edit/projects/${project.id}/composition/preview.html`;
    const before = await (await app.request(url)).text();
    expect(before).toContain('data-el-id="b1"');
    expect(before).toContain('data-el-id="b2"');
    expect(before).toContain('data-composition-id="text-beat"');

    await put(`/edit/projects/${project.id}/overrides`, { elements: { b1: { text: { title: 'Sửa *tay*' }, t: [2, 3] }, b2: { hidden: true } } });
    const after = await (await app.request(url)).text();
    expect(after).toContain('&quot;title&quot;:&quot;Sửa *tay*&quot;');
    expect(after).toContain('var OV=[{"id":"b1","t":[2,3]}];');
    expect(after).not.toContain('data-el-id="b2"');

    // The block file is written into the project's composition folder, so the assets route serves it.
    const name = /data-composition-src="assets\/([^"]+)"/.exec(after)![1];
    const block = await app.request(`/edit/projects/${project.id}/composition/assets/${name}`);
    expect(block.status).toBe(200);
    expect(block.headers.get('content-type')).toContain('text/html');
    expect(await block.text()).toContain('data-composition-id="text-beat"');
  });
});
