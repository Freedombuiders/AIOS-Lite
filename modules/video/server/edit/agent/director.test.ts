import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./approval-handler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./approval-handler.js')>()),
  requestVideoPlanApproval: vi.fn(() => null),
}));

import { bindModuleCtx } from '../../host.js';
import { fakeCtx } from '../../test-ctx.js';
import { addFile } from '../library/store.js';
import { createVideoEditStore, type VideoEditStore } from '../store.js';
import type { EditPlan } from '../types.js';
import { requestVideoPlanApproval } from './approval-handler.js';
import { buildDirectorPrompt, loadDirectorContext, loadDirectorData, runDirectorTurn, stripJsonBlocks, type DirectorData, type LeanRun, type LeanTurn, type SubmitPlanResult } from './director.js';

let tmp: string;
let store: VideoEditStore;
let projectId: string;
let turns: LeanTurn[];

const reply = (output: string): LeanRun => async (turn) => { turns.push(turn); return { ok: true, output }; };

function plan(version: number): EditPlan {
  return {
    version, createdAt: 'now', styleId: 'kienthuc', aspect: '9:16', summary: 'Kế hoạch thử.', sourceDurationSec: 70, outputDurationSec: 50,
    cutWords: [1, 2], gapMs: 400, keep: [], removed: [], brolls: [],
    captions: { styleId: 'c', position: 'bottom', highlight: [], maxWordsPerChunk: 4 },
    overlays: [], zooms: [], sfx: [], covers: [], meta: { title: 't', caption: 'c', hashtags: [] }, author: 'agent',
  };
}

const PLAN_REPLY = 'Đã lên kế hoạch, bỏ 2 từ đệm.\n```json\n{"cutWords":[1,2],"gapMs":400}\n```';
const okSubmit = (): ((id: string, p: unknown, note?: string) => SubmitPlanResult) => vi.fn((_id, _p) => ({ ok: true as const, plan: plan(1) }));

beforeEach(() => {
  turns = [];
  vi.mocked(requestVideoPlanApproval).mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-director-'));
  bindModuleCtx(fakeCtx({ agents: [{ id: 'vtest', runtime: 'claude' }] }));
  store = createVideoEditStore(path.join(tmp, 'video-edit'));
  const profile = store.createProfile({ name: 'Kênh Thử' });
  store.saveProfile({ ...profile, keepWords: ['FreedomOS'], taste: 'Không dùng chữ đỏ.', audio: { speechRate: 1, voiceLufs: -16, musicLufs: -34, finalLufs: -15.5 } });
  const project = store.createProject({ profileId: profile.id, title: 'Video thử', styleId: 'kienthuc', agentId: 'vtest' });
  projectId = project.id;
  store.updateProject(projectId, (p) => {
    p.source = { fileName: 'raw.mp4', sizeBytes: 1, durationSec: 70, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', hasAudio: true };
    p.targetSeconds = 60;
  });
  const dir = store.projectDir(projectId);
  const words = Array.from({ length: 160 }, (_, i) => ({ i, text: ` w${i}`, start: i * 0.4, end: i * 0.4 + 0.3 }));
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify({ language: 'vi', durationSec: 70, words }));
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify({ silences: [{ start: 1, end: 2 }], fillers: [], retakes: [], scenes: [], frames: [{ at: 1, file: 'frames/a.jpg' }], createdAt: 'now' }));
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'frames', 'a.jpg'), 'jpg');
});
afterEach(() => { bindModuleCtx(undefined); fs.rmSync(tmp, { recursive: true, force: true }); });

const abort = () => new AbortController();

describe('runDirectorTurn: lean turn', () => {
  it('sends one lean turn with the transcript, analysis and a frame image, then submits the JSON plan', async () => {
    const submitPlan = okSubmit();
    const r = await runDirectorTurn({ projectId, reason: 'plan', abortController: abort() }, { store, run: reply(PLAN_REPLY), submitPlan, projectRoot: '/nonexistent' });
    expect(r.error).toBeUndefined();
    expect(turns).toHaveLength(1);
    expect(turns[0].agentId).toBe('vtest');
    expect(turns[0].prompt).toContain('LỜI CHÉP:');
    expect(turns[0].prompt).toContain('w10[10]');
    expect(turns[0].prompt).toContain('PHÂN TÍCH MÁY');
    expect(turns[0].images).toEqual([path.join(store.projectDir(projectId), 'frames', 'a.jpg')]);
    expect(submitPlan).toHaveBeenCalledWith(projectId, { cutWords: [1, 2], gapMs: 400 }, expect.any(String));
    expect(r.text).toBe('Đã lên kế hoạch, bỏ 2 từ đệm.');
    expect(r.activity.map((a) => a.label)).toContain('Đã nộp kế hoạch');
    expect(requestVideoPlanApproval).toHaveBeenCalledTimes(1);
  });

  it('reports invalid plans from the validator and asks for no approval', async () => {
    const submitPlan = vi.fn(() => ({ ok: false as const, errors: ['cutWords ngoài lời chép'] }));
    const r = await runDirectorTurn({ projectId, reason: 'plan', abortController: abort() }, { store, run: reply(PLAN_REPLY), submitPlan });
    expect(r.error).toContain('cutWords ngoài lời chép');
    expect(requestVideoPlanApproval).not.toHaveBeenCalled();
  });

  it('fails a plan turn that returns no JSON plan', async () => {
    const r = await runDirectorTurn({ projectId, reason: 'plan', abortController: abort() }, { store, run: reply('Mình nghĩ nên cắt bớt.'), submitPlan: okSubmit() });
    expect(r.error).toContain('khối JSON');
  });

  it('appends a profile rule from a {"rule"} block', async () => {
    await runDirectorTurn({ projectId, reason: 'chat', note: 'đừng dùng chữ đỏ', abortController: abort() }, { store, run: reply('Đã ghi.\n```json\n{"rule":"Không dùng chữ đỏ ở hook"}\n```'), submitPlan: okSubmit() });
    const taste = store.getProfile(store.loadProject(projectId)!.profileId)!.taste;
    expect(taste).toContain('- Không dùng chữ đỏ ở hook');
    expect(requestVideoPlanApproval).not.toHaveBeenCalled();
  });

  it('a chat reply without a plan is just text', async () => {
    const submitPlan = okSubmit();
    const r = await runDirectorTurn({ projectId, reason: 'chat', note: 'sao lại cắt?', abortController: abort() }, { store, run: reply('Vì đoạn đó lặp ý.'), submitPlan });
    expect(r.text).toBe('Vì đoạn đó lặp ý.');
    expect(r.error).toBeUndefined();
    expect(submitPlan).not.toHaveBeenCalled();
    expect(requestVideoPlanApproval).not.toHaveBeenCalled();
  });

  it('asks for approval after plan, revise and marks turns but not after chat', async () => {
    for (const reason of ['plan', 'revise', 'marks'] as const) {
      await runDirectorTurn({ projectId, reason, note: 'x', abortController: abort() }, { store, run: reply(PLAN_REPLY), submitPlan: okSubmit() });
    }
    expect(requestVideoPlanApproval).toHaveBeenCalledTimes(3);
  });

  it('puts lessons into the prompt', async () => {
    await runDirectorTurn({ projectId, reason: 'plan', abortController: abort() }, { store, run: reply(PLAN_REPLY), submitPlan: okSubmit(), lessons: () => ['[Hook 3 giây · bai-hoc.md]\nMở bằng con số.'] });
    expect(turns[0].prompt).toContain('BÀI HỌC TÌM ĐƯỢC');
    expect(turns[0].prompt).toContain('Mở bằng con số.');
  });

  it('hands attachments from the library to the prompt', async () => {
    const tempPath = path.join(tmp, 'paste.png');
    fs.writeFileSync(tempPath, 'png');
    const asset = await addFile(store.root, { kind: 'image', tempPath, fileName: 'image.png' });
    await runDirectorTurn({
      projectId, reason: 'chat', note: 'đây là ảnh gì', abortController: abort(),
      attachments: [{ kind: 'asset', ref: asset.id, label: 'image' }, { kind: 'asset', ref: 'lib:image:gone', label: 'cũ' }],
    }, { store, run: reply('Ảnh logo.'), submitPlan: okSubmit() });
    const prompt = turns[0].prompt;
    expect(prompt).toContain('Chủ kênh đính kèm từ Kho:');
    expect(prompt).toContain(`(assetId ${asset.id}): ${path.join(store.root, 'library', asset.file!)}`);
    expect(prompt).toContain('(assetId lib:image:gone): không còn file trong kho');
  });

  it('streams the reply to onDelta and reports activity', async () => {
    const deltas: string[] = [];
    const rows: string[] = [];
    await runDirectorTurn({ projectId, reason: 'chat', note: 'hi', abortController: abort(), onDelta: (t) => deltas.push(t), onActivity: (l) => rows.push(l) }, { store, run: reply('Xin chào'), submitPlan: okSubmit() });
    expect(deltas).toEqual(['Xin chào']);
    expect(rows).toContain('Đạo diễn đang làm việc');
  });
});

describe('runDirectorTurn: outcomes', () => {
  it('reports an agent failure and does not request approval', async () => {
    const run: LeanRun = async () => ({ ok: false, output: '', error: 'hết ngân sách' });
    const r = await runDirectorTurn({ projectId, reason: 'plan', abortController: abort() }, { store, run, submitPlan: okSubmit() });
    expect(r.error).toContain('hết ngân sách');
    expect(requestVideoPlanApproval).not.toHaveBeenCalled();
  });

  it('times out with a clear message (VIDEO_EDIT_TURN_TIMEOUT_MS)', async () => {
    process.env.VIDEO_EDIT_TURN_TIMEOUT_MS = '1000';
    try {
      const run: LeanRun = (turn) => new Promise((_resolve, reject) => turn.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
      const r = await runDirectorTurn({ projectId, reason: 'plan', abortController: abort() }, { store, run, submitPlan: okSubmit() });
      expect(r.error).toContain('quá thời gian');
    } finally {
      delete process.env.VIDEO_EDIT_TURN_TIMEOUT_MS;
    }
  });

  it('an owner abort is reported as a stop, not a timeout', async () => {
    const ac = abort();
    const run: LeanRun = async () => { ac.abort(); throw new Error('aborted'); };
    const r = await runDirectorTurn({ projectId, reason: 'plan', abortController: ac }, { store, run, submitPlan: okSubmit() });
    expect(r.error).toBe('Đã dừng theo yêu cầu.');
  });

  it('fails clearly for an unknown project', async () => {
    const r = await runDirectorTurn({ projectId: '00000000-0000-4000-8000-000000000000', reason: 'plan', abortController: abort() }, { store, run: reply(PLAN_REPLY), submitPlan: okSubmit() });
    expect(r.error).toContain('Không tìm thấy');
    expect(turns).toHaveLength(0);
  });

  it('stripJsonBlocks removes fenced blocks only', () => {
    expect(stripJsonBlocks('a\n```json\n{}\n```\nb')).toBe('a\n\nb');
  });

  it('loadDirectorData numbers the transcript words and caps long text', () => {
    const ctx = loadDirectorContext(store, projectId)!;
    const d = loadDirectorData(store, ctx, '/nonexistent');
    expect(d.transcript).toContain('@0-');
    expect(d.transcript).toContain('w3[3]');
    expect(d.analysis).toContain('silences');
    expect(d.styles).toContain('kienthuc');
  });
});

describe('director prompt', () => {
  const data = (over: Partial<DirectorData> = {}): DirectorData => ({ transcript: '# vi · 70s · 160 từ\n@0-3 0s-1s | xin[0] chào[1]', analysis: '{"silences":[]}', planJson: null, styles: 'kienthuc (/kienthuc): Kiến thức nhanh', lessons: [], schemaRef: 'TÀI LIỆU', ...over });

  function ctxWith(planVersion = 0) {
    if (planVersion) {
      store.updateProject(projectId, (p) => { p.plan = plan(planVersion); p.planVersion = planVersion; p.planStatus = 'waiting_approval'; });
    }
    return loadDirectorContext(store, projectId)!;
  }

  it('carries the project, style, profile taste, keep words and the machine analysis', () => {
    const p = buildDirectorPrompt({ reason: 'plan', ctx: ctxWith(), data: data() });
    expect(p).toContain('VID-0001');
    expect(p).toContain('Kiến thức nhanh');
    expect(p).toContain('mục tiêu 60s');
    expect(p).toContain('Không dùng chữ đỏ.');
    expect(p).toContain('FreedomOS');
    expect(p).toContain('KHÔNG "sửa chính tả"');
    expect(p).toContain('1 chỗ lặng');
    expect(p).toContain('chỉ số từ 0 đến 159');
    expect(p).toContain('khối ```json');
    expect(p).toContain('LỜI CHÉP:');
    expect(p).toContain('Tự kiểm 3 lượt');
    expect(p).not.toContain('video-cli');
  });

  it('revise puts the owner note and the current plan in the prompt', () => {
    const p = buildDirectorPrompt({ reason: 'revise', note: 'Hook ngắn hơn', ctx: ctxWith(2), data: data({ planJson: JSON.stringify(plan(2)) }) });
    expect(p).toContain('Hook ngắn hơn');
    expect(p).toContain('KẾ HOẠCH HIỆN TẠI: v2');
    expect(p).toContain('0:50');
    expect(p).toContain('KẾ HOẠCH HIỆN TẠI (JSON)');
  });

  it('marks lists open marks with their ids and skips resolved ones', () => {
    const dir = store.projectDir(projectId);
    fs.writeFileSync(path.join(dir, 'marks.json'), JSON.stringify([
      { id: 'm-open', projectId, planVersion: 2, start: 12.4, end: 14, kind: 'remove', note: 'bỏ đoạn này', status: 'sent', createdAt: 'x' },
      { id: 'm-done', projectId, planVersion: 2, start: 3, kind: 'text', note: 'đã xong', status: 'resolved', createdAt: 'x' },
    ]));
    const p = buildDirectorPrompt({ reason: 'marks', ctx: ctxWith(2), data: data() });
    expect(p).toContain('[mark:m-open] 12.4s–14.0s');
    expect(p).toContain('Bỏ đoạn này: bỏ đoạn này');
    expect(p).not.toContain('m-done');
    expect(p).toContain('[mark:<id>]');
  });

  it('chat includes recent conversation and the new message', () => {
    store.appendMessage({ id: '1', projectId, role: 'user', text: 'cắt chỗ lặng', createdAt: 'x' });
    store.appendMessage({ id: '2', projectId, role: 'agent', text: 'Đã cắt 14 chỗ.', createdAt: 'x' });
    const p = buildDirectorPrompt({ reason: 'chat', note: 'sao lại cắt đoạn 2?', ctx: ctxWith(), data: data() });
    expect(p).toContain('Chủ kênh: cắt chỗ lặng');
    expect(p).toContain('Bạn: Đã cắt 14 chỗ.');
    expect(p).toContain('sao lại cắt đoạn 2?');
    expect(p).not.toContain('đính kèm');
  });

  it('chat history names what earlier messages attached', () => {
    store.appendMessage({ id: '1', projectId, role: 'user', text: 'ảnh này', createdAt: 'x', attachments: [{ kind: 'asset', ref: 'lib:image:a', label: 'logo' }] });
    const p = buildDirectorPrompt({ reason: 'chat', note: 'dùng ảnh lúc nãy', ctx: ctxWith(), data: data() });
    expect(p).toContain('Chủ kênh: ảnh này [đính kèm: logo (lib:image:a)]');
  });

  it('reads the current plan from plans/plan.vN.json when project.json does not carry it', () => {
    store.updateProject(projectId, (p) => { p.planVersion = 3; p.planStatus = 'draft'; });
    const dir = path.join(store.projectDir(projectId), 'plans');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.v3.json'), JSON.stringify(plan(3)));
    expect(loadDirectorContext(store, projectId)!.plan?.version).toBe(3);
  });
});
