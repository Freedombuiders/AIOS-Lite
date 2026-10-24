import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAssets } from './catalog/assets.js';
import { VIDEO_STYLES } from './catalog/styles.js';
import { registerVideoEditRoutes } from './routes.js';
import { STEP_DEFS, STYLE_GROUPS, type MediaInfo, type VideoMessage, type VideoProject } from './types.js';

const INFO: MediaInfo = {
  fileName: 'raw.mp4', sizeBytes: 12, durationSec: 118.4, width: 1080, height: 1920, fps: 30,
  videoCodec: 'h264', audioCodec: 'aac', hasAudio: true,
};

let root: string;
let app: Hono;
let probe: ReturnType<typeof vi.fn>;
let thumbnail: ReturnType<typeof vi.fn>;
let runTurn: ReturnType<typeof vi.fn>;
let reg: ReturnType<typeof registerVideoEditRoutes>;
const directorAuth = {
  status: vi.fn(() => ({ connected: true, defaultModel: 'gpt-test', models: [{ id: 'gpt-test', label: 'GPT Test' }], login: { state: 'idle' as const } })),
  start: vi.fn(), cancel: vi.fn(),
};

const j = async (res: Response) => (await res.json()) as any;
const post = (url: string, body: unknown) =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (url: string, body: unknown) =>
  app.request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function newProfile(name = 'Kênh Hoàng Anh') {
  return (await j(await post('/edit/profiles', { name }))).profile;
}
async function newProject(profileId: string, extra: Record<string, unknown> = {}): Promise<VideoProject> {
  return (await j(await post('/edit/projects', { profileId, ...extra }))).project;
}
const upload = (id: string, data: Buffer, name = 'clip.mp4') =>
  app.request(`/edit/projects/${id}/upload`, { method: 'POST', headers: { 'x-file-name': encodeURIComponent(name) }, body: data });

beforeEach(() => {
  directorAuth.status.mockReturnValue({ connected: true, defaultModel: 'gpt-test', models: [{ id: 'gpt-test', label: 'GPT Test' }], login: { state: 'idle' } });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-edit-test-'));
  probe = vi.fn(async () => ({ ...INFO }));
  thumbnail = vi.fn(async (_src: string, dest: string) => { fs.writeFileSync(dest, 'jpg'); });
  runTurn = vi.fn(async (input: { onDelta?: (t: string) => void }) => {
    input.onDelta?.('Xin');
    return { text: 'Xin chào, mình là đạo diễn.', durationMs: 5, activity: [] };
  });
  app = new Hono();
  reg = registerVideoEditRoutes(app, {
    directorAuth,
    root, probe: probe as never, thumbnail: thumbnail as never, autoStart: false,
    tools: { runDirector: runTurn as never },
    doctor: (async () => ({ checks: [], ok: 0, total: 0, requiredOk: true })) as never,
  });
});



afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.VIDEO_EDIT_MAX_UPLOAD_BYTES;
});

describe('profiles', () => {
  it('keeps one manually created brand profile across videos without requiring a social account', async () => {
    const profile = await newProfile('Thương hiệu chung');
    expect(profile.platform).toBe('other');
    const first = await newProject(profile.id, { aspect: '9:16' });
    const second = await newProject(profile.id, { aspect: '16:9' });
    expect(first.profileId).toBe(profile.id);
    expect(second.profileId).toBe(profile.id);
    const updated = await j(await patch(`/edit/profiles/${profile.id}`, { name: 'Thương hiệu mới', taste: 'Cắt nhanh' }));
    expect(updated.profile).toMatchObject({ name: 'Thương hiệu mới', taste: 'Cắt nhanh' });
    expect((await j(await app.request('/edit/profiles'))).profiles[0].projectCount).toBe(2);
    expect((await app.request('/edit/social-channels')).status).toBe(404);
  });
  it('creates with slug, initials, colour and defaults from a Vietnamese name', async () => {
    const profile = await newProfile('Kênh Hoàng Anh');
    expect(profile.slug).toBe('kenh-hoang-anh');
    expect(profile.initials).toBe('KH');
    expect(profile.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(profile).toMatchObject({ platform: 'other', defaultAspect: '9:16', brand: {}, taste: '', onboarding: {}, referenceChannels: [], autoApprovePlan: false });
    const second = await newProfile('Kênh Hoàng Anh');
    expect(second.slug).toBe('kenh-hoang-anh-2');
    expect((await newProfile('Đặng Đức')).slug).toBe('dang-duc');
  });

  it('rejects unknown fields and long names', async () => {
    expect((await post('/edit/profiles', { name: 'x', admin: true })).status).toBe(400);
    expect((await post('/edit/profiles', { name: 'x'.repeat(81) })).status).toBe(400);
  });

  it('patches fields and clears the default style', async () => {
    const profile = await newProfile();
    let res = await patch(`/edit/profiles/${profile.id}`, { taste: 'Nhanh, gắt', defaultStyleId: 'sanpham', onboarding: { topic: 'AI' }, autoApprovePlan: true, handle: '@kenh' });
    expect((await j(res)).profile).toMatchObject({ taste: 'Nhanh, gắt', defaultStyleId: 'sanpham', onboarding: { topic: 'AI' }, autoApprovePlan: true, handle: '@kenh' });
    res = await patch(`/edit/profiles/${profile.id}`, { defaultStyleId: null });
    expect((await j(res)).profile.defaultStyleId).toBeUndefined();
    expect((await patch(`/edit/profiles/${profile.id}`, { defaultStyleId: 'nope' })).status).toBe(400);
    expect((await patch(`/edit/profiles/${profile.id}`, { referenceChannels: ['not a url'] })).status).toBe(400);
  });

  it('links a channel to a configured Second Brain and rejects unknown vaults', async () => {
    const profile = await newProfile();
    const brains = await j(await app.request('/edit/brains'));
    expect(brains.vaults.length).toBeGreaterThan(0);
    const id = brains.vaults[0].id;
    const linked = await patch(`/edit/profiles/${profile.id}`, { brainVaultId: id });
    expect((await j(linked)).profile.brainVaultId).toBe(id);
    expect((await patch(`/edit/profiles/${profile.id}`, { brainVaultId: 'does-not-exist' })).status).toBe(400);
    const cleared = await patch(`/edit/profiles/${profile.id}`, { brainVaultId: null });
    expect((await j(cleared)).profile.brainVaultId).toBeUndefined();
  });

  it('lists projectCount and blocks deleting a profile that has projects', async () => {
    const profile = await newProfile();
    const project = await newProject(profile.id);
    const list = await j(await app.request('/edit/profiles'));
    expect(list.profiles[0].projectCount).toBe(1);
    const res = await app.request(`/edit/profiles/${profile.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await j(res)).error).toBeTruthy();
    expect((await app.request(`/edit/projects/${project.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/edit/profiles/${profile.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('404s on malformed ids', async () => {
    expect((await patch('/edit/profiles/../x', { name: 'a' })).status).toBe(404);
    expect((await app.request('/edit/projects/not-a-uuid')).status).toBe(404);
  });
});

describe('projects', () => {
  it('creates a ticket with 12 steps, all pending', async () => {
    const profile = await newProfile();
    await patch(`/edit/profiles/${profile.id}`, { defaultStyleId: 'review', defaultAspect: '1:1' });
    const project = await newProject(profile.id);
    expect(project.code).toBe('VID-0001');
    expect(project).toMatchObject({ title: 'Việc mới', status: 'draft', styleId: 'review', aspect: '1:1', busy: false, outputs: {} });
    expect(project.steps).toHaveLength(12);
    expect(project.steps.map((s) => s.key)).toEqual(STEP_DEFS.map((d) => d.key));
    expect(project.planVersion).toBe(0);
    // Phase 1 engine is live: every step starts pending.
    for (const s of project.steps) expect(s.status).toBe('pending');
    expect((await newProject(profile.id)).code).toBe('VID-0002');
  });

  it('lists newest first, filters by profile, patches and deletes', async () => {
    const a = await newProfile('A');
    const b = await newProfile('B');
    const p1 = await newProject(a.id, { title: 'Một' });
    await new Promise((r) => setTimeout(r, 5));
    const p2 = await newProject(a.id, { title: 'Hai' });
    await newProject(b.id);
    const list = await j(await app.request(`/edit/projects?profileId=${a.id}`));
    expect(list.projects.map((p: any) => p.id)).toEqual([p2.id, p1.id]);
    expect(list.projects[0]).toMatchObject({ hasSource: false });

    const res = await patch(`/edit/projects/${p1.id}`, { title: 'Mới', styleId: 'vlog', targetSeconds: 60 });
    expect((await j(res)).project).toMatchObject({ title: 'Mới', styleId: 'vlog', targetSeconds: 60 });
    const cleared = await j(await patch(`/edit/projects/${p1.id}`, { styleId: null, targetSeconds: null }));
    expect(cleared.project.styleId).toBeUndefined();
    expect(cleared.project.targetSeconds).toBeUndefined();

    const dir = path.join(root, 'projects', p1.id);
    expect(fs.existsSync(dir)).toBe(true);
    await app.request(`/edit/projects/${p1.id}`, { method: 'DELETE' });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('returns 404 for a project that does not exist', async () => {
    const res = await app.request('/edit/projects/11111111-1111-4111-8111-111111111111');
    expect(res.status).toBe(404);
  });
});

describe('upload and media', () => {
  it('stores the raw body, probes it and completes ingest', async () => {
    const profile = await newProfile();
    const project = await newProject(profile.id);
    const data = Buffer.from('0123456789abcdef');
    const res = await upload(project.id, data, 'Quay thô 1.mp4');
    expect(res.status).toBe(200);
    const body = await j(res);
    const out = body.project as VideoProject;
    expect(out.source).toMatchObject({ fileName: 'Quay thô 1.mp4', sizeBytes: 16, width: 1080, height: 1920 });
    const ingest = out.steps.find((s) => s.key === 'ingest')!;
    // Probed and thumbnailed; the queued ingest job normalises the file next.
    expect(ingest.status).toBe('running');
    expect(ingest.summary).toBe('1:58 · 1080×1920 · 30fps · 1 KB');
    expect(body.job).toMatchObject({ kind: 'ingest', status: 'queued' });
    const dir = path.join(root, 'projects', project.id);
    expect(fs.readFileSync(path.join(dir, 'source', 'raw.mp4'))).toEqual(data);
    expect(fs.existsSync(path.join(dir, 'thumb.jpg'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'source')).filter((n) => n.startsWith('.upload'))).toHaveLength(0);

    const detail = await j(await app.request(`/edit/projects/${project.id}`));
    expect(detail.project.source).toBeTruthy();
  });

  it('replaces an older source and keeps going when the thumbnail fails', async () => {
    const project = await newProject((await newProfile()).id);
    await upload(project.id, Buffer.from('aaaa'), 'a.mov');
    thumbnail.mockRejectedValueOnce(new Error('no ffmpeg'));
    const res = await upload(project.id, Buffer.from('bbbbbb'), 'b.mp4');
    expect(res.status).toBe(200);
    const files = fs.readdirSync(path.join(root, 'projects', project.id, 'source'));
    expect(files).toEqual(['raw.mp4']);
  });

  it('rejects a bad extension, an oversized body and an unreadable file', async () => {
    const project = await newProject((await newProfile()).id);
    const bad = await upload(project.id, Buffer.from('x'), 'notes.txt');
    expect(bad.status).toBe(415);
    expect((await j(bad)).error).toBeTruthy();

    process.env.VIDEO_EDIT_MAX_UPLOAD_BYTES = '8';
    const big = await upload(project.id, Buffer.from('0123456789'), 'big.mp4');
    expect(big.status).toBe(413);
    delete process.env.VIDEO_EDIT_MAX_UPLOAD_BYTES;

    probe.mockRejectedValueOnce(new Error('ffprobe failed'));
    const broken = await upload(project.id, Buffer.from('not a video'), 'broken.mp4');
    expect(broken.status).toBe(422);
    const detail = (await j(await app.request(`/edit/projects/${project.id}`))).project as VideoProject;
    expect(detail.steps[0]).toMatchObject({ status: 'failed' });
    expect(detail.source).toBeUndefined();
    expect(fs.readdirSync(path.join(root, 'projects', project.id, 'source'))).toEqual([]);
  });

  it('serves media with Range support', async () => {
    const project = await newProject((await newProfile()).id);
    await upload(project.id, Buffer.from('0123456789'), 'clip.mp4');
    const url = `/edit/projects/${project.id}/media/source`;

    const full = await app.request(url);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(await full.text()).toBe('0123456789');

    const part = await app.request(url, { headers: { range: 'bytes=2-5' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(part.headers.get('content-length')).toBe('4');
    expect(await part.text()).toBe('2345');

    const tail = await app.request(url, { headers: { range: 'bytes=-3' } });
    expect(tail.headers.get('content-range')).toBe('bytes 7-9/10');

    const bad = await app.request(url, { headers: { range: 'bytes=50-60' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */10');

    const thumb = await app.request(`/edit/projects/${project.id}/media/thumb`);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
    expect((await app.request(`/edit/projects/${project.id}/media/final`)).status).toBe(404);
    expect((await app.request(`/edit/projects/${project.id}/media/cover-2`)).status).toBe(404);
    expect((await app.request(`/edit/projects/${project.id}/media/other`)).status).toBe(404);
  });
});

async function waitFor<T>(fn: () => T | undefined | false, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timeout');
}

describe('messages', () => {
  const messages = async (id: string) => (await j(await app.request(`/edit/projects/${id}`))).messages as VideoMessage[];

  it('appends the agent reply after the turn and clears busy', async () => {
    const project = await newProject((await newProfile()).id);
    const res = await post(`/edit/projects/${project.id}/messages`, { text: 'Dựng giúp mình' });
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.message).toMatchObject({ role: 'user', text: 'Dựng giúp mình' });
    expect(body.agentMessageId).toBeTruthy();

    await waitFor(() => fs.readFileSync(path.join(root, 'projects', project.id, 'messages.jsonl'), 'utf8').includes('"role":"agent"'));
    const msgs = await messages(project.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(msgs[1]).toMatchObject({ id: body.agentMessageId, text: 'Xin chào, mình là đạo diễn.' });
    expect(msgs[1].error).toBeUndefined();
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(root, 'projects', project.id, 'project.json'), 'utf8')).busy === false);
    const after = (await j(await app.request(`/edit/projects/${project.id}`))).project as VideoProject;
    expect(after.busy).toBe(false);
    expect(after.status).toBe('working');
  });

  it('turns a failed turn into an error message without leaving busy stuck', async () => {
    runTurn.mockRejectedValueOnce(new Error('boom'));
    const project = await newProject((await newProfile()).id);
    await post(`/edit/projects/${project.id}/messages`, { text: 'xin chào' });
    await waitFor(() => fs.readFileSync(path.join(root, 'projects', project.id, 'messages.jsonl'), 'utf8').includes('"role":"agent"'));
    const msgs = await messages(project.id);
    expect(msgs[1].error).toBe(true);
    expect(msgs[1].text).toContain('boom');
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(root, 'projects', project.id, 'project.json'), 'utf8')).busy === false);
  });

  it('sets the style from a leading command and persists an explicit styleId', async () => {
    const project = await newProject((await newProfile()).id);
    const res = await post(`/edit/projects/${project.id}/messages`, { text: '/sanpham dựng video này 60 giây' });
    expect((await j(res)).message.styleId).toBe('sanpham');
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(root, 'projects', project.id, 'project.json'), 'utf8')).busy === false);
    expect(((await j(await app.request(`/edit/projects/${project.id}`))).project as VideoProject).styleId).toBe('sanpham');

    const talkingHead = await post(`/edit/projects/${project.id}/messages`, { text: '/edit-video-talking-head dựng clip này' });
    expect((await j(talkingHead)).message.styleId).toBe('quyen');
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(root, 'projects', project.id, 'project.json'), 'utf8')).busy === false);
    expect(((await j(await app.request(`/edit/projects/${project.id}`))).project as VideoProject).styleId).toBe('quyen');

    const res2 = await post(`/edit/projects/${project.id}/messages`, { text: 'đổi kiểu', styleId: 'vlog' });
    expect((await j(res2)).message.styleId).toBe('vlog');
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(root, 'projects', project.id, 'project.json'), 'utf8')).busy === false);
    expect(((await j(await app.request(`/edit/projects/${project.id}`))).project as VideoProject).styleId).toBe('vlog');
    expect((await post(`/edit/projects/${project.id}/messages`, { text: 'x', styleId: 'nope' })).status).toBe(400);
  });

  it('answers 409 while a turn is running and abort stops it', async () => {
    let release!: () => void;
    runTurn.mockImplementationOnce((input: { abortController: AbortController }) => new Promise((resolve) => {
      release = () => resolve({ text: 'xong', durationMs: 1, activity: [] });
      input.abortController.signal.addEventListener('abort', () => resolve({ text: '', durationMs: 1, activity: [], error: 'Đã dừng theo yêu cầu.' }));
    }));
    const project = await newProject((await newProfile()).id);
    await post(`/edit/projects/${project.id}/messages`, { text: 'một' });
    const busy = await post(`/edit/projects/${project.id}/messages`, { text: 'hai' });
    expect(busy.status).toBe(409);
    expect((await app.request(`/edit/projects/${project.id}`, { method: 'DELETE' })).status).toBe(409);

    expect((await post(`/edit/projects/${project.id}/abort`, {})).status).toBe(200);
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(root, 'projects', project.id, 'project.json'), 'utf8')).busy === false);
    const msgs = await messages(project.id);
    expect(msgs[1]).toMatchObject({ error: true });
    expect(release).toBeTypeOf('function');
  });

  it('validates the body', async () => {
    const project = await newProject((await newProfile()).id);
    expect((await post(`/edit/projects/${project.id}/messages`, { text: '' })).status).toBe(400);
    expect((await post(`/edit/projects/${project.id}/messages`, { text: 'a'.repeat(8001) })).status).toBe(400);
  });

  it('resets a busy flag left over from a previous process on first read', async () => {
    const project = await newProject((await newProfile()).id);
    const file = path.join(root, 'projects', project.id, 'project.json');
    fs.writeFileSync(file, JSON.stringify({ ...project, busy: true }));
    const app2 = new Hono();
    registerVideoEditRoutes(app2, { root, autoStart: false, tools: { runDirector: runTurn as never } });
    const res = await app2.request(`/edit/projects/${project.id}`);
    expect(((await res.json()) as any).project.busy).toBe(false);
  });
});

describe('events, run, plan, voice', () => {
  it('streams the project on connect and pushes later events', async () => {
    const project = await newProject((await newProfile()).id);
    const res = await app.request(`/edit/projects/${project.id}/events`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async (needle: string) => {
      const end = Date.now() + 2000;
      while (!text.includes(needle) && Date.now() < end) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await read('"type":"project"');
    expect(text).toContain(`"id":"${project.id}"`);
    expect(text).not.toContain('event:');
    await patch(`/edit/projects/${project.id}`, { title: 'Đổi tên' });
    await read('Đổi tên');
    expect(text).toContain('Đổi tên');
    await reader.cancel();
  });

  it('validates run steps and refuses ones that cannot run yet', async () => {
    const project = await newProject((await newProfile()).id);
    const run = (step: string) => post(`/edit/projects/${project.id}/run`, { step });
    expect((await run('nope')).status).toBe(400);
    expect((await run('cut')).status).toBe(400);
    expect((await run('ingest')).status).toBe(409);
    expect((await run('transcribe')).status).toBe(409);
    expect((await run('analyze')).status).toBe(409);
    expect((await run('direct')).status).toBe(409);
    expect((await run('render')).status).toBe(409);
    expect((await post(`/edit/projects/${project.id}/plan/decide`, { action: 'approve' })).status).toBe(409);
    await upload(project.id, Buffer.from('0123456789'), 'clip.mp4');
    const again = await run('ingest');
    expect(again.status).toBe(200);
    const againBody = await j(again);
    expect(againBody.job).toMatchObject({ kind: 'ingest' });
    expect(againBody.project.source.fileName).toBe('clip.mp4');
  });

  it('reports the voice provider as not configured', async () => {
    expect(await j(await app.request('/edit/voice'))).toEqual({ configured: false, provider: null, voices: [] });
    const tts = await post('/edit/voice/tts', { text: 'a' });
    expect(tts.status).toBe(501);
    expect((await j(tts)).code).toBe('voice_not_configured');
  });

  it('serves the doctor report', async () => {
    expect(await j(await app.request('/edit/doctor'))).toEqual({ checks: [], ok: 0, total: 0, requiredOk: true });
  });
});

describe('catalogs', () => {
  it('has 21 styles with unique ids and commands across the four groups', async () => {
    const body = await j(await app.request('/edit/styles'));
    expect(body.groups).toEqual(STYLE_GROUPS);
    expect(body.styles).toHaveLength(21);
    expect(new Set(body.styles.map((s: any) => s.id)).size).toBe(21);
    expect(new Set(body.styles.map((s: any) => s.command)).size).toBe(21);
    for (const s of body.styles) expect(s.command).toMatch(/^\/[a-z0-9-]+$/);
    const counts = Object.fromEntries(STYLE_GROUPS.map((g) => [g.id, body.styles.filter((s: any) => s.group === g.id).length]));
    expect(counts).toEqual({ teach: 6, sell: 5, life: 6, cinema: 4 });
    expect(body.styles.find((s: any) => s.id === 'quyen')).toMatchObject({ command: '/edit-video-talking-head', captionStyle: 'caption:outline-highlight' });
  });

  it('keeps style references inside the asset catalog', () => {
    const ids = new Set(listAssets(root).assets.map((a) => a.id));
    for (const s of VIDEO_STYLES) {
      expect(s.promptNotes.length).toBeGreaterThan(80);
      expect(s.palette.bg).toMatch(/^#[0-9A-F]{6}$/i);
      expect(ids.has(s.captionStyle), `${s.id} caption ${s.captionStyle}`).toBe(true);
      for (const e of s.effects) expect(ids.has(e), `${s.id} effect ${e}`).toBe(true);
    }
  });
});
