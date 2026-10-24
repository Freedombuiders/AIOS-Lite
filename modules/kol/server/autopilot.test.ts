import { randomUUID } from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssetDto, GenerationDto, GenerationRequest, PersonaDto, Platform } from './types.js';

const h = vi.hoisted(() => ({
  personas: new Map<string, unknown>(),
  assets: new Map<string, unknown>(),
  gens: [] as unknown[],
  spent: 0,
  genError: null as Error | null,
  patched: [] as string[],
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
  patchAsset: (id: string, patch: { status?: string }) => {
    h.patched.push(id);
    const a = h.assets.get(id) as AssetDto;
    if (patch.status) a.status = patch.status as AssetDto['status'];
    return a;
  },
}));
vi.mock('./generations.js', () => ({
  requestGeneration: (req: GenerationRequest, requestedBy: string) => {
    if (h.genError) throw h.genError;
    const g = {
      id: `g${h.gens.length + 1}`, personaId: req.personaId, kind: req.mode === 'animate' ? 'video' : 'image', mode: req.mode, status: 'queued',
      provider: 'gemini', model: 'm', params: req.params ?? {}, selection: req.selection ?? {}, prompt: '', refs: [],
      estimateUsd: req.mode === 'animate' ? 0.8 : 0.04 * (req.params?.count ?? 1), costUsd: 0, error: '', requestedBy, postId: req.postId ?? null,
      assetIds: [], createdAt: 0, startedAt: null, finishedAt: null,
    };
    h.gens.push(g);
    return g;
  },
  getGeneration: (id: string) => (h.gens as GenerationDto[]).find((g) => g.id === id) ?? null,
  listGenerationsForPost: (postId: string) => (h.gens as GenerationDto[]).filter((g) => g.postId === postId),
}));
vi.mock('./spend.js', () => ({ spendByDay: () => [], personaSpendSince: () => h.spent }));

import { _initTestDatabase } from './test-db.js';
import { setPublishNotifier } from './accounts.js';
import type { AgentTurnInput } from './agent-turn.js';
import {
  advanceAutopilotPosts,
  aspectFor,
  autopilotTick,
  imageCountFor,
  missingPerPlatform,
  normalizeAutopilot,
  planForPersona,
  rankAssets,
  runAutopilotNow,
} from './autopilot.js';
import { kolDb, saveSettings } from './core.js';
import { listPosts, requirePost } from './posts.js';
import { checkSchedule } from './schedule-rules.js';

const T0 = Date.UTC(2026, 9, 20, 1, 0, 0) / 1000; // 08:00 Vietnam
const HOUR = 3600;

let notes: string[];
let turns: AgentTurnInput[];
let planIdeasOut: unknown[];

function persona(auto: Partial<PersonaDto['autopilot']> = {}, over: Partial<PersonaDto> = {}): PersonaDto {
  return {
    id: 'p1', name: 'Mai', handle: '@mai.ai', status: 'active', tagline: '', niche: '', languages: ['vi'], bio: '',
    appearance: { gender: '', ageRange: '', ethnicity: '', face: '', eyes: '', skin: '', hair: '', body: '', marks: '', styleKeywords: [], signatureLook: '' },
    personality: { traits: [], values: [], backstory: '', voiceTone: '', writingStyle: '', catchphrases: [], do: [], dont: [] },
    audience: '', pillars: [{ id: 'pl1', name: 'Du lịch', description: '', share: 100 }], identitySource: 'synthetic', consentNote: '',
    disclosureText: 'Ảnh AI.', voiceId: '', brainAgent: 'main', imageModel: '', videoModel: '', realismPreset: 'pro-photo',
    consistencyThreshold: 80, autoRejectDrift: false, monthlyCapUsd: null,
    autopilot: { enabled: true, postsPerWeek: { instagram: 7 }, leadDays: 3, requireApproval: true, imagesPerPost: 2, generateMedia: true, weeklyBudgetUsd: 5, ...auto },
    coverAssetId: null, refs: [], createdAt: 0, updatedAt: 0, ...over,
  };
}

function account(platform: Platform, over: Record<string, unknown> = {}): string {
  const id = randomUUID();
  const row = {
    id, persona_id: 'p1', platform, connection_id: 'ca', entity_id: 'u', external_id: `${platform}-1`, handle: `@mai.${platform}`,
    max_posts_per_day: 2, min_gap_minutes: 180, window_start: '08:00', window_end: '22:00', timezone: 'Asia/Ho_Chi_Minh', status: 'ACTIVE', enabled: 1,
    created_at: T0, updated_at: T0, ...over,
  };
  const keys = Object.keys(row);
  kolDb().prepare(`INSERT INTO kol_accounts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => (row as Record<string, unknown>)[k]));
  return id;
}

function asset(id: string, score: number | null, verdict: 'pass' | 'warn' | 'fail' | null, kind: 'image' | 'video' = 'image'): void {
  h.assets.set(id, {
    id, personaId: 'p1', generationId: null, kind, url: '', thumbUrl: null, mime: kind === 'image' ? 'image/jpeg' : 'video/mp4',
    width: 1080, height: kind === 'image' ? 1350 : 1920, durationSec: kind === 'video' ? 8 : null, bytes: 1, status: 'new', favorite: false,
    consistency: { score, verdict, notes: '' }, model: '', provider: '', costUsd: 0, prompt: '', tags: [], createdAt: 0,
  } satisfies AssetDto);
}

function finish(genId: string, assetIds: string[], status: GenerationDto['status'] = 'succeeded'): void {
  const g = (h.gens as GenerationDto[]).find((x) => x.id === genId)!;
  g.status = status;
  g.assetIds = assetIds;
}

/** Fake brain: plans from planIdeasOut, writes valid captions. */
async function runner(input: AgentTurnInput) {
  turns.push(input);
  if (input.usageKey.startsWith('kol:plan:')) return { text: JSON.stringify({ summary: 'Ba ngày tới: du lịch Đà Lạt.', ideas: planIdeasOut }), model: 'm', costUsd: 0 };
  if (input.usageKey.startsWith('kol:captions:')) {
    return { text: JSON.stringify({ variants: { instagram: { caption: 'Caption từ AI', hashtags: ['dalat', 'travel', 'chill'] } } }), model: 'm', costUsd: 0 };
  }
  return { text: '', model: 'm', costUsd: 0, error: 'unexpected' };
}

const idea = (title: string, over: Record<string, unknown> = {}) => ({ title, pillar: 'Du lịch', format: 'photo', platforms: ['instagram'], brief: 'b', caption: 'c', selection: {}, ...over });

beforeEach(() => {
  _initTestDatabase();
  h.personas.clear();
  h.assets.clear();
  h.gens = [];
  h.spent = 0;
  h.genError = null;
  h.patched = [];
  h.personas.set('p1', persona());
  notes = [];
  turns = [];
  planIdeasOut = [];
  setPublishNotifier(async (t) => { notes.push(t); });
  saveSettings({ autopilotEnabled: true });
  vi.useFakeTimers();
  vi.setSystemTime(T0 * 1000);
});

afterEach(() => {
  setPublishNotifier(null);
  vi.useRealTimers();
});

describe('pure helpers', () => {
  it('missing posts per platform over the lead window', () => {
    expect(missingPerPlatform({ instagram: 7, tiktok: 3, youtube: 0 }, 3, { instagram: 1 }, ['instagram', 'tiktok', 'youtube'])).toEqual({ instagram: 2, tiktok: 2 });
    expect(missingPerPlatform({ instagram: 7 }, 3, { instagram: 3 }, ['instagram'])).toEqual({});
    expect(missingPerPlatform({ facebook: 5 }, 3, {}, ['instagram'])).toEqual({});
  });
  it('aspect, counts, ranking, normalization', () => {
    expect(aspectFor('reel')).toBe('9:16');
    expect(aspectFor('photo')).toBe('4:5');
    expect(imageCountFor('carousel', 1)).toBe(2);
    expect(imageCountFor('photo', 9)).toBe(4);
    asset('x1', 70, 'warn');
    asset('x2', 95, 'pass');
    asset('x3', 99, 'fail');
    asset('x4', null, null);
    expect(rankAssets(['x1', 'x2', 'x3', 'x4'].map((id) => h.assets.get(id) as AssetDto), 'image').map((a) => a.id)).toEqual(['x2', 'x1', 'x4']);
    expect(normalizeAutopilot({ leadDays: 99, imagesPerPost: 0, postsPerWeek: { instagram: -1, tiktok: 3 } })).toMatchObject({ leadDays: 14, imagesPerPost: 1, postsPerWeek: { tiktok: 3 }, requireApproval: true });
  });
});

describe('planning', () => {
  it('asks for exactly the missing ideas, creates autopilot drafts at valid slots and requests media', async () => {
    const ig = account('instagram');
    planIdeasOut = [idea('Đồi chè', { when: '2026-10-20T15:00' }), idea('Hồ Xuân Hương'), idea('Thừa')];
    const res = await planForPersona(persona(), { runner, now: T0 });
    // 7/week × 3 days = 3 needed, none planned yet → 3 posts.
    expect(res.created).toHaveLength(3);
    const planTurn = turns.find((t) => t.usageKey === 'kol:plan:p1')!;
    expect(planTurn.prompt).toContain('instagram: 3');
    const posts = listPosts({ personaId: 'p1' }).sort((a, b) => a.scheduledAt! - b.scheduledAt!);
    expect(posts.every((p) => p.source === 'autopilot' && p.status === 'draft' && p.sourceRef === res.insight!.id)).toBe(true);
    expect(posts.find((p) => p.title === 'Đồi chè')!.scheduledAt).toBe(Date.UTC(2026, 9, 20, 8, 0) / 1000); // the proposed 15:00 local fits
    expect(posts[0].scheduledAt).toBe(T0 + 2 * HOUR); // the next idea takes the first free slot (10:00 local)
    // Every proposed time respects the account rules against the others.
    const rules = { label: 'x', timezone: 'Asia/Ho_Chi_Minh', maxPostsPerDay: 2, minGapMinutes: 180, windowStart: '08:00', windowEnd: '22:00' };
    for (const p of posts) {
      const others = posts.filter((o) => o !== p).map((o) => o.scheduledAt!);
      expect(checkSchedule(rules, p.scheduledAt!, T0, others).ok).toBe(true);
    }
    expect(posts[0].targets).toEqual([expect.objectContaining({ accountId: ig, status: 'pending' })]);
    expect(h.gens).toHaveLength(3);
    expect(h.gens[0]).toMatchObject({ mode: 'compose', requestedBy: 'autopilot', params: { count: 2, aspect: '4:5' } });
    expect(res.insight!.postIds).toHaveLength(3);
  });

  it('counts already planned posts and skips when nothing is missing', async () => {
    account('instagram');
    planIdeasOut = [idea('A'), idea('B'), idea('C')];
    await planForPersona(persona(), { runner, now: T0 });
    turns = [];
    const again = await planForPersona(persona(), { runner, now: T0 + HOUR });
    expect(again).toMatchObject({ insight: null, created: [] });
    expect(turns).toEqual([]);
    const manual = await runAutopilotNow('p1', runner, T0 + HOUR);
    expect(manual.summary).toMatch(/đã đủ bài/);
  });

  it('stops generating when the weekly budget would be exceeded: the post goes to review with a note', async () => {
    account('instagram');
    h.personas.set('p1', persona({ weeklyBudgetUsd: 0.1, imagesPerPost: 1 }));
    h.spent = 0.04;
    planIdeasOut = [idea('A'), idea('B')];
    await planForPersona(persona({ weeklyBudgetUsd: 0.1, imagesPerPost: 1 }), { runner, now: T0 });
    expect(h.gens).toHaveLength(1); // 0.04 + 0.04 ≤ 0.1, then 0.08 + 0.05 > 0.1
    const posts = listPosts({ personaId: 'p1' });
    const stopped = posts.find((p) => p.status === 'review')!;
    expect(stopped.feedback).toMatch(/vượt ngân sách tuần/);
    expect(stopped.variants.instagram?.caption).toBe('Caption từ AI');
  });

  it('a planner answer that is not valid JSON creates nothing (502)', async () => {
    account('instagram');
    const bad = async (input: AgentTurnInput) => {
      turns.push(input);
      return { text: 'Xin lỗi, tôi không thể.', model: 'm', costUsd: 0 };
    };
    await expect(planForPersona(persona(), { runner: bad, now: T0 })).rejects.toMatchObject({ status: 502 });
    expect(listPosts({ personaId: 'p1' })).toEqual([]);
    expect(h.gens).toEqual([]);
  });

  it('a generation refused by the studio (kill switch, caps) ends in review with the reason', async () => {
    account('instagram');
    const { KolError } = await import('./core.js');
    h.genError = new KolError(402, 'Vượt hạn mức ngày.');
    planIdeasOut = [idea('A')];
    await planForPersona(persona(), { runner, now: T0 });
    expect(listPosts({ personaId: 'p1' })[0]).toMatchObject({ status: 'review', feedback: expect.stringContaining('Vượt hạn mức ngày') });
  });
});

describe('advancing drafts', () => {
  it('attaches the best image when generations finish, writes captions and moves to review', async () => {
    account('instagram');
    planIdeasOut = [idea('A')];
    h.personas.set('p1', persona({ postsPerWeek: { instagram: 2 } }));
    await planForPersona(persona({ postsPerWeek: { instagram: 2 } }), { runner, now: T0 });
    const post = listPosts({ personaId: 'p1' })[0];

    expect(await advanceAutopilotPosts(persona(), runner, T0 + 60)).toEqual({ review: 0, scheduled: 0 }); // still queued
    asset('i1', 70, 'pass');
    asset('i2', 92, 'pass');
    asset('i3', 99, 'fail');
    finish('g1', ['i1', 'i2', 'i3']);
    expect(await advanceAutopilotPosts(persona(), runner, T0 + 120)).toEqual({ review: 1, scheduled: 0 });
    const out = requirePost(post.id);
    expect(out).toMatchObject({ status: 'review', assetIds: ['i2'] });
    expect(out.variants.instagram).toEqual({ caption: 'Caption từ AI', hashtags: ['dalat', 'travel', 'chill'] });
    expect(h.patched).toEqual([]); // approval required: assets stay 'new'
  });

  it('requireApproval false but the account does not allow auto-publishing → review with a note', async () => {
    account('instagram');
    const ap = { postsPerWeek: { instagram: 2 }, requireApproval: false };
    planIdeasOut = [idea('A')];
    await planForPersona(persona(ap), { runner, now: T0 });
    asset('i1', 90, 'pass');
    finish('g1', ['i1']);
    expect(await advanceAutopilotPosts(persona(ap), runner, T0 + 60)).toEqual({ review: 1, scheduled: 0 });
    expect(listPosts({ personaId: 'p1' })[0].feedback).toMatch(/Tự đăng không cần duyệt/);
    expect(h.patched).toEqual([]);
  });

  it('requireApproval false: approves its own asset and schedules within the rules', async () => {
    account('instagram', { auto_publish: 1 });
    const ap = { postsPerWeek: { instagram: 2 }, requireApproval: false };
    h.personas.set('p1', persona(ap));
    planIdeasOut = [idea('A', { when: '2026-10-20T15:00' })];
    await planForPersona(persona(ap), { runner, now: T0 });
    asset('i1', 90, 'pass');
    finish('g1', ['i1']);
    expect(await advanceAutopilotPosts(persona(ap), runner, T0 + 60)).toEqual({ review: 0, scheduled: 1 });
    const post = listPosts({ personaId: 'p1' })[0];
    expect(post.status).toBe('scheduled');
    expect(post.targets[0].status).toBe('scheduled');
    expect(h.patched).toEqual(['i1']);
  });

  it('video formats: image first, then animate, then the clip is attached', async () => {
    account('instagram');
    const ap = { postsPerWeek: { instagram: 2 } };
    h.personas.set('p1', persona(ap));
    planIdeasOut = [idea('Reel', { format: 'reel' })];
    await planForPersona(persona(ap), { runner, now: T0 });
    expect(h.gens[0]).toMatchObject({ params: { aspect: '9:16' } });
    asset('i1', 88, 'pass');
    finish('g1', ['i1']);
    expect(await advanceAutopilotPosts(persona(ap), runner, T0 + 60)).toEqual({ review: 0, scheduled: 0 });
    expect(h.gens[1]).toMatchObject({ mode: 'animate', selection: { sourceAssetId: 'i1' }, params: { aspect: '9:16' }, requestedBy: 'autopilot' });
    asset('v1', null, 'skipped' as never, 'video');
    finish('g2', ['v1']);
    expect(await advanceAutopilotPosts(persona(ap), runner, T0 + 120)).toEqual({ review: 1, scheduled: 0 });
    expect(listPosts({ personaId: 'p1' })[0]).toMatchObject({ status: 'review', assetIds: ['v1'] });
  });

  it('all images failed QA → review with a note; returned drafts are left alone', async () => {
    account('instagram');
    const ap = { postsPerWeek: { instagram: 2 } };
    planIdeasOut = [idea('A')];
    await planForPersona(persona(ap), { runner, now: T0 });
    asset('i1', 20, 'fail');
    finish('g1', ['i1']);
    await advanceAutopilotPosts(persona(ap), runner, T0 + 60);
    const post = listPosts({ personaId: 'p1' })[0];
    expect(post).toMatchObject({ status: 'review', feedback: expect.stringContaining('độ giống') });
  });
});

describe('tick', () => {
  it('runs once per persona per local day and notifies about posts waiting for review', async () => {
    account('instagram');
    h.personas.set('p1', persona({ generateMedia: false }));
    planIdeasOut = [idea('A'), idea('B'), idea('C')];
    await autopilotTick(T0, runner);
    expect(turns.filter((t) => t.usageKey.startsWith('kol:plan:'))).toHaveLength(1);
    expect(notes).toEqual(['Mai: 3 bài mới chờ duyệt']);
    expect(listPosts({ personaId: 'p1' }).every((p) => p.status === 'review' && /chưa có ảnh/.test(p.feedback))).toBe(true);

    kolDb().prepare(`UPDATE kol_posts SET status = 'cancelled'`).run();
    await autopilotTick(T0 + HOUR, runner);
    expect(turns.filter((t) => t.usageKey.startsWith('kol:plan:'))).toHaveLength(1); // already planned today
  });

  it('does nothing when autopilot is off globally, for the persona, or the persona is not active', async () => {
    account('instagram');
    planIdeasOut = [idea('A')];
    saveSettings({ autopilotEnabled: false });
    await autopilotTick(T0, runner);
    saveSettings({ autopilotEnabled: true });
    h.personas.set('p1', persona({ enabled: false }));
    await autopilotTick(T0, runner);
    h.personas.set('p1', persona({}, { status: 'paused' }));
    await autopilotTick(T0, runner);
    expect(turns).toEqual([]);
  });
});
