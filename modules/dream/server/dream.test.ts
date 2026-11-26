// Dream 100 with fake yt-dlp / ffprobe / ffmpeg (test-fixtures/dream): nothing is downloaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorBody, handleError } from '../../../src/api/errors.js';
import type { AppDeps } from '../../../src/core/deps.js';
import { createModuleContext } from '../../../src/modules/context.js';
import type { LeanRunInput, LeanRunResult, ModuleContext, ModuleManifest } from '../../../src/modules/sdk.js';
import { createTestHarness, type TestHarness } from '../../../src/modules/test-deps.js';
import { createNotes } from '../../../src/shared/notes.js';
import { REPO_ROOT, sampleBrain, testLog } from '../../../src/shared/test-kit.js';
import { cleanTmp, JobQueue, queueVideos, runJob, tmpRoot } from './analyze.js';
import { addChannels, MAX_CHANNELS } from './channels.js';
import dream, { _idle, _setToolsForTests } from './index.js';
import { cutStats, ytdlpArgs, type ToolPaths } from './measure.js';
import { DOWNLOAD_TIMEOUT_MS, execTool, FFMPEG_TIMEOUT_MS, ToolTimeoutError } from './run.js';

const FIX = path.join(REPO_ROOT, 'test-fixtures', 'dream');
const FOLDER = 'cong-ty-b';
const SECRET_SUB = 'LOI-PHU-DE-BI-MAT-7731';

let h: TestHarness;
let ctx: ModuleContext;
let brainRoot: string;
let bin: string;
let leanCalls: LeanRunInput[];
let leanAnswer: string;
let images: boolean;

/** A wrapper script that runs one fake tool with env set, so each test picks its own behaviour. */
function fake(name: 'yt-dlp' | 'ffprobe' | 'ffmpeg', env: Record<string, string> = {}): string {
  const file = path.join(bin, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  const vars = Object.entries(env).map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`).join(' ');
  fs.writeFileSync(file, `#!/bin/sh\nexec env ${vars} "${process.execPath}" "${path.join(FIX, `fake-${name}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return file;
}

function tools(over: { yt?: Record<string, string>; probe?: Record<string, string>; ff?: Record<string, string> } = {}, extra: Partial<ToolPaths> = {}): ToolPaths {
  return { ytdlp: fake('yt-dlp', over.yt), ffprobe: fake('ffprobe', over.probe), ffmpeg: fake('ffmpeg', over.ff), ...extra };
}

/** Every file under data/modules/dream/tmp, recursively. */
const tmpFiles = (): string[] => {
  const root = tmpRoot(ctx);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).map(String);
};

const notesText = (): string => {
  const dir = path.join(brainRoot, FOLDER, 'dream-100');
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
};

beforeEach(() => {
  h = createTestHarness();
  const sb = sampleBrain(h.deps.db);
  brainRoot = path.join(sb.root, 'brain');
  const deps = h.deps as AppDeps & { brain: AppDeps['brain']; notes: AppDeps['notes'] };
  deps.brain = sb.brain;
  deps.notes = createNotes({ brain: sb.brain, canRead: () => false, canWrite: () => false, log: testLog, bus: deps.bus });
  const dir = path.join(REPO_ROOT, 'modules', 'dream');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8')) as ModuleManifest;
  const settings = new Map<string, unknown>([['brain_folder', FOLDER]]);
  const base = createModuleContext(deps, manifest, dir, { stops: new Set() }, {
    settings: { all: () => ({}), patch() {} } as never,
    provides: () => undefined,
    isEnabled: () => true,
  });
  leanCalls = [];
  leanAnswer = '```json\n{"mo_dau":"cau-hoi","cau_truc":"huong-dan-buoc","keu_goi":"theo-doi","giay_keu_goi":27}\n```';
  images = false;
  ctx = {
    ...base,
    settings: { get: (k: string, fb?: unknown) => (settings.has(k) ? settings.get(k) : fb), set: (k: string, v: unknown) => void settings.set(k, v), all: () => Object.fromEntries(settings) },
    agents: {
      list: () => [{ id: 'main', name: 'Main', enabled: true }] as never,
      get: (id: string) => (id === 'main' ? ({ id: 'main', name: 'Main' } as never) : undefined),
      attachments: () => ({ images, documents: false }),
      runLean: async (input: LeanRunInput): Promise<LeanRunResult> => {
        leanCalls.push(input);
        // the frames must still exist while the agent reads them
        for (const img of input.images ?? []) expect(fs.existsSync(img)).toBe(true);
        return { ok: true, output: leanAnswer, taskId: 41, runId: 1 };
      },
    },
  } as ModuleContext;
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'modules', 'dream', 'migrations')).sort()) {
    h.deps.db.exec(fs.readFileSync(path.join(REPO_ROOT, 'modules', 'dream', 'migrations', f), 'utf8'));
  }
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-bin-'));
});

afterEach(async () => {
  _setToolsForTests(null);
  await dream.stop?.(ctx);
  fs.rmSync(bin, { recursive: true, force: true });
  h.cleanup();
});

function queueOne(url = 'https://www.youtube.com/shorts/abc123', channelId: string | null = null) {
  const r = queueVideos(ctx, { text: url, channelId, folderId: FOLDER });
  expect(r.queued).toHaveLength(1);
  return r.queued[0];
}

describe('measure helpers', () => {
  it('counts cuts per minute, cuts in the first 3 s and the longest scene', () => {
    expect(cutStats([0.8, 1.6, 2.4, 5, 9.5, 14, 18, 22, 26, 29], 31)).toEqual({ cuts: 10, cutsPerMin: 19.4, cutsFirst3s: 3, longestSceneS: 4.5 });
    expect(cutStats([], 20)).toEqual({ cuts: 0, cutsPerMin: 0, cutsFirst3s: 0, longestSceneS: 20 });
  });

  it('downloads with the planned limits and puts the link last, after --', () => {
    const a = ytdlpArgs('https://x.test/v', '/w');
    expect(a).toEqual(expect.arrayContaining(['--ignore-config', '--ignore-errors', '--no-playlist', '--max-filesize', '200M', '--write-info-json', '--write-auto-subs', '--sub-langs', 'vi.*,en']));
    expect(a[a.indexOf('-f') + 1]).toBe('bv*[height<=720]+ba/b[height<=720]');
    expect(a.slice(-2)).toEqual(['--', 'https://x.test/v']);
    expect(DOWNLOAD_TIMEOUT_MS).toBe(5 * 60_000);
    expect(FFMPEG_TIMEOUT_MS).toBe(2 * 60_000);
  });
});

describe('analysis job', () => {
  it('full pipeline writes the note with the numbers and labels, and leaves tmp empty', async () => {
    const [ch] = addChannels(ctx, { text: 'https://www.tiktok.com/@bepnhamoc', why: 'Cách mở đầu bằng câu hỏi', folderId: FOLDER }).added;
    const row = queueOne('https://www.tiktok.com/@bepnhamoc/video/7301', ch.id);
    const done = await runJob(ctx, row.id, tools());
    expect(done.status).toBe('done');
    expect(done.reason).toBeNull();
    expect(done).toMatchObject({ views: 412000, likes: 15300, comments: 210, cuts: 10, cuts_per_min: 19.4, cuts_first3s: 3, mo_dau: 'cau-hoi', cau_truc: 'huong-dan-buoc', keu_goi: 'theo-doi', giay_keu_goi: 27, has_subtitles: 1, used_frames: 0 });
    expect(done.captured_at).toBeGreaterThan(0);
    expect(tmpFiles()).toEqual([]);

    const note = fs.readFileSync(path.join(brainRoot, FOLDER, done.note_path!), 'utf8');
    expect(done.note_path).toMatch(/^dream-100\/video\/\d{4}-\d{2}-\d{2}-bepnhamoc-vd_[0-9a-f]+\.md$/);
    expect(note).toContain('loai: video-dream');
    expect(note).toContain('kenh: "[[bepnhamoc]]"');
    expect(note).toContain('luot_xem: 412000');
    expect(note).toContain('cat_moi_phut: 19.4');
    expect(note).toContain('mo_dau: cau-hoi');
    expect(note).toMatch(/lay_luc: .*\d{4}-\d{2}-\d{2}T/);
    expect(note).toContain('khoảng 19,4');
    expect(note).toContain('Mời theo dõi, ở giây 27');
    expect(note).toContain('xấp xỉ');

    // the agent got the subtitles wrapped as untrusted data, no images (runtime does not read them)
    expect(leanCalls).toHaveLength(1);
    expect(leanCalls[0].prompt).toMatch(/<untrusted>\n[\s\S]*LOI-PHU-DE-BI-MAT-7731[\s\S]*\n<\/untrusted>/);
    expect(leanCalls[0].images).toBeUndefined();
    expect(notesText()).not.toContain(SECRET_SUB);
  });

  it('hands the four hook frames to an agent whose runtime reads images', async () => {
    images = true;
    const done = await runJob(ctx, queueOne().id, tools());
    expect(done.status).toBe('done');
    expect(leanCalls[0].images).toHaveLength(4);
    expect(leanCalls[0].images!.every((f) => f.startsWith(path.join(tmpRoot(ctx), done.id)))).toBe(true);
    expect(done.used_frames).toBe(1);
    expect(tmpFiles()).toEqual([]);
  });

  it('a failing ffmpeg still leaves tmp empty, and the reason is recorded on the job and the note', async () => {
    const done = await runJob(ctx, queueOne().id, tools({ ff: { FAKE_FFMPEG_MODE: 'fail' } }));
    expect(done.status).toBe('failed');
    expect(done.reason).toContain('ffmpeg lỗi');
    expect(tmpFiles()).toEqual([]);
    expect(leanCalls).toHaveLength(0);
    // yt-dlp gave the public numbers, so a note exists, saying why it is not analysed
    const note = fs.readFileSync(path.join(brainRoot, FOLDER, done.note_path!), 'utf8');
    expect(note).toContain('trang_thai: chua-mo-xe');
    expect(note).toContain('ffmpeg lỗi');
    expect(note).toContain('luot_xem: 412000');
    expect(notesText()).not.toContain(SECRET_SUB);
  });

  it('a hanging command is killed at the timeout and the job ends with the reason', async () => {
    const pidFile = path.join(bin, 'pid');
    const started = Date.now();
    const done = await runJob(ctx, queueOne().id, tools({ ff: { FAKE_FFMPEG_MODE: 'hang', FAKE_PID_FILE: pidFile } }, { timeouts: { ffmpegMs: 1500 } }));
    expect(Date.now() - started).toBeLessThan(8000);
    expect(done.status).toBe('failed');
    expect(done.reason).toMatch(/ffmpeg chạy quá .* giây nên đã bị dừng/);
    expect(tmpFiles()).toEqual([]);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('execTool kills a hanging download at its limit, and the ffmpeg it started', async () => {
    const pidFile = path.join(bin, 'pid');
    const childPidFile = path.join(bin, 'child-pid');
    const w = fs.mkdtempSync(path.join(bin, 'w-'));
    const run = execTool(fake('yt-dlp', { FAKE_MODE: 'hang', FAKE_PID_FILE: pidFile, FAKE_CHILD_PID_FILE: childPidFile }), ['-o', path.join(w, 'video.%(ext)s'), '--', 'https://x.test'], { timeoutMs: 1500, label: 'yt-dlp' });
    await expect(run).rejects.toBeInstanceOf(ToolTimeoutError);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('a link with shell metacharacters reaches yt-dlp as one argument and runs nothing', async () => {
    const argsFile = path.join(bin, 'args.json');
    const marker = path.join(bin, 'pwned');
    const raw = `https://example.com/watch?v=1;touch%20${marker}&x=$(touch ${marker})|id\`touch ${marker}\``.replace(/ /g, '%20');
    const row = queueOne(raw);
    for (const ch of [';', '$(', '|', '&']) expect(row.url).toContain(ch);
    await runJob(ctx, row.id, tools({ yt: { FAKE_ARGS_FILE: argsFile } }));
    const argv = JSON.parse(fs.readFileSync(argsFile, 'utf8')) as string[];
    expect(argv[argv.length - 1]).toBe(row.url);
    expect(argv[argv.length - 2]).toBe('--');
    expect(argv.filter((a) => a.includes('example.com'))).toHaveLength(1);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('private, login-only and oversize videos record the reason and write no note', async () => {
    const cases: [string, RegExp][] = [['private', /riêng tư/], ['login', /đăng nhập/], ['big', /200 MB/]];
    for (const [mode, re] of cases) {
      const done = await runJob(ctx, queueOne(`https://www.youtube.com/watch?v=${mode}`).id, tools({ yt: { FAKE_MODE: mode } }));
      expect(done.status).toBe('failed');
      expect(done.reason).toMatch(re);
      expect(done.note_path).toBeNull();
    }
    expect(tmpFiles()).toEqual([]);
  });

  it('missing yt-dlp or ffmpeg ends the job with a Vietnamese reason and the install command, without crashing', async () => {
    const a = await runJob(ctx, queueOne('https://www.youtube.com/watch?v=a').id, { ytdlp: null, ffmpeg: null, ffprobe: null });
    expect(a.status).toBe('failed');
    expect(a.reason).toContain('brew install yt-dlp');
    const b = await runJob(ctx, queueOne('https://www.youtube.com/watch?v=b').id, { ...tools(), ffmpeg: null });
    expect(b.status).toBe('failed');
    expect(b.reason).toContain('brew install ffmpeg');
    const c = await runJob(ctx, queueOne('https://www.youtube.com/watch?v=c').id, { ...tools(), ffmpeg: path.join(bin, 'khong-co-ffmpeg') });
    expect(c.status).toBe('failed');
    expect(c.reason).toContain('brew install ffmpeg');
    expect(tmpFiles()).toEqual([]);
  });

  it('a subtitle that fails to download (429) does not abort the video: measured, labels marked missing', async () => {
    const done = await runJob(ctx, queueOne().id, tools({ yt: { FAKE_MODE: 'subfail' } }));
    expect(done.status).toBe('done');
    expect(done).toMatchObject({ has_subtitles: 0, cuts: 10, views: 412000 });
    expect(done.label_note).toContain('Thiếu dữ liệu');
    expect(tmpFiles()).toEqual([]);
  });

  it('no subtitles and no image runtime: no agent turn, the note says the data is missing instead of guessing', async () => {
    const done = await runJob(ctx, queueOne().id, tools({ yt: { FAKE_MODE: 'nosubs' } }));
    expect(done.status).toBe('done');
    expect(leanCalls).toHaveLength(0);
    expect(done.mo_dau).toBeNull();
    expect(done.label_note).toContain('Thiếu dữ liệu');
    const note = fs.readFileSync(path.join(brainRoot, FOLDER, done.note_path!), 'utf8');
    expect(note).toContain('trang_thai: thieu-nhan');
    expect(note).toContain('Thiếu dữ liệu');
  });

  it('labels outside the allowed lists, or extra free text keys, are rejected', async () => {
    leanAnswer = `{"mo_dau":"cau-hoi","cau_truc":"huong-dan-buoc","keu_goi":"theo-doi","giay_keu_goi":27,"mo_ta":"${SECRET_SUB}"}`;
    const a = await runJob(ctx, queueOne('https://www.youtube.com/watch?v=x').id, tools());
    expect(a.status).toBe('done');
    expect(a.mo_dau).toBeNull();
    expect(a.label_note).toContain('sai định dạng');
    leanAnswer = '{"mo_dau":"bat-ngo","cau_truc":"huong-dan-buoc","keu_goi":"theo-doi","giay_keu_goi":null}';
    const b = await runJob(ctx, queueOne('https://www.youtube.com/watch?v=y').id, tools());
    expect(b.mo_dau).toBeNull();
    expect(notesText()).not.toContain(SECRET_SUB);
  });

  it('cleans leftovers at start, and the queue runs pasted links one by one', async () => {
    fs.mkdirSync(path.join(tmpRoot(ctx), 'vd_old'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot(ctx), 'vd_old', 'video.mp4'), 'x');
    expect(cleanTmp(ctx)).toBe(1);
    expect(tmpFiles()).toEqual([]);

    const t = tools();
    queueVideos(ctx, { text: 'https://www.youtube.com/watch?v=1\nhttps://www.youtube.com/watch?v=2', folderId: FOLDER });
    const q = new JobQueue(ctx, () => t);
    q.kick();
    await q.idle();
    const rows = ctx.db.prepare('SELECT status FROM dream_videos').all() as { status: string }[];
    expect(rows.map((r) => r.status)).toEqual(['done', 'done']);
    expect(tmpFiles()).toEqual([]);
  });
});

describe('channels', () => {
  it('the 101st channel is rejected, duplicates are skipped, each channel has a kenh-dream note', () => {
    const links = Array.from({ length: MAX_CHANNELS }, (_, i) => `https://www.youtube.com/@kenh${i}`).join('\n');
    const r = addChannels(ctx, { text: links, why: 'Nhịp cắt nhanh', folderId: FOLDER });
    expect(r.added).toHaveLength(100);
    const again = addChannels(ctx, { text: 'https://www.youtube.com/@kenh5 https://www.tiktok.com/@moi', folderId: FOLDER });
    expect(again.added).toHaveLength(0);
    expect(again.skipped[0].reason).toContain('đã có');
    expect(again.skipped[1].reason).toContain('100 kênh');
    const note = fs.readFileSync(path.join(brainRoot, FOLDER, 'dream-100', 'kenh', 'kenh0.md'), 'utf8');
    expect(note).toContain('loai: kenh-dream');
    expect(note).toContain('nen_tang: youtube');
    expect(note).toContain('link: https://youtube.com/@kenh0');
    expect(note).toContain('hoc_gi: Nhịp cắt nhanh');
  });
});

describe('routes (owner pages)', () => {
  let app: Hono;
  beforeEach(() => {
    app = new Hono();
    app.onError(handleError(testLog));
    app.notFound((c) => c.json(errorBody('not_found', 'x'), 404));
    dream.routes!(app, ctx);
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as any };
  };

  it('adds a channel, pastes a link, and the background job writes the note', async () => {
    const t = tools();
    _setToolsForTests(() => t);
    const ch = await call('POST', '/channels', { text: 'https://www.youtube.com/@thetealab', why: 'Mở đầu chỉ lỗi sai' });
    expect(ch.status).toBe(201);
    const v = await call('POST', '/videos', { text: 'https://www.youtube.com/shorts/abc123', channelId: ch.json.added[0].id });
    expect(v.status).toBe(202);
    await _idle(ctx);
    const list = await call('GET', '/videos');
    expect(list.json.items[0]).toMatchObject({ status: 'done', channel_handle: 'thetealab', cuts_per_min: 19.4 });
    expect(tmpFiles()).toEqual([]);
    expect(notesText()).not.toContain(SECRET_SUB);
  });

  it('refuses work until a Second Brain folder is chosen, and reports missing tools with install commands', async () => {
    ctx.settings.set('brain_folder', '');
    const r = await call('POST', '/videos', { text: 'https://www.youtube.com/shorts/abc123' });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('Second Brain');
    expect((await call('PUT', '/settings', { brainFolder: 'khong-co-thu-muc' })).status).toBe(400);
    const doc = await call('GET', '/doctor');
    for (const t of doc.json.tools as { tool: string; path: string | null; fix?: string }[]) {
      if (!t.path) expect(t.fix).toMatch(/^brew install /);
    }
  });

  it('gives agents no action to add links or start an analysis', () => {
    expect(dream.actions).toBeUndefined();
  });
});
