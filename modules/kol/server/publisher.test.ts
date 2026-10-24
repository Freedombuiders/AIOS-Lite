import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  personas: new Map<string, unknown>(),
  assets: new Map<string, unknown>(),
  files: new Map<string, unknown>(),
  kill: true,
  hasKey: true,
}));

vi.mock('./personas.js', async () => {
  const { KolError } = await import('./core.js');
  return {
    getPersona: (id: string) => h.personas.get(id) ?? null,
    requirePersona: (id: string) => {
      const p = h.personas.get(id);
      if (!p) throw new KolError(404, 'Không tìm thấy KOL.');
      return p;
    },
    listPersonaIds: () => [...h.personas.keys()],
  };
});
vi.mock('./assets.js', () => ({
  listAssetsByIds: (ids: string[]) => ids.map((id) => h.assets.get(id)).filter(Boolean),
  getAsset: (id: string) => h.assets.get(id) ?? null,
  getAssetFile: (id: string) => h.files.get(id) ?? null,
  patchAsset: () => null,
}));
vi.mock('./compat.js', async (orig) => ({ ...(await orig<typeof import('./compat.js')>()), isEnabled: () => h.kill }));
vi.mock('../../_lib/composio.js', async (orig) => ({ ...(await orig<typeof import('../../_lib/composio.js')>()), hasComposioKey: () => h.hasKey }));

import { _initTestDatabase, addFbPage, getFbContent, setFbSetting, updateFbContentFields } from './test-db.js';
import { getAccountRow, setPublishNotifier } from './accounts.js';
import { _setToolExecutor, type ToolExecutor } from './composio-exec.js';
import { kolDb, saveSettings } from './core.js';
import { approvePost, createPost, getTargetRow, publishNowPost, requirePost } from './posts.js';
import { _resetPublisher, classifyPublishFailure, publisherTick, recoverStuckTargets } from './publisher.js';
import { UNCERTAIN_MESSAGE } from './schedule-rules.js';
import { _setStageRoot, _setStageTools } from './stage.js';
import type { AssetDto, PersonaDto, Platform } from './types.js';

const T0 = Date.UTC(2026, 9, 20, 5, 0, 0) / 1000; // 12:00 Vietnam
const MIN = 60;
const HOUR = 3600;

let root: string;
let notes: string[];
let calls: { slug: string; args: Record<string, unknown> }[];

function persona(over: Partial<PersonaDto> = {}): PersonaDto {
  return {
    id: 'p1', name: 'Mai', handle: '@mai.ai', status: 'active', tagline: '', niche: '', languages: ['vi'], bio: '',
    appearance: { gender: '', ageRange: '', ethnicity: '', face: '', eyes: '', skin: '', hair: '', body: '', marks: '', styleKeywords: [], signatureLook: '' },
    personality: { traits: [], values: [], backstory: '', voiceTone: '', writingStyle: '', catchphrases: [], do: [], dont: [] },
    audience: '', pillars: [], identitySource: 'synthetic', consentNote: '', disclosureText: 'Ảnh tạo bằng AI.', voiceId: '', brainAgent: 'main',
    imageModel: '', videoModel: '', realismPreset: 'pro-photo', consistencyThreshold: 80, autoRejectDrift: false, monthlyCapUsd: null,
    autopilot: { enabled: false, postsPerWeek: {}, leadDays: 3, requireApproval: true, imagesPerPost: 2, generateMedia: false, weeklyBudgetUsd: 0 },
    coverAssetId: null, refs: [], createdAt: 0, updatedAt: 0, ...over,
  };
}

function asset(id: string, kind: 'image' | 'video' = 'image'): void {
  const abs = path.join(root, 'src', `${id}.${kind === 'image' ? 'jpg' : 'mp4'}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'data');
  const dims = kind === 'image' ? { width: 1080, height: 1350, durationSec: null } : { width: 1080, height: 1920, durationSec: 20 };
  const mime = kind === 'image' ? 'image/jpeg' : 'video/mp4';
  h.files.set(id, { abs, mime, kind, ...dims });
  const a: AssetDto = {
    id, personaId: 'p1', generationId: null, kind, url: '', thumbUrl: null, mime, ...dims, bytes: 4, status: 'approved', favorite: false,
    consistency: { score: 90, verdict: 'pass', notes: '' }, model: '', provider: '', costUsd: 0, prompt: '', tags: [], createdAt: 0,
  };
  h.assets.set(id, a);
}

function account(platform: Platform, over: Record<string, unknown> = {}): string {
  const id = randomUUID();
  const row = {
    id, persona_id: 'p1', platform, connection_id: `ca_${platform}`, entity_id: 'u1', external_id: platform === 'facebook' ? 'page1' : `${platform}-1`,
    handle: `@mai.${platform}`, display_name: 'Mai', max_posts_per_day: 5, min_gap_minutes: 0, window_start: '00:00', window_end: '23:59',
    timezone: 'Asia/Ho_Chi_Minh', status: 'ACTIVE', enabled: 1, created_at: T0, updated_at: T0, ...over,
  };
  const keys = Object.keys(row);
  kolDb().prepare(`INSERT INTO kol_accounts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => (row as Record<string, unknown>)[k]));
  return id;
}

/** A post scheduled at `at` (created while the clock is before it). */
function scheduledPost(accountIds: string[], assetIds: string[], at = T0 + 10 * MIN, format?: 'photo' | 'reel' | 'text'): string {
  vi.setSystemTime((at - HOUR) * 1000);
  const p = createPost('p1', { title: 'Đà Lạt', caption: 'Chiều nay', assetIds, accountIds, ...(format ? { format } : {}) });
  approvePost(p.id, at, at - HOUR);
  return p.id;
}

function script(map: Record<string, (args: Record<string, unknown>) => unknown>): void {
  const exec: ToolExecutor = async (slug, args) => {
    calls.push({ slug, args });
    const fn = map[slug];
    if (!fn) throw new Error(`unexpected tool ${slug}`);
    return fn(args);
  };
  _setToolExecutor(exec);
}

const IG_OK = {
  INSTAGRAM_POST_IG_USER_MEDIA: () => ({ id: 'c1' }),
  INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: () => ({ id: 'm1' }),
  INSTAGRAM_GET_IG_MEDIA: () => ({ permalink: 'https://www.instagram.com/p/abc/' }),
};

beforeEach(() => {
  _initTestDatabase();
  _resetPublisher();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kol-pub-'));
  _setStageRoot(path.join(root, 'stage'));
  _setStageTools({ ffmpeg: async (args) => { fs.writeFileSync(args[args.length - 1], 'x'); }, probe: async () => ({ codec: 'h264', width: 1080, height: 1920, durationSec: 20 }) });
  h.personas.clear();
  h.assets.clear();
  h.files.clear();
  h.kill = true;
  h.hasKey = true;
  h.personas.set('p1', persona());
  notes = [];
  calls = [];
  setPublishNotifier(async (t) => { notes.push(t); });
  saveSettings({ publishEnabled: true });
  vi.useFakeTimers();
  vi.setSystemTime(T0 * 1000);
});

afterEach(() => {
  _setToolExecutor(null);
  _setStageRoot(null);
  _setStageTools(null);
  setPublishNotifier(null);
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('publisher tick', () => {
  it('claims a due target, publishes, cleans staging and notifies with the permalink', async () => {
    asset('a1');
    const ig = account('instagram');
    const postId = scheduledPost([ig], ['a1']);
    script(IG_OK);

    await publisherTick(T0); // not due yet
    expect(calls).toEqual([]);

    await publisherTick(T0 + 11 * MIN);
    const post = requirePost(postId);
    expect(post.status).toBe('published');
    expect(post.targets[0]).toMatchObject({ status: 'published', externalId: 'm1', permalink: 'https://www.instagram.com/p/abc/', attempts: 1 });
    expect(post.publishedAt).toBe(T0 + 11 * MIN);
    expect(calls[0].args.caption).toBe('Chiều nay\n\nẢnh tạo bằng AI.');
    expect(fs.existsSync(path.join(root, 'stage', post.targets[0].id))).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Mai: đã đăng "Đà Lạt"');
    expect(notes[0]).toContain('https://www.instagram.com/p/abc/');

    calls = [];
    await publisherTick(T0 + 12 * MIN);
    expect(calls).toEqual([]); // never re-posted
  });

  it('does nothing while publishing is off (settings or kill switch)', async () => {
    asset('a1');
    const postId = scheduledPost([account('instagram')], ['a1']);
    script(IG_OK);
    saveSettings({ publishEnabled: false });
    await publisherTick(T0 + 11 * MIN);
    h.kill = false;
    saveSettings({ publishEnabled: true });
    await publisherTick(T0 + 11 * MIN);
    expect(calls).toEqual([]);
    expect(requirePost(postId).status).toBe('scheduled');
  });

  it('never posts late: past the 30-minute grace → missed + notify', async () => {
    asset('a1');
    const postId = scheduledPost([account('instagram')], ['a1']);
    script(IG_OK);
    await publisherTick(T0 + 10 * MIN + 31 * MIN);
    expect(calls).toEqual([]);
    const post = requirePost(postId);
    expect(post.targets[0]).toMatchObject({ status: 'missed', error: expect.stringContaining('không đăng muộn') });
    expect(post.status).toBe('failed');
    expect(notes).toHaveLength(1); // the missed notice; no second summary
    expect(notes[0]).toMatch(/lỡ giờ đăng/);
  });

  it('an account that is off waits, then misses after the grace window', async () => {
    asset('a1');
    const ig = account('instagram', { enabled: 0 });
    kolDb().prepare('UPDATE kol_accounts SET enabled = 1 WHERE id = ?').run(ig);
    const postId = scheduledPost([ig], ['a1']);
    kolDb().prepare('UPDATE kol_accounts SET enabled = 0 WHERE id = ?').run(ig);
    script(IG_OK);
    await publisherTick(T0 + 11 * MIN);
    expect(requirePost(postId).targets[0].status).toBe('scheduled');
    await publisherTick(T0 + 41 * MIN);
    expect(requirePost(postId).targets[0]).toMatchObject({ status: 'missed', error: expect.stringContaining('đang tắt') });
  });

  it('transient errors retry with backoff, 3 attempts in total, then fail + notify', async () => {
    asset('a1');
    const postId = scheduledPost([account('instagram')], ['a1']);
    script({ INSTAGRAM_POST_IG_USER_MEDIA: () => { throw new Error('Request failed with status 503 Service Unavailable'); } });
    const t = () => getTargetRow(requirePost(postId).targets[0].id)!;

    await publisherTick(T0 + 10 * MIN);
    expect(t()).toMatchObject({ status: 'scheduled', attempts: 1, next_attempt_at: T0 + 12 * MIN });
    expect(t().error).toMatch(/lỗi tạm thời/);
    await publisherTick(T0 + 11 * MIN);
    expect(t().attempts).toBe(1); // not due yet
    await publisherTick(T0 + 12 * MIN);
    expect(t()).toMatchObject({ status: 'scheduled', attempts: 2, next_attempt_at: T0 + 17 * MIN });
    // A retry is not "late" even past the grace of the original time.
    await publisherTick(T0 + 50 * MIN);
    expect(t()).toMatchObject({ status: 'failed', attempts: 3 });
    expect(requirePost(postId).status).toBe('failed');
    expect(notes.at(-1)).toMatch(/đăng thất bại/);
    expect(calls).toHaveLength(3);
  });

  it('rate limits are retried too', async () => {
    asset('a1');
    const postId = scheduledPost([account('instagram')], ['a1']);
    script({ INSTAGRAM_POST_IG_USER_MEDIA: () => { throw Object.assign(new Error('rate limit reached'), { status: 429 }); } });
    await publisherTick(T0 + 10 * MIN);
    expect(getTargetRow(requirePost(postId).targets[0].id)).toMatchObject({ status: 'scheduled', attempts: 1 });
  });

  it('expired connection: account EXPIRED, target failed, owner told once', async () => {
    asset('a1');
    asset('a2');
    const ig = account('instagram');
    const p1 = scheduledPost([ig], ['a1'], T0 + 10 * MIN);
    const p2 = scheduledPost([ig], ['a2'], T0 + 20 * MIN);
    script({ INSTAGRAM_POST_IG_USER_MEDIA: () => { throw new Error('OAuthException: Error validating access token: Session has expired'); } });
    await publisherTick(T0 + 10 * MIN);
    expect(getAccountRow(ig)!.status).toBe('EXPIRED');
    expect(requirePost(p1).targets[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('hết hạn') });
    const expiryNotes = notes.filter((n) => n.includes('đã hết hạn'));
    expect(expiryNotes).toHaveLength(2); // one account notice + the post summary
    // The second post: the account is expired → waits, then misses; no new expiry notice.
    await publisherTick(T0 + 55 * MIN);
    expect(requirePost(p2).targets[0].status).toBe('missed');
    expect(notes.filter((n) => n.startsWith('Kết nối'))).toHaveLength(1);
  });

  it('uncertain outcome (timeout after the upload started): failed and never retried', async () => {
    asset('v1', 'video');
    const tt = account('tiktok');
    const postId = scheduledPost([tt], ['v1'], T0 + 10 * MIN, 'reel');
    script({ TIKTOK_UPLOAD_VIDEO: () => { throw new Error('Request timed out after 300000ms'); } });
    await publisherTick(T0 + 10 * MIN);
    const t = requirePost(postId).targets[0];
    expect(t).toMatchObject({ status: 'failed', error: UNCERTAIN_MESSAGE, attempts: 1 });
    calls = [];
    await publisherTick(T0 + 20 * MIN);
    expect(calls).toEqual([]);
  });

  it('platform errors that are not transient fail at once', async () => {
    asset('a1');
    const postId = scheduledPost([account('instagram')], ['a1']);
    script({ INSTAGRAM_POST_IG_USER_MEDIA: () => { throw new Error('(#100) Invalid parameter: aspect ratio'); } });
    await publisherTick(T0 + 10 * MIN);
    expect(requirePost(postId).targets[0]).toMatchObject({ status: 'failed', attempts: 1, error: expect.stringContaining('Invalid parameter') });
  });

  it('no Composio key: non-Facebook targets wait, then miss with a clear reason', async () => {
    asset('a1');
    const postId = scheduledPost([account('instagram')], ['a1']);
    h.hasKey = false;
    script(IG_OK);
    await publisherTick(T0 + 10 * MIN);
    expect(requirePost(postId).targets[0].status).toBe('scheduled');
    await publisherTick(T0 + 41 * MIN);
    expect(requirePost(postId).targets[0]).toMatchObject({ status: 'missed', error: expect.stringContaining('Composio') });
  });

  it('TikTok: processing, then polled to published', async () => {
    asset('v1', 'video');
    const postId = scheduledPost([account('tiktok')], ['v1'], T0 + 10 * MIN, 'reel');
    let status = 'PROCESSING_UPLOAD';
    script({
      TIKTOK_UPLOAD_VIDEO: () => ({ publish_id: 'pub1' }),
      TIKTOK_FETCH_PUBLISH_STATUS: () => ({ status, publicaly_available_post_id: status === 'PUBLISH_COMPLETE' ? ['7311'] : [] }),
    });
    await publisherTick(T0 + 10 * MIN);
    expect(requirePost(postId)).toMatchObject({ status: 'publishing' });
    expect(requirePost(postId).targets[0].status).toBe('processing');
    await publisherTick(T0 + 11 * MIN);
    expect(requirePost(postId).targets[0].status).toBe('processing');
    status = 'PUBLISH_COMPLETE';
    await publisherTick(T0 + 12 * MIN);
    const post = requirePost(postId);
    expect(post.status).toBe('published');
    expect(post.targets[0]).toMatchObject({ externalId: '7311', permalink: 'https://www.tiktok.com/@mai.tiktok/video/7311' });
    expect(calls.map((c) => c.slug)).toEqual(['TIKTOK_UPLOAD_VIDEO', 'TIKTOK_FETCH_PUBLISH_STATUS', 'TIKTOK_FETCH_PUBLISH_STATUS']);
  });

  it('Instagram reel: the publish step on a later tick claims the target first', async () => {
    asset('v1', 'video');
    const postId = scheduledPost([account('instagram')], ['v1'], T0 + 10 * MIN, 'reel');
    script({
      INSTAGRAM_POST_IG_USER_MEDIA: () => ({ id: 'cr1' }),
      INSTAGRAM_GET_POST_STATUS: () => ({ status_code: 'FINISHED' }),
      INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: () => ({ id: 'm9' }),
      INSTAGRAM_GET_IG_MEDIA: () => ({ permalink: 'https://www.instagram.com/reel/r/' }),
    });
    await publisherTick(T0 + 10 * MIN);
    expect(requirePost(postId).targets[0].status).toBe('processing');
    // While publishing is switched off the mutating poll waits.
    saveSettings({ publishEnabled: false });
    await publisherTick(T0 + 11 * MIN);
    expect(calls.map((c) => c.slug)).toEqual(['INSTAGRAM_POST_IG_USER_MEDIA']);
    saveSettings({ publishEnabled: true });
    await publisherTick(T0 + 12 * MIN);
    expect(requirePost(postId).targets[0]).toMatchObject({ status: 'published', externalId: 'm9' });
  });

  it('Facebook: hands off to Content Studio, then mirrors its outcome', async () => {
    asset('a1');
    setFbSetting('enabled', '1');
    addFbPage({ id: 'page1' });
    const fb = account('facebook');
    const postId = scheduledPost([fb], ['a1']);
    h.hasKey = false; // the hand-off itself never needs Composio on the KOL side
    await publisherTick(T0 + 10 * MIN);
    const t = getTargetRow(requirePost(postId).targets[0].id)!;
    expect(t.status).toBe('processing');
    const row = getFbContent(t.fb_content_id!)!;
    expect(row).toMatchObject({ status: 'scheduled', origin: 'kol', caption: 'Chiều nay\n\nẢnh tạo bằng AI.' });
    const media = JSON.parse(row.media_json) as { path: string }[];
    expect(media[0].path.startsWith(path.join(root, 'stage', t.id))).toBe(true);

    // Content Studio publishes it.
    updateFbContentFields(row.id, { status: 'published', fb_post_id: '1_2', permalink: 'https://www.facebook.com/1/posts/2', published_at: T0 + 11 * MIN });
    await publisherTick(T0 + 11 * MIN);
    const post = requirePost(postId);
    expect(post.status).toBe('published');
    expect(post.targets[0]).toMatchObject({ externalId: '1_2', permalink: 'https://www.facebook.com/1/posts/2' });
    expect(fs.existsSync(path.join(root, 'stage', t.id))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('two platforms, one fails: post partial and one summary', async () => {
    asset('a1');
    const ig = account('instagram');
    const ig2 = account('instagram', { external_id: 'ig-2', handle: '@mai.two' });
    const postId = scheduledPost([ig, ig2], ['a1']);
    script({
      INSTAGRAM_POST_IG_USER_MEDIA: (args) => { if (args.ig_user_id === 'ig-2') throw new Error('(#9004) media not accepted'); return { id: 'c1' }; },
      INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: () => ({ id: 'm1' }),
      INSTAGRAM_GET_IG_MEDIA: () => ({ permalink: 'https://www.instagram.com/p/x/' }),
    });
    await publisherTick(T0 + 10 * MIN);
    expect(requirePost(postId).status).toBe('partial');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/một phần/);
    expect(notes[0]).toContain('✓');
    expect(notes[0]).toContain('✗');
  });

  it('a missing disclosure or unapproved media fails the target without calling the platform', async () => {
    asset('a1');
    const postId = scheduledPost([account('instagram')], ['a1']);
    h.personas.set('p1', persona({ disclosureText: '' }));
    script(IG_OK);
    await publisherTick(T0 + 10 * MIN);
    expect(calls).toEqual([]);
    expect(requirePost(postId).targets[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('công bố') });
  });

  it('publish-now is picked up by the next tick even outside the posting window', async () => {
    asset('a1');
    const ig = account('instagram', { window_start: '08:00', window_end: '09:00' });
    vi.setSystemTime((T0 - HOUR) * 1000);
    const p = createPost('p1', { title: 'x', caption: 'c', assetIds: ['a1'], accountIds: [ig] });
    approvePost(p.id, null, T0 - HOUR);
    publishNowPost(p.id, T0);
    script(IG_OK);
    await publisherTick(T0);
    expect(requirePost(p.id).status).toBe('published');
  });
});

describe('interrupted runs', () => {
  it('targets stuck in publishing > 15 min become failed with the uncertain message, never re-posted', async () => {
    asset('a1');
    const postId = scheduledPost([account('instagram')], ['a1']);
    const tid = requirePost(postId).targets[0].id;
    kolDb().prepare(`UPDATE kol_post_targets SET status = 'publishing', attempts = 1, updated_at = ? WHERE id = ?`).run(T0, tid);
    expect(await recoverStuckTargets(T0 + 10 * MIN)).toBe(0);
    expect(getTargetRow(tid)!.status).toBe('publishing');
    expect(await recoverStuckTargets(T0 + 16 * MIN)).toBe(1);
    expect(getTargetRow(tid)).toMatchObject({ status: 'failed', error: UNCERTAIN_MESSAGE });
    expect(requirePost(postId).status).toBe('failed');
    expect(notes[0]).toMatch(/bị gián đoạn/);
    script(IG_OK);
    await publisherTick(T0 + 20 * MIN);
    expect(calls).toEqual([]);
  });
});

describe('classifyPublishFailure', () => {
  it('maps errors to retry / expired / uncertain / fatal', () => {
    expect(classifyPublishFailure(new Error('502 Bad Gateway'), 'tiktok', true).kind).toBe('retryable');
    expect(classifyPublishFailure(new Error('504 Gateway Timeout'), 'tiktok', true).kind).toBe('uncertain');
    expect(classifyPublishFailure(new Error('socket hang up'), 'youtube', true)).toEqual({ kind: 'uncertain', message: UNCERTAIN_MESSAGE });
    expect(classifyPublishFailure(new Error('quota exceeded'), 'youtube', true).kind).toBe('fatal');
  });
});
