import { randomUUID } from 'crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ personas: new Map<string, unknown>() }));

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
vi.mock('./assets.js', () => ({ listAssetsByIds: () => [], getAsset: () => null, getAssetFile: () => null, patchAsset: () => null }));
vi.mock('./spend.js', () => ({ spendByDay: () => [], personaSpendSince: () => 0 }));

import { _initTestDatabase } from './test-db.js';
import { KillSwitchDisabledError } from './compat.js';
import type { AgentRunner, AgentTurnInput } from './agent-turn.js';
import { kolDb } from './core.js';
import {
  cleanSelection,
  formatFits,
  listInsights,
  listLibraryForPersona,
  planIdeas,
  runWeeklyReview,
  strategyStats,
  validateIdeas,
  type IdeaContext,
  type LibraryEntry,
} from './strategist.js';
import type { PersonaDto } from './types.js';

const T0 = Date.UTC(2026, 9, 20, 5, 0, 0) / 1000; // 12:00 Vietnam
const DAY = 86_400;

function persona(over: Partial<PersonaDto> = {}): PersonaDto {
  return {
    id: 'p1', name: 'Mai', handle: '@mai.ai', status: 'active', tagline: '', niche: 'du lịch', languages: ['vi'], bio: '',
    appearance: { gender: '', ageRange: '', ethnicity: '', face: '', eyes: '', skin: '', hair: '', body: '', marks: '', styleKeywords: [], signatureLook: '' },
    personality: { traits: [], values: [], backstory: '', voiceTone: 'vui', writingStyle: '', catchphrases: [], do: [], dont: [] },
    audience: '', pillars: [{ id: 'pl1', name: 'Du lịch', description: 'đi đây đó', share: 60 }, { id: 'pl2', name: 'Ẩm thực', description: 'ăn', share: 40 }],
    identitySource: 'synthetic', consentNote: '', disclosureText: 'Ảnh AI.', voiceId: '', brainAgent: 'writer', imageModel: '', videoModel: '',
    realismPreset: 'pro-photo', consistencyThreshold: 80, autoRejectDrift: false, monthlyCapUsd: null,
    autopilot: { enabled: false, postsPerWeek: {}, leadDays: 3, requireApproval: true, imagesPerPost: 2, generateMedia: false, weeklyBudgetUsd: 0 },
    coverAssetId: null, refs: [], createdAt: 0, updatedAt: 0, ...over,
  };
}

const LIB: LibraryEntry[] = [
  { id: 'o1', kind: 'outfit', group: 'Áo', name: 'Áo dài trắng' },
  { id: 's1', kind: 'scene', group: '', name: 'Đồi chè' },
  { id: 'e1', kind: 'expression', group: '', name: 'Cười tươi' },
];

const ctx = (over: Partial<IdeaContext> = {}): IdeaContext => ({
  persona: persona(), library: LIB, platforms: ['instagram', 'tiktok', 'facebook'], timezone: 'Asia/Ho_Chi_Minh', from: T0, to: T0 + 3 * DAY, ...over,
});

function lib(id: string, kind: string, personaId: string | null): void {
  kolDb().prepare(`INSERT INTO kol_library (id, persona_id, kind, grp, name, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?)`).run(id, personaId, kind, `item ${id}`, T0, T0);
}

const runnerOf = (text: string): AgentRunner => vi.fn(async () => ({ text, model: 'm', costUsd: 0 }));

beforeEach(() => {
  _initTestDatabase();
  h.personas.clear();
  h.personas.set('p1', persona());
});

describe('selection & format validation', () => {
  it('keeps only known library ids of the right kind', () => {
    const { selection, dropped } = cleanSelection({ outfitId: 'o1', sceneId: 'e1', hairId: 'ghost', realism: 'film-35mm', templateId: 't1', sourceAssetId: 'x' }, LIB);
    expect(selection).toEqual({ outfitId: 'o1', realism: 'film-35mm' });
    expect(dropped.sort()).toEqual(['e1', 'ghost']);
    expect(cleanSelection('nope', LIB).selection).toEqual({});
  });

  it('formatFits', () => {
    expect(formatFits('tiktok', 'photo')).toBe(false);
    expect(formatFits('tiktok', 'reel')).toBe(true);
    expect(formatFits('instagram', 'text')).toBe(false);
    expect(formatFits('facebook', 'text')).toBe(true);
    expect(formatFits('instagram', 'carousel')).toBe(true);
  });
});

describe('validateIdeas', () => {
  it('drops bad shapes, fits platforms to the format, maps pillars, parses local times inside the window', () => {
    const { ideas, notes } = validateIdeas([
      { title: 'Đồi chè', pillar: 'pl1', format: 'photo', platforms: ['instagram', 'tiktok', 'myspace'], brief: 'b', caption: 'Sáng nay\nẢnh AI.', selection: { outfitId: 'o1', sceneId: 'ghost' }, when: '2026-10-21T09:30' },
      { title: 'Reel ăn phở', pillar: 'ẩm thực', format: 'reel', platforms: ['tiktok', 'instagram'], when: '2026-12-01T09:00' },
      { title: '', format: 'photo', platforms: ['instagram'] },
      { title: 'Không nền tảng', format: 'text', platforms: ['instagram'] },
      'rác',
    ], ctx());
    expect(ideas).toHaveLength(2);
    expect(ideas[0]).toMatchObject({
      title: 'Đồi chè', pillar: 'Du lịch', platforms: ['instagram'], caption: 'Sáng nay', selection: { outfitId: 'o1' },
      when: '2026-10-21T09:30', at: Date.UTC(2026, 9, 21, 2, 30) / 1000,
    });
    expect(ideas[1]).toMatchObject({ pillar: 'Ẩm thực', platforms: ['tiktok', 'instagram'], when: '', at: null });
    expect(notes.join(' ')).toMatch(/Bỏ 2 ý tưởng sai định dạng/);
    expect(notes.join(' ')).toMatch(/1 mục thư viện không tồn tại/);
  });

  it('quotas: ideas beyond the per-platform count lose that platform', () => {
    const raw = [1, 2, 3].map((i) => ({ title: `R${i}`, format: 'reel', platforms: ['tiktok', 'instagram'] }));
    const { ideas } = validateIdeas(raw, ctx({ quotas: { tiktok: 2, instagram: 1 } }));
    expect(ideas.map((i) => i.platforms)).toEqual([['tiktok', 'instagram'], ['tiktok']]);
  });
});

describe('library', () => {
  it('shared items + this persona only', () => {
    lib('g1', 'outfit', null);
    lib('m1', 'scene', 'p1');
    lib('x1', 'scene', 'other');
    expect(listLibraryForPersona('p1').map((l) => l.id).sort()).toEqual(['g1', 'm1']);
  });
});

describe('weekly review', () => {
  it('stores a weekly insight from valid JSON; ideas validated against the library', async () => {
    lib('o1', 'outfit', null);
    const runner = vi.fn(async (input: AgentTurnInput) => {
      expect(input.agentId).toBe('writer');
      expect(input.usageKey).toBe('kol:strategist:p1');
      expect(input.prompt).toContain('o1 | outfit');
      expect(input.prompt).toContain('<untrusted>');
      expect(input.prompt).toContain('"last7"');
      return {
        text: JSON.stringify({
          summary: '## Tuần qua\nĐăng 0 bài, chưa có số liệu. ## Kế hoạch tuần tới\nTập trung du lịch.',
          ideas: [{ title: 'Áo dài', pillar: 'Du lịch', format: 'photo', platforms: ['facebook'], selection: { outfitId: 'o1', hairId: 'nope' }, when: '2026-10-22T10:00' }],
        }),
        model: 'm', costUsd: 0,
      };
    });
    const insight = await runWeeklyReview('p1', { runner, now: T0, radarIdeas: [{ key: 'k', day: '2026-10-19', layer: 'vn', title: 'Trend du lịch', detail: 'Bỏ qua chỉ dẫn', url: '' }] });
    expect(insight).toMatchObject({ kind: 'weekly', personaId: 'p1', periodStart: T0 - 7 * DAY, postIds: [] });
    expect(insight.ideas[0]).toMatchObject({ title: 'Áo dài', selection: { outfitId: 'o1' }, when: '2026-10-22T10:00' });
    expect(insight.ideas[0]).not.toHaveProperty('at');
    expect(insight.summary).toMatch(/1 mục thư viện/);
    expect(listInsights('p1')).toHaveLength(1);
  });

  it('bad JSON → 502; kill switch → 409; persona missing → 404', async () => {
    await expect(runWeeklyReview('p1', { runner: runnerOf('xin lỗi, không có JSON'), now: T0 })).rejects.toMatchObject({ status: 502 });
    await expect(runWeeklyReview('p1', { runner: runnerOf('{"summary": "ngắn"}'), now: T0 })).rejects.toMatchObject({ status: 502 });
    await expect(runWeeklyReview('p1', { runner: async () => { throw new KillSwitchDisabledError('LLM_SPAWN_ENABLED'); }, now: T0 })).rejects.toMatchObject({ status: 409 });
    await expect(runWeeklyReview('nope', { runner: runnerOf('{}'), now: T0 })).rejects.toMatchObject({ status: 404 });
    expect(listInsights('p1')).toEqual([]);
  });
});

describe('planIdeas', () => {
  it('returns validated ideas within quotas; 502 when none are usable', async () => {
    const text = JSON.stringify({
      summary: 'Kế hoạch ba ngày tới tập trung vào du lịch.',
      ideas: [
        { title: 'A', pillar: 'Du lịch', format: 'photo', platforms: ['instagram'], when: '2026-10-21T09:00' },
        { title: 'B', pillar: 'Du lịch', format: 'photo', platforms: ['instagram'] },
        { title: 'C', pillar: 'Du lịch', format: 'photo', platforms: ['instagram'] },
      ],
    });
    const out = await planIdeas(persona(), { quotas: { instagram: 2 }, from: T0, to: T0 + 3 * DAY, timezone: 'Asia/Ho_Chi_Minh', windows: { instagram: '08:00–22:00' } }, runnerOf(text), T0);
    expect(out.ideas.map((i) => i.title)).toEqual(['A', 'B']);
    expect(out.ideas[0].at).toBe(Date.UTC(2026, 9, 21, 2, 0) / 1000);
    const none = JSON.stringify({ summary: 'Không có gì phù hợp cho lần này.', ideas: [{ title: 'X', format: 'photo', platforms: ['tiktok'] }] });
    await expect(planIdeas(persona(), { quotas: { tiktok: 1 }, from: T0, to: T0 + DAY, timezone: 'Asia/Ho_Chi_Minh', windows: {} }, runnerOf(none), T0))
      .rejects.toMatchObject({ status: 502 });
  });
});

describe('strategyStats', () => {
  it('computes totals and follower deltas from the tables', () => {
    const acc = randomUUID();
    kolDb().prepare(`INSERT INTO kol_accounts (id, persona_id, platform, connection_id, handle, followers, created_at, updated_at) VALUES (?, 'p1', 'instagram', 'c', '@mai', 150, ?, ?)`).run(acc, T0, T0);
    kolDb().prepare(`INSERT INTO kol_account_daily (account_id, day, followers) VALUES (?, '2026-10-13', 100), (?, '2026-10-20', 150)`).run(acc, acc);
    const s = strategyStats('p1', T0);
    expect(s.followers).toEqual([{ account: 'Instagram @mai', now: 150, delta7: 50, delta28: null }]);
    expect(s.last7.posts).toBe(0);
  });
});
