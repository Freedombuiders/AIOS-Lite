// Dựng nhanh end to end through the HTTP routes: a quick project uploads early and waits for AI edit; AI edit
// runs the real director turn (prompt, JSON plan, checks) with a fake agent, the Asset Hub fills the B-roll slot
// left as a query from a fake Pexels scored by the same fake agent; the owner edits by hand (overrides, an
// added element), an AI revise drops an edited element, the owner restores it, and only Xuất renders.
// Fake tools (no ffmpeg, whisper or HyperFrames), fake agent, fake Pexels: nothing leaves the machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDirectorTurn, type LeanTurn } from './agent/director.js';
import { setAssetHubDeps } from './assets/hub.js';
import { indexQueueIdle, resetIndexQueue, stopAutoIndex } from './assets/indexer.js';
import { CAPTION_REPLY, fakePexels, pexelsVideo, scoredCaptions, type FakePexels } from './assets/testkit.js';
import { addFile, assetFilePath, clearLibraryCache, findAsset, setLibraryDeps, type LibraryAsset } from './library/store.js';
import { findFillers, findRetakes } from './pipeline/analyze.js';
import { registerVideoEditRoutes } from './routes.js';
import type { AnalysisResult, AssetKind, DroppedElement, EditPlan, MediaInfo, OverridesDoc, QuickSettings, Transcript, VideoProject } from './types.js';

const MODULE_DIR = path.resolve(__dirname, '../..');
const INFO: MediaInfo = { fileName: 'raw.mp4', sizeBytes: 12, durationSec: 8, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', hasAudio: true };

const WORDS: [string, number, number][] = [
  ['Sáng', 0.2, 0.5], ['nào', 0.5, 0.8], ['ờ', 0.9, 1.2], ['mình', 1.3, 1.5], ['cũng', 1.5, 1.7], ['pha', 1.7, 2.0], ['cà', 2.0, 2.2],
  ['phê', 2.2, 2.5], ['rồi', 2.7, 2.9], ['mở', 2.9, 3.1], ['máy', 3.1, 3.3], ['tính', 3.3, 3.6], ['làm', 3.8, 4.0], ['việc', 4.0, 4.3],
  ['ba', 4.6, 4.8], ['bước', 4.8, 5.1], ['đầu', 5.1, 5.3], ['tiên', 5.3, 5.6], ['là', 5.6, 5.8], ['lên', 5.8, 6.0], ['kế', 6.0, 6.2],
  ['hoạch', 6.2, 6.5], ['rồi', 6.6, 6.8], ['làm', 6.8, 7.0], ['thôi', 7.0, 7.4],
];
const TRANSCRIPT: Transcript = {
  language: 'vi', model: 'fake', durationSec: 8, createdAt: 'x',
  words: WORDS.map(([text, start, end], i) => ({ i, text, start, end })),
};

const HINT = 'rót cà phê lúc sáng sớm';
const EDITED_TITLE = 'Ly *cà phê* đầu ngày';
const REVISE_NOTE = 'Gọn chữ lại, bỏ bớt nhịp đầu';
/** The Pexels clip the fake agent likes (caption from the page slug). */
const LAPTOP = pexelsVideo(101, 'man-opening-laptop', 8);

type QuickBody = Omit<QuickSettings, 'startedAt'>;

let root: string;
let app: Hono;
let reg: ReturnType<typeof registerVideoEditRoutes>;
let pexels: FakePexels;
const calls: string[] = [];
const downloads: string[] = [];
/** Every turn the fake agent answered: the director's and the B-roll scoring. */
const turns: LeanTurn[] = [];
/** Plans handed to the render tool. */
const rendered: EditPlan[] = [];
const requestApproval = vi.fn();
/** Ids the fake director reads off its prompt. */
let footageId = '';
let songId = '';

const j = async (res: Response) => (await res.json()) as any;
const send = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = (u: string, b?: unknown) => send('POST', u, b ?? {});
const put = (u: string, b: unknown) => send('PUT', u, b);
const getProject = async (id: string) => (await j(await app.request(`/edit/projects/${id}`))).project as VideoProject;
const getPlan = async (id: string) => (await j(await app.request(`/edit/projects/${id}/plan`))).plan as EditPlan;
const getOverrides = async (id: string) => (await j(await app.request(`/edit/projects/${id}/overrides`))) as { overrides: OverridesDoc; dropped: DroppedElement[] };
const runAll = async () => { reg.pipeline.queue.start(); await reg.pipeline.queue.idle(); };
const step = (p: VideoProject, key: string) => p.steps.find((s) => s.key === key)!;
const directorPrompts = () => turns.filter((t) => t.title.startsWith('Video:')).map((t) => t.prompt);
const touch = (file: string, data = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

/** A library file with the Asset Hub index already done (caption, beats), so nothing indexes in the background. */
async function addAsset(kind: AssetKind, fileName: string, extra: Partial<LibraryAsset> = {}): Promise<LibraryAsset> {
  const temp = path.join(root, 'scratch', fileName);
  touch(temp, `fake ${fileName}`);
  const asset = await addFile(root, { kind, tempPath: temp, fileName });
  const manifestFile = path.join(root, 'library', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  Object.assign(manifest.entries[asset.id], { indexedAt: '2026-10-25T00:00:00.000Z', ...extra });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  clearLibraryCache(root);
  return findAsset(root, asset.id)!;
}

/** The director's first plan v2: two beats, a steps scene, the owner's footage and a slot to find on Pexels. */
function firstPlan() {
  return {
    planFormat: 2, templateId: 'th-vang', autoCut: true, styleId: 'kienthuc', aspect: '9:16',
    summary: 'Bỏ tiếng ờ, chữ vàng theo nhịp nói, một cảnh ba bước, cảnh trám từ tư liệu và một cảnh tìm thêm.',
    cutWords: [2], gapMs: 400,
    beats: [
      { id: 'b1', component: 'text-beat', anchorWord: 3, duration: 2, kicker: 'MỖI SÁNG', title: 'Pha *cà phê*', animIn: 'slide-up' },
      { id: 'b2', component: 'text-beat', anchorWord: 12, duration: 1.5, title: 'Rồi *làm việc*', animIn: 'pop' },
    ],
    scenes: [
      { id: 's1', component: 'scene-steps', anchorWord: 14, duration: 3, animIn: 'fade', props: { step: 0, title: 'Ba *bước*', items: ['Lên kế hoạch', 'Làm thôi'] } },
    ],
    brolls: [
      { id: 'br1', anchorWord: 5, duration: 1.5, title: 'Rót cà phê', reason: "khi nói 'pha cà phê'", source: 'upload', assetId: footageId, hint: HINT, layout: 'card', enabled: true },
      {
        id: 'br2', anchorWord: 9, duration: 2, title: 'Mở laptop', reason: "khi nói 'mở máy tính'", source: 'pexels', layout: 'pip-circle', enabled: true,
        query: { description: 'người mở laptop ở bàn làm việc', keywords: ['laptop', 'office', 'working'] },
      },
    ],
    captions: { styleId: 'bottom-clean', position: 'bottom', highlight: ['cà phê', 'ba bước'], maxWordsPerChunk: 3 },
    music: { assetId: songId, mood: 'Tập trung', gainDb: -18, duck: true },
    covers: [{ frameAt: 2.1, title: 'Sáng nào cũng vậy' }],
    meta: { title: 'Ba bước làm việc mỗi sáng', caption: 'Mỗi sáng của mình bắt đầu thế này.', hashtags: ['#lamviec'] },
  };
}

/** A revise turn that rewrites from the current plan and loses beat b1 (and leaves the owner's element out). */
function revisedPlan(projectId: string) {
  const project = reg.store.loadProject(projectId)!;
  const current = reg.store.loadPlan(projectId, project.planVersion)!;
  const ai = <T extends { origin?: string }>(list: T[] | undefined) => (list ?? []).filter((x) => x.origin !== 'owner');
  return {
    planFormat: 2, templateId: current.templateId, autoCut: true, styleId: current.styleId, aspect: current.aspect,
    summary: 'Gọn chữ lại theo góp ý: bỏ nhịp chữ đầu, giữ cảnh ba bước và hai cảnh trám.',
    cutWords: current.cutWords, gapMs: current.gapMs,
    beats: ai(current.beats).filter((b) => b.id !== 'b1'),
    scenes: ai(current.scenes), graphics: ai(current.graphics), brolls: ai(current.brolls), zooms: ai(current.zooms),
    captions: current.captions, music: current.music, covers: current.covers, meta: current.meta,
    changes: ['Chữ: bỏ nhịp "Pha cà phê"'],
  };
}

/** The fake agent: answers the director turns with a JSON plan, and scores B-roll candidates by caption. */
async function agent(turn: LeanTurn): Promise<{ ok: boolean; output: string; error?: string }> {
  turns.push(turn);
  if (turn.title.startsWith('Chấm cảnh trám')) {
    const scores = scoredCaptions(turn.prompt).map((caption, i) => ({ n: i + 1, score: caption === 'man opening laptop' ? 4 : 2, reason: 'thử' }));
    return { ok: true, output: JSON.stringify({ scores }) };
  }
  if (turn.title.startsWith('Mô tả tư liệu')) return { ok: true, output: CAPTION_REPLY };
  if (!turn.title.startsWith('Video:')) return { ok: false, output: '', error: 'không rõ lượt' };
  const projectId = reg.store.listProjects().find((p) => turn.title === `Video: ${p.title}`.slice(0, 80))!.id;
  const plan = turn.prompt.includes(REVISE_NOTE) ? revisedPlan(projectId) : firstPlan();
  return { ok: true, output: `Đã dựng theo mẫu.\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`` };
}

beforeEach(() => {
  calls.length = 0;
  downloads.length = 0;
  turns.length = 0;
  rendered.length = 0;
  requestApproval.mockClear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-quick-e2e-'));
  clearLibraryCache();
  setLibraryDeps({ probeDuration: async () => 30, fontInfo: () => null });
  pexels = fakePexels([LAPTOP]);
  app = new Hono();
  reg = registerVideoEditRoutes(app, {
    root, autoStart: false,
    probe: (async () => ({ ...INFO })) as never,
    thumbnail: (async (_s: string, d: string) => { fs.writeFileSync(d, 'jpg'); }) as never,
    doctor: (async () => ({ checks: [], ok: 0, total: 0, requiredOk: true })) as never,
    tools: {
      requestApproval,
      // The real director turn (prompt, reply parsing, plan submit); only the agent is fake.
      runDirector: (input) => {
        calls.push(`director:${input.reason}`);
        return runDirectorTurn(input, {
          store: reg.store, projectRoot: MODULE_DIR, run: agent, lessons: () => [],
          frameOf: async (_file, dest) => touch(dest, 'jpg'),
          submitPlan: (id, plan, note) => {
            const r = reg.pipeline.submitAgentPlan(id, plan, note);
            return r.ok ? { ok: true, plan: r.plan } : { ok: false, errors: r.errors };
          },
        });
      },
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
      render: (async (i: { store: any; project: { id: string }; plan: EditPlan }) => {
        calls.push(`render:v${i.plan.version}`);
        rendered.push(i.plan);
        fs.mkdirSync(i.store.rendersDir(i.project.id), { recursive: true });
        fs.writeFileSync(path.join(i.store.rendersDir(i.project.id), `final.v${i.plan.version}.mp4`), 'video');
        return { version: i.plan.version, file: `renders/final.v${i.plan.version}.mp4`, durationSec: i.plan.outputDurationSec, sizeBytes: 5, createdAt: 'x', warnings: [], qaFiles: [] };
      }) as never,
      covers: (async () => { calls.push('covers'); return { files: [] }; }) as never,
    },
  });
  // Library files of this test are indexed up front; nothing indexes behind the assertions.
  stopAutoIndex();
  setAssetHubDeps({
    run: agent,
    seesImages: () => true,
    defaultAgentId: () => 'main',
    pexels: () => pexels,
    download: async (url, dest) => { downloads.push(url); touch(dest, `downloaded ${url}`); },
    frames: async (_file, times, outDir) => times.map((_, i) => { const f = path.join(outDir, `frame-${i + 1}.jpg`); touch(f); return f; }),
    duration: async () => 8,
    pcm: async () => new Float32Array(0),
    spectrogram: async () => false,
  });
});

afterEach(async () => {
  reg.stop();
  await indexQueueIdle();
  resetIndexQueue();
  setAssetHubDeps(null);
  setLibraryDeps(null);
  fs.rmSync(root, { recursive: true, force: true });
});

/** Trang đầu → Thiết lập: a quick project, the video uploaded and read while the owner sets up. */
async function uploadAndRead(): Promise<VideoProject> {
  const profile = (await j(await post('/edit/profiles', { name: 'Kênh cà phê' }))).profile;
  const project = (await j(await post('/edit/projects', { profileId: profile.id, flow: 'quick' }))).project as VideoProject;
  const res = await app.request(`/edit/projects/${project.id}/upload`, { method: 'POST', headers: { 'x-file-name': 'quay-tho.mp4' }, body: Buffer.from('0123456789') });
  expect(res.status).toBe(200);
  await runAll();
  return project;
}

/** Thiết lập → AI edit: template th-vang, one footage with a description, stock search on, music chosen by AI. */
async function pressAiEdit(projectId: string, body: Partial<QuickBody> = {}) {
  const footage = await addAsset('video', 'rot-ca-phe.mp4', { caption: 'Cận cảnh rót cà phê vào cốc trắng', quality: 0.8 });
  const song = await addAsset('bgm', 'sang-som.mp3', { mood: 'Tập trung', bpm: 96, beats: [0.6, 1.9, 3.1, 4.4, 5.6, 6.9], vocals: false, caption: 'Nhạc nhẹ buổi sáng' });
  footageId = footage.id;
  songId = song.id;
  const quick: QuickBody = {
    mode: 'ai', autoCut: true, cutLevel: 'vua', templateId: 'th-vang', assets: [{ assetId: footage.id, hint: HINT }],
    music: { mode: 'ai', duck: true, snapToBeat: false, endOnFinal: false }, stock: true, ...body,
  };
  const res = await post(`/edit/projects/${projectId}/ai-edit`, quick);
  expect(res.status).toBe(200);
  const job = (await j(res)).job;
  await runAll();
  return { footage, song, job };
}

/** The editor: the owner rewrites a beat, swaps the file of the found B-roll and the music, and adds a beat. */
async function editByHand(projectId: string) {
  const other = await addAsset('video', 'ban-lam-viec.mp4', { caption: 'Bàn làm việc gọn gàng có laptop' });
  const song2 = await addAsset('bgm', 'tap-trung.mp3', { mood: 'Tập trung', bpm: 110, beats: [0.5, 1.6, 2.7], vocals: false });
  const res = await put(`/edit/projects/${projectId}/overrides`, {
    elements: { b1: { text: { title: EDITED_TITLE } }, br2: { assetId: other.id } },
    music: { assetId: song2.id },
  });
  expect(res.status).toBe(200);
  const base = (await getProject(projectId)).planVersion;
  const ops = await post(`/edit/projects/${projectId}/plan/ops`, {
    baseVersion: base,
    ops: [{ op: 'add', kind: 'beat', element: { component: 'text-beat', anchorWord: 22, duration: 1.5, title: 'Làm *ngay*' } }],
  });
  expect(ops.status).toBe(200);
  const ownerBeat = ((await j(ops)).plan as EditPlan).beats!.find((b) => b.origin === 'owner')!;
  return { other, song2, ownerBeat, draftVersion: base + 1 };
}

/** One host slot of the composition: its attributes and decoded variable values (as composition-v2.test.ts). */
function slot(html: string, id: string) {
  const tag = new RegExp(`<div id="el-${id}"[^>]*>`).exec(html)?.[0];
  if (!tag) return null;
  const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  const values = JSON.parse((attr('data-variable-values') ?? '{}').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")) as Record<string, unknown>;
  return { tag, attr, values };
}

/** The library file a composition path (`assets/<name>`, a link next to preview.html) points at. */
function linkedFile(projectId: string, rel: unknown): string {
  return fs.realpathSync(path.join(reg.store.compositionDir(projectId), String(rel)));
}
const fileOf = (asset: LibraryAsset) => fs.realpathSync(assetFilePath(root, asset)!);

describe('Dựng nhanh end to end', () => {
  it('uploads early, waits for AI edit, then the director builds plan v2 on the template and the Asset Hub fills the stock slot, without rendering', async () => {
    const project = await uploadAndRead();
    expect(calls).toEqual(['normalize', 'transcribe', 'analyze']);
    let p = await getProject(project.id);
    expect(step(p, 'direct')).toMatchObject({ status: 'waiting', summary: 'Chờ bạn bấm AI edit' });
    expect(p.planVersion).toBe(0);

    const { footage, song, job } = await pressAiEdit(project.id);
    expect(job.kind).toBe('direct');
    expect(calls.slice(3)).toEqual(['director:plan']);

    // The director saw the template, the footage with its description, the shortlist and the owner's settings.
    const [prompt] = directorPrompts();
    expect(prompt).toContain('MẪU EDIT');
    expect(prompt).toContain('scene-steps');
    expect(prompt).toContain(`(assetId ${footage.id}). Chủ kênh mô tả: ${HINT}`);
    expect(prompt).toContain('KHO GỢI Ý');
    expect(prompt).toContain(`\`${song.id}\``);
    expect(prompt).toContain('Tìm thêm cảnh trám ngoài tư liệu: được');
    expect(prompt).not.toContain('Ghi chú phong cách');

    // v1 is the machine plan, v2 the director's, with the stock slot filled in place.
    p = await getProject(project.id);
    expect(p).toMatchObject({ planVersion: 2, planStatus: 'waiting_approval', status: 'waiting_approval' });
    expect(step(p, 'direct').status).toBe('done');
    expect(step(p, 'approve')).toMatchObject({ status: 'waiting', summary: 'Mở editor để chỉnh, bấm Xuất khi xong' });
    const plan = await getPlan(project.id);
    expect(plan).toMatchObject({ author: 'agent', planFormat: 2, templateId: 'th-vang', autoCut: true, cutWords: [2], gapMs: 400 });
    expect(plan.beats!.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(plan.scenes![0]).toMatchObject({ id: 's1', component: 'scene-steps' });
    expect(plan.music).toMatchObject({ assetId: song.id, duck: true });
    expect(plan.brolls[0]).toMatchObject({ id: 'br1', source: 'upload', assetId: footage.id, hint: HINT });

    // br2: owner footage and library scored below 3, the Pexels clip scored 4, downloaded with its licence.
    const br2 = plan.brolls.find((b) => b.id === 'br2')!;
    expect(br2).toMatchObject({ source: 'pexels', layout: 'pip-circle', query: { keywords: ['laptop', 'office', 'working'] } });
    const stock = findAsset(root, br2.assetId!)!;
    expect(stock).toMatchObject({ kind: 'video', license: 'Pexels License', sourceUrl: LAPTOP.url, attribution: 'Video: Ana Lee · Pexels' });
    expect(downloads).toContain(LAPTOP.video_files[0].link);
    expect(pexels.queries[0]).toMatchObject({ kind: 'video', query: 'laptop office working' });
    const scoring = turns.filter((t) => t.title.startsWith('Chấm cảnh trám'));
    expect(scoring.length).toBeGreaterThan(0);
    expect(scoredCaptions(scoring[scoring.length - 1].prompt)).toContain('man opening laptop');
    expect(step(p, 'direct').log!.map((l) => l.text).join('\n')).toContain('Cảnh trám "Mở laptop"');

    // AI edit never renders and never asks for approval.
    expect(calls.some((c) => c.startsWith('render'))).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('hand edits survive an AI revise: the owner element stays, the dropped edit can be restored, and only Xuất renders', async () => {
    const project = await uploadAndRead();
    await pressAiEdit(project.id);
    const aiPlan = await getPlan(project.id);
    const { ownerBeat, draftVersion } = await editByHand(project.id);
    let p = await getProject(project.id);
    expect(p).toMatchObject({ planVersion: draftVersion, planStatus: 'draft' });
    expect(ownerBeat).toMatchObject({ origin: 'owner', title: 'Làm *ngay*' });
    expect(ownerBeat.id).not.toBe('b1');

    // "Nhờ AI sửa": the director is told what the owner edited, and still drops beat b1.
    expect((await post(`/edit/projects/${project.id}/plan/decide`, { action: 'revise', note: REVISE_NOTE })).status).toBe(200);
    await runAll();
    expect(calls).toContain('director:revise');
    const revisePrompt = directorPrompts().find((x) => x.includes(REVISE_NOTE))!;
    expect(revisePrompt).toContain('PHẦN TỬ CHỦ KÊNH ĐÃ SỬA TAY');
    expect(revisePrompt).toMatch(/- b1 \(.*\): sửa chữ/);
    expect(revisePrompt).toContain(`- ${ownerBeat.id} (`);

    p = await getProject(project.id);
    expect(p).toMatchObject({ planVersion: draftVersion + 1, planStatus: 'waiting_approval' });
    const revised = await getPlan(project.id);
    expect(revised.author).toBe('agent');
    expect(revised.beats!.map((b) => b.id)).not.toContain('b1');
    // The machine put the owner's beat back, untouched.
    expect(revised.beats!.find((b) => b.id === ownerBeat.id)).toMatchObject({ origin: 'owner', title: 'Làm *ngay*' });
    expect(revised.brolls.find((b) => b.id === 'br2')!.assetId).toBe(aiPlan.brolls.find((b) => b.id === 'br2')!.assetId);

    // The owner's edits are where they were; the edit whose element the AI dropped is reported.
    let o = await getOverrides(project.id);
    expect(o.overrides.elements.b1.text).toEqual({ title: EDITED_TITLE });
    expect(o.overrides.elements.br2.assetId).toBeTruthy();
    expect(o.overrides.music).toMatchObject({ assetId: expect.any(String) });
    expect(o.dropped).toEqual([{ id: 'b1', kind: 'beat', label: expect.any(String), fromVersion: draftVersion }]);
    expect(calls.some((c) => c.startsWith('render'))).toBe(false);

    // "Khôi phục": b1 comes back as the owner's, with the owner's words in the preview.
    const restore = await post(`/edit/projects/${project.id}/plan/ops`, { baseVersion: draftVersion + 1, ops: [{ op: 'restore', id: 'b1', fromVersion: draftVersion }] });
    expect(restore.status).toBe(200);
    const restored = (await j(restore)).plan as EditPlan;
    expect(restored.beats!.find((b) => b.id === 'b1')).toMatchObject({ origin: 'owner', title: 'Pha *cà phê*' });
    o = await getOverrides(project.id);
    expect(o.dropped).toEqual([]);

    const preview = await app.request(`/edit/projects/${project.id}/composition/preview.html`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    for (const id of ['b1', 'b2', ownerBeat.id, 's1', 'br1', 'br2']) expect(html).toContain(`data-el-id="${id}"`);
    expect(slot(html, 'b1')!.values).toMatchObject({ title: EDITED_TITLE, kicker: 'MỖI SÁNG' });
    expect(slot(html, ownerBeat.id)!.attr('data-composition-id')).toBe('text-beat');
    // Block variables are strings: a list prop goes in one item per line.
    expect(slot(html, 's1')!.values).toMatchObject({ items: 'Lên kế hoạch\nLàm thôi' });
    expect(slot(html, 'br2')!.values.layout).toBe('pip-circle');
    expect(calls.some((c) => c.startsWith('render'))).toBe(false);

    // Xuất: only now a render job, of the version the owner sees.
    const xuat = await post(`/edit/projects/${project.id}/plan/decide`, { action: 'approve' });
    expect(xuat.status).toBe(200);
    expect((await j(xuat)).job.kind).toBe('render');
    await runAll();
    expect(calls.filter((c) => c.startsWith('render'))).toEqual([`render:v${restored.version}`]);
    expect(rendered[0].beats!.map((b) => b.id)).toEqual(expect.arrayContaining(['b1', 'b2', ownerBeat.id]));
    expect(await getProject(project.id)).toMatchObject({ status: 'done', planStatus: 'approved' });
  });

  // Needs composition-v2 to apply the owner's file swap (ElementOverride.assetId) and OverridesDoc.music (T4b).
  it('the preview plays the B-roll file and the music the owner swapped in', async () => {
    const project = await uploadAndRead();
    const { song } = await pressAiEdit(project.id);
    const found = findAsset(root, (await getPlan(project.id)).brolls.find((b) => b.id === 'br2')!.assetId!)!;
    const { other, song2 } = await editByHand(project.id);

    const preview = await app.request(`/edit/projects/${project.id}/composition/preview.html`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    // Soft: a miss on the B-roll still reports the music.
    const br2 = slot(html, 'br2')!;
    expect.soft(linkedFile(project.id, br2.values.video)).toBe(fileOf(other));
    expect.soft(linkedFile(project.id, br2.values.video)).not.toBe(fileOf(found));
    const music = /<audio id="music"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
    expect(music).toBeDefined();
    expect.soft(linkedFile(project.id, music)).toBe(fileOf(song2));
    expect.soft(linkedFile(project.id, music)).not.toBe(fileOf(song));
  });
});
