import { randomUUID } from 'crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  personas: new Map<string, unknown>(),
  assets: new Map<string, unknown>(),
  kill: true,
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
  getAssetFile: () => null,
  patchAsset: () => null,
}));
vi.mock('./compat.js', async (orig) => ({ ...(await orig<typeof import('./compat.js')>()), isEnabled: () => h.kill }));

import { _initTestDatabase, addFbPage, getFbContent, insertFbContent } from './test-db.js';
import { kolDb, saveSettings } from './core.js';
import {
  approvePost,
  cancelPost,
  createPost,
  getTargetRow,
  listPosts,
  publishNowPost,
  recomputePostStatus,
  requirePost,
  retryTarget,
  returnPost,
  submitPost,
  updatePost,
} from './posts.js';
import type { AssetDto, PersonaDto, Platform } from './types.js';

const T0 = Date.UTC(2026, 9, 20, 5, 0, 0) / 1000; // 12:00 Vietnam
const HOUR = 3600;

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

function asset(id: string, over: Partial<AssetDto> = {}): AssetDto {
  const a: AssetDto = {
    id, personaId: 'p1', generationId: null, kind: 'image', url: `/api/kol/media/asset/${id}`, thumbUrl: null, mime: 'image/jpeg',
    width: 1080, height: 1350, durationSec: null, bytes: 1000, status: 'approved', favorite: false,
    consistency: { score: 90, verdict: 'pass', notes: '' }, model: '', provider: '', costUsd: 0, prompt: '', tags: [], createdAt: 0, ...over,
  };
  h.assets.set(id, a);
  return a;
}

function account(platform: Platform, over: Record<string, unknown> = {}): string {
  const id = randomUUID();
  const row = {
    id, persona_id: 'p1', platform, connection_id: 'ca_1', entity_id: 'u1', external_id: `${platform}-ext-${id.slice(0, 4)}`,
    handle: `@mai.${platform}`, display_name: 'Mai', max_posts_per_day: 2, min_gap_minutes: 180, window_start: '08:00', window_end: '22:00',
    timezone: 'Asia/Ho_Chi_Minh', status: 'ACTIVE', enabled: 1, created_at: T0, updated_at: T0, ...over,
  };
  const keys = Object.keys(row);
  kolDb().prepare(`INSERT INTO kol_accounts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => (row as Record<string, unknown>)[k]));
  return id;
}

function fbPage(id: string, over: Record<string, unknown> = {}): void {
  addFbPage({ id, ...over });
}

beforeEach(() => {
  _initTestDatabase();
  h.personas.clear();
  h.assets.clear();
  h.kill = true;
  h.personas.set('p1', persona());
  vi.useFakeTimers();
  vi.setSystemTime(T0 * 1000);
});

describe('create / list / update', () => {
  it('creates a draft with pending targets and normalized hashtags', () => {
    asset('a1');
    const ig = account('instagram');
    const p = createPost('p1', { title: 'Đà Lạt', caption: 'Chiều nay', hashtags: ['#DaLat', 'dalat'], assetIds: ['a1'], accountIds: [ig] });
    expect(p).toMatchObject({ status: 'draft', format: 'photo', hashtags: ['DaLat'], assetIds: ['a1'], source: 'owner' });
    expect(p.assets[0].id).toBe('a1');
    expect(p.targets).toHaveLength(1);
    expect(p.targets[0]).toMatchObject({ platform: 'instagram', status: 'pending', handle: '@mai.instagram' });
    expect(listPosts({ personaId: 'p1' }).map((x) => x.id)).toEqual([p.id]);
    expect(listPosts({ personaId: 'p1', status: 'review' })).toEqual([]);
  });

  it('infers the format from the media', () => {
    asset('v1', { kind: 'video', mime: 'video/mp4', width: 1080, height: 1920, durationSec: 10 });
    asset('a1');
    asset('a2');
    expect(createPost('p1', { assetIds: ['v1'] }).format).toBe('reel');
    expect(createPost('p1', { assetIds: ['a1', 'a2'] }).format).toBe('carousel');
  });

  it('refuses media or accounts of another persona', () => {
    asset('x1', { personaId: 'other' });
    expect(() => createPost('p1', { assetIds: ['x1'] })).toThrow(/của chính KOL này/);
    const other = account('instagram', { persona_id: 'other' });
    expect(() => createPost('p1', { accountIds: [other] })).toThrow(/không thuộc KOL này/);
    expect(() => createPost('nope', {})).toThrow(/Không tìm thấy KOL/);
  });

  it('PATCH replaces targets and refuses after publishing started', () => {
    const ig = account('instagram');
    const tt = account('tiktok');
    const p = createPost('p1', { accountIds: [ig] });
    const u = updatePost(p.id, { accountIds: [tt], caption: 'mới' });
    expect(u.targets.map((t) => t.platform)).toEqual(['tiktok']);
    expect(u.caption).toBe('mới');
    kolDb().prepare(`UPDATE kol_posts SET status = 'publishing' WHERE id = ?`).run(p.id);
    expect(() => updatePost(p.id, { caption: 'x' })).toThrow(/đang được đăng/);
  });
});

describe('state machine', () => {
  it('draft → review → approved (no time) → scheduled (with time)', () => {
    asset('a1');
    const ig = account('instagram');
    const p = createPost('p1', { title: 'A', assetIds: ['a1'], accountIds: [ig] });
    expect(submitPost(p.id).status).toBe('review');
    const approved = approvePost(p.id);
    expect(approved.status).toBe('approved');
    expect(approved.targets[0].status).toBe('pending');
    const scheduled = approvePost(p.id, T0 + 2 * HOUR);
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.scheduledAt).toBe(T0 + 2 * HOUR);
    expect(scheduled.targets[0].status).toBe('scheduled');
  });

  it('approve keeps a future scheduledAt that was proposed earlier', () => {
    asset('a1');
    const ig = account('instagram');
    const p = createPost('p1', { assetIds: ['a1'], accountIds: [ig], scheduledAt: T0 + 3 * HOUR });
    expect(approvePost(p.id).status).toBe('scheduled');
  });

  it('return with feedback → draft and targets back to pending', () => {
    asset('a1');
    const ig = account('instagram');
    const p = createPost('p1', { assetIds: ['a1'], accountIds: [ig] });
    approvePost(p.id, T0 + 2 * HOUR);
    expect(() => returnPost(p.id, '  ')).toThrow(/nhận xét/);
    const r = returnPost(p.id, 'Đổi ảnh khác');
    expect(r).toMatchObject({ status: 'draft', feedback: 'Đổi ảnh khác' });
    expect(r.targets[0].status).toBe('pending');
    expect(() => returnPost(p.id, 'x')).toThrow(/Không trả về nháp/);
  });

  it('only approved media may be scheduled; a draft can hold any', () => {
    asset('a1', { status: 'new' });
    const ig = account('instagram');
    const p = createPost('p1', { assetIds: ['a1'], accountIds: [ig] });
    expect(() => approvePost(p.id, T0 + 2 * HOUR)).toThrow(/đã duyệt/);
    expect(requirePost(p.id).status).toBe('draft');
  });

  it('format checks per platform (400)', () => {
    asset('a1');
    const tt = account('tiktok');
    const p = createPost('p1', { assetIds: ['a1'], accountIds: [tt] });
    expect(() => approvePost(p.id, T0 + 2 * HOUR)).toThrow(/TikTok chỉ đăng video/);
  });

  it('scheduling rules answer 409 naming the account', () => {
    asset('a1');
    asset('a2');
    const ig = account('instagram', { handle: '@mai.ai' });
    const first = createPost('p1', { assetIds: ['a1'], accountIds: [ig] });
    approvePost(first.id, T0 + 2 * HOUR);
    const second = createPost('p1', { assetIds: ['a2'], accountIds: [ig] });
    try {
      approvePost(second.id, T0 + 3 * HOUR);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 409 });
      expect((err as Error).message).toContain('Instagram @mai.ai');
      expect((err as Error).message).toMatch(/tối thiểu 180 phút/);
    }
    // Outside the window (23:00 local).
    expect(() => approvePost(second.id, Date.UTC(2026, 9, 20, 16, 0) / 1000)).toThrow(/ngoài khung/);
    expect(approvePost(second.id, T0 + 6 * HOUR).status).toBe('scheduled');
  });

  it('a channel shared by two KOLs counts both KOLs\' posts for the gap', () => {
    h.personas.set('p2', persona({ id: 'p2', name: 'Tony' }));
    const video = { kind: 'video', mime: 'video/mp4', width: 1080, height: 1920, durationSec: 30 } as const;
    asset('a1', video);
    asset('a2', { ...video, personaId: 'p2' });
    const mine = account('youtube', { external_id: 'UC-shared' });
    const theirs = account('youtube', { external_id: 'UC-shared', persona_id: 'p2' });
    approvePost(createPost('p1', { format: 'video', assetIds: ['a1'], accountIds: [mine] }).id, T0 + 2 * HOUR);
    const other = createPost('p2', { format: 'video', assetIds: ['a2'], accountIds: [theirs] });
    expect(() => approvePost(other.id, T0 + 3 * HOUR)).toThrow(/tối thiểu 180 phút/);
    expect(approvePost(other.id, T0 + 6 * HOUR).status).toBe('scheduled');
  });

  it('refuses disabled or expired accounts and a persona without disclosure', () => {
    asset('a1');
    const off = account('instagram', { enabled: 0 });
    const p = createPost('p1', { assetIds: ['a1'], accountIds: [off] });
    expect(() => approvePost(p.id, T0 + 2 * HOUR)).toThrow(/đang tắt/);
    kolDb().prepare(`UPDATE kol_accounts SET enabled = 1, status = 'EXPIRED' WHERE id = ?`).run(off);
    expect(() => approvePost(p.id, T0 + 2 * HOUR)).toThrow(/hết hạn/);
    kolDb().prepare(`UPDATE kol_accounts SET status = 'ACTIVE' WHERE id = ?`).run(off);
    h.personas.set('p1', persona({ disclosureText: ' ' }));
    expect(() => approvePost(p.id, T0 + 2 * HOUR)).toThrow(/công bố/);
  });

  it('Facebook targets need an enabled, active Content Studio Page', () => {
    const fb = account('facebook', { external_id: 'page1' });
    const p = createPost('p1', { format: 'text', caption: 'Xin chào', accountIds: [fb] });
    expect(() => approvePost(p.id, T0 + 2 * HOUR)).toThrow(/Fanpage/);
    fbPage('page1');
    expect(approvePost(p.id, T0 + 2 * HOUR).status).toBe('scheduled');
  });

  it('a scheduled post is re-checked when edited', () => {
    asset('a1');
    asset('v1', { kind: 'video', mime: 'video/mp4', width: 1080, height: 1920, durationSec: 10 });
    const ig = account('instagram');
    const p = createPost('p1', { assetIds: ['a1'], accountIds: [ig] });
    approvePost(p.id, T0 + 2 * HOUR);
    expect(() => updatePost(p.id, { scheduledAt: T0 - HOUR })).toThrow(/đã qua/);
    const tt = account('tiktok');
    expect(() => updatePost(p.id, { accountIds: [ig, tt] })).toThrow(/TikTok/);
    const moved = updatePost(p.id, { scheduledAt: T0 + 5 * HOUR });
    expect(moved.scheduledAt).toBe(T0 + 5 * HOUR);
    expect(moved.status).toBe('scheduled');
    const withTt = updatePost(p.id, { format: 'reel', assetIds: ['v1'], accountIds: [ig, tt] });
    expect(withTt.targets.map((t) => [t.platform, t.status])).toEqual([['instagram', 'scheduled'], ['tiktok', 'scheduled']]);
  });
});

describe('publish-now, retry, cancel, derived status', () => {
  beforeEach(() => {
    saveSettings({ publishEnabled: true });
  });

  it('publish-now: due now, bypasses the window but needs publishing on', () => {
    asset('a1');
    const ig = account('instagram');
    const p = createPost('p1', { assetIds: ['a1'], accountIds: [ig] });
    approvePost(p.id);
    // 23:30 local: outside the window, still allowed for publish-now.
    vi.setSystemTime(Date.UTC(2026, 9, 20, 16, 30) * 1);
    const now = Date.UTC(2026, 9, 20, 16, 30) / 1000;
    const out = publishNowPost(p.id, now);
    expect(out.status).toBe('scheduled');
    expect(out.scheduledAt).toBe(now);
    expect(getTargetRow(out.targets[0].id)!.next_attempt_at).toBe(now);

    saveSettings({ publishEnabled: false });
    expect(() => publishNowPost(p.id, now)).toThrow(/Cho phép đăng bài/);
    saveSettings({ publishEnabled: true });
    h.kill = false;
    expect(() => publishNowPost(p.id, now)).toThrow(/Cho phép đăng bài của KOL/);
  });

  it('publish-now still applies format checks', () => {
    asset('a1');
    const yt = account('youtube');
    const p = createPost('p1', { assetIds: ['a1'], accountIds: [yt] });
    approvePost(p.id);
    expect(() => publishNowPost(p.id, T0)).toThrow(/YouTube chỉ đăng video/);
  });

  it('retry: a failed target is scheduled now, the post goes back to publishing', () => {
    asset('a1');
    const ig = account('instagram');
    const fb = account('facebook', { external_id: 'page1' });
    fbPage('page1');
    const p = createPost('p1', { assetIds: ['a1'], accountIds: [ig, fb] });
    approvePost(p.id, T0 + 2 * HOUR);
    const [tFb, tIg] = requirePost(p.id).targets;
    kolDb().prepare(`UPDATE kol_post_targets SET status = 'published', published_at = ? WHERE id = ?`).run(T0 + 2 * HOUR, tFb.id);
    kolDb().prepare(`UPDATE kol_post_targets SET status = 'failed', error = 'x', attempts = 3 WHERE id = ?`).run(tIg.id);
    expect(recomputePostStatus(p.id).after).toBe('partial');
    expect(requirePost(p.id).publishedAt).toBe(T0 + 2 * HOUR);

    expect(() => retryTarget(p.id, tFb.id, T0)).toThrow(/thất bại hoặc lỡ giờ/);
    const out = retryTarget(p.id, tIg.id, T0 + 3 * HOUR);
    expect(out.status).toBe('publishing');
    const row = getTargetRow(tIg.id)!;
    expect(row).toMatchObject({ status: 'scheduled', attempts: 0, error: '', next_attempt_at: T0 + 3 * HOUR });
  });

  it('cancel: waiting targets skipped; refused while publishing; withdraws an unstarted Facebook hand-off', () => {
    asset('a1');
    const ig = account('instagram');
    const fb = account('facebook', { external_id: 'page1' });
    fbPage('page1');
    const p = createPost('p1', { assetIds: ['a1'], accountIds: [ig, fb] });
    approvePost(p.id, T0 + 2 * HOUR);
    const [tFb, tIg] = requirePost(p.id).targets;
    const fbId = insertFbContent({ page_id: 'page1', caption: 'x', format: 'photo', status: 'scheduled', scheduled_at: T0 });
    kolDb().prepare(`UPDATE kol_post_targets SET status = 'processing', fb_content_id = ? WHERE id = ?`).run(fbId, tFb.id);
    kolDb().prepare(`UPDATE kol_post_targets SET status = 'publishing' WHERE id = ?`).run(tIg.id);
    expect(() => cancelPost(p.id)).toThrow(/đang được đăng/);
    kolDb().prepare(`UPDATE kol_post_targets SET status = 'scheduled' WHERE id = ?`).run(tIg.id);
    cancelPost(p.id);
    const out = requirePost(p.id);
    expect(out.status).toBe('cancelled');
    expect(out.targets.every((t) => t.status === 'skipped')).toBe(true);
    expect(getFbContent(fbId)).toBeUndefined();
  });

  it('cancel refuses when Content Studio already started the Facebook post', () => {
    const fb = account('facebook', { external_id: 'page1' });
    fbPage('page1');
    const p = createPost('p1', { format: 'text', caption: 'x', accountIds: [fb] });
    approvePost(p.id, T0 + 2 * HOUR);
    const t = requirePost(p.id).targets[0];
    const fbId = insertFbContent({ page_id: 'page1', caption: 'x', format: 'text', status: 'publishing', scheduled_at: T0 });
    kolDb().prepare(`UPDATE kol_post_targets SET status = 'processing', fb_content_id = ? WHERE id = ?`).run(fbId, t.id);
    expect(() => cancelPost(p.id)).toThrow(/đang được đăng/);
    expect(getFbContent(fbId)?.status).toBe('publishing');
  });
});
