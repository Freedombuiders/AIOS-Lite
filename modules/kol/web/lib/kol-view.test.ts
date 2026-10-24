import { describe, expect, it } from 'vitest';
import {
  buildImageRequest, composerFromGeneration, composerMode, fitsGender, genderOfText, etaSeconds, evenShares, filterLibrary, fmtAgo, fmtClock, fmtCompact,
  fmtEta, fmtInt, fmtPct, fmtRate, fmtUsd, formatWarnings, generateBlocker, groupCounts, hourIntensity, isInstagramFeedAspect,
  meterPercent, modelOptions, moveRefPatches, parseHashtags, personaAvatar, pickCount, pickModel, postActions, postEditable,
  postsByDay, secondsPerImage, splitForParallel, startOfWeek, suggestHandle, sumFollowers, supportsSeed, templateGroups,
  verdictFor, weekDays, type ComposerState,
} from './kol-view';
import type { GenerationDto, KolStatusDto, LibraryItemDto, ModelInfo, PostDto, RefDto, TemplateDto } from './kol';

const model = (id: string, provider: ModelInfo['provider'], extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id, provider, kind: 'image', label: id, maxRefs: 4, aspects: ['1:1', '4:5'], qualities: ['standard'], priceNote: '≈ $0,04/ảnh', ...extra,
});

function status(over: Partial<KolStatusDto> = {}): KolStatusDto {
  return {
    enabled: true,
    providers: [
      { id: 'gemini', label: 'Gemini', configured: true, hint: '', models: [model('g-img', 'gemini', { recommended: true }), model('veo', 'gemini', { kind: 'video', durations: [5, 8] })] },
      { id: 'fal', label: 'fal.ai', configured: false, hint: 'Thêm key', models: [model('fal-img', 'fal')] },
    ],
    spend: { todayUsd: 0, monthUsd: 0, dailyCapUsd: 10, monthlyCapUsd: 150 },
    killSwitches: { generate: true, publish: true },
    queue: { running: 0, queued: 0 },
    radar: true,
    composio: true,
    judge: { configured: true, model: 'gemini-2.5-flash', provider: 'gemini' },
    voice: { configured: false },
    chatgpt: { mode: 'chatgpt', configured: true, imagesToday: 0, dailyLimit: 40, model: 'gpt-5.6-luna', models: ['gpt-5.6-luna'], hint: '' },
    ...over,
  };
}

const ref = (id: string, kind: RefDto['kind'], sort: number, extra: Partial<RefDto> = {}): RefDto => ({
  id, personaId: 'p', kind, label: '', url: `/api/kol/media/ref/${id}`, width: null, height: null, sort, isPrimary: false,
  source: 'upload', assetId: null, createdAt: sort, ...extra,
});

const lib = (id: string, group: string, name: string, sort: number, extra: Partial<LibraryItemDto> = {}): LibraryItemDto => ({
  id, personaId: null, kind: 'scene', group, name, prompt: `${name} prompt`, imageUrl: null, previewUrl: null, previewIsPersona: false, gender: 'all', tags: [], builtin: true, sort, ...extra,
});

function composer(over: Partial<ComposerState> = {}): ComposerState {
  return {
    selection: {}, freeform: false, model: 'g-img', aspect: '4:5', quality: 'standard', count: 2, seed: '', extraPrompt: '',
    realism: 'iphone-candid', promptOverride: null, ...over,
  };
}

describe('formatters', () => {
  it('formats USD with a Vietnamese decimal comma', () => {
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(0.06)).toBe('$0,06');
    expect(fmtUsd(0.039)).toBe('$0,039');
    expect(fmtUsd(0.0004)).toBe('$0,0004');
    expect(fmtUsd(0.00001)).toBe('<$0,0001');
    expect(fmtUsd(12.5)).toBe('$12,50');
    expect(fmtUsd(1234.5)).toBe('$1.234,50');
    expect(fmtUsd(10)).toBe('$10');
    expect(fmtUsd(1500)).toBe('$1.500');
    expect(fmtUsd(-0.5)).toBe('-$0,50');
    expect(fmtUsd(Number.NaN)).toBe('–');
    expect(fmtUsd(null)).toBe('–');
  });

  it('formats counts and percents', () => {
    expect(fmtInt(1284)).toBe('1.284');
    expect(fmtCompact(312)).toBe('312');
    expect(fmtCompact(1000)).toBe('1 N');
    expect(fmtCompact(1200)).toBe('1,2 N');
    expect(fmtCompact(312_000)).toBe('312 N');
    expect(fmtCompact(1_200_000)).toBe('1,2 tr');
    expect(fmtCompact(12_000_000)).toBe('12 tr');
    expect(fmtCompact(null)).toBe('–');
    expect(fmtPct(4.333)).toBe('4,3%');
    expect(fmtPct(null)).toBe('–');
    expect(fmtRate(0.0578)).toBe('5,8%');
    expect(fmtRate(null)).toBe('–');
  });

  it('formats relative time in Vietnamese', () => {
    const now = 1_800_000_000_000;
    const sec = now / 1000;
    expect(fmtAgo(sec - 10, now)).toBe('vừa xong');
    expect(fmtAgo(sec - 300, now)).toBe('5 phút trước');
    expect(fmtAgo(sec - 7200, now)).toBe('2 giờ trước');
    expect(fmtAgo(sec - 86400 * 3, now)).toBe('3 ngày trước');
  });
});

describe('identity QA and aspects', () => {
  it('mirrors the server verdict bands', () => {
    expect(verdictFor(80, 80)).toBe('pass');
    expect(verdictFor(65, 80)).toBe('warn');
    expect(verdictFor(64, 80)).toBe('fail');
  });

  it('knows which aspects fit the Instagram feed (4:5 … 1.91:1)', () => {
    expect(isInstagramFeedAspect('4:5')).toBe(true);
    expect(isInstagramFeedAspect('1:1')).toBe(true);
    expect(isInstagramFeedAspect('16:9')).toBe(true);
    expect(isInstagramFeedAspect('3:4')).toBe(false);
    expect(isInstagramFeedAspect('9:16')).toBe(false);
  });
});

describe('composer', () => {
  it('derives the mode from template and freeform', () => {
    expect(composerMode(undefined, false)).toBe('compose');
    expect(composerMode('t1', false)).toBe('recreate');
    expect(composerMode('t1', true)).toBe('freeform');
  });

  it('builds a compose request without empty picks', () => {
    const req = buildImageRequest('p1', composer({ selection: { outfitId: 'o1', hairId: undefined }, seed: '42', count: 9, extraPrompt: '  smile  ' }));
    expect(req).toEqual({
      personaId: 'p1',
      mode: 'compose',
      selection: { outfitId: 'o1', realism: 'iphone-candid' },
      params: { model: 'g-img', aspect: '4:5', quality: 'standard', count: 4, seed: 42, extraPrompt: 'smile' },
    });
  });

  it('keeps the template in recreate and drops slots in freeform', () => {
    expect(buildImageRequest('p', composer({ selection: { templateId: 't1', sceneId: 's1' } })).selection).toEqual({ sceneId: 's1', templateId: 't1', realism: 'iphone-candid' });
    expect(buildImageRequest('p', composer({ selection: { cameraIds: ['c1', 'c2'] } })).selection).toEqual({ cameraIds: ['c1', 'c2'], realism: 'iphone-candid' });
    expect(buildImageRequest('p', composer({ selection: { cameraIds: [] } })).selection).toEqual({ realism: 'iphone-candid' });
    const free = buildImageRequest('p', composer({ freeform: true, selection: { templateId: 't1', sceneId: 's1' }, promptOverride: 'my prompt' }));
    expect(free.mode).toBe('freeform');
    expect(free.selection).toEqual({ realism: 'iphone-candid' });
    expect(free.promptOverride).toBe('my prompt');
    expect(buildImageRequest('p', composer({ promptOverride: '   ' })).promptOverride).toBeUndefined();
    expect(buildImageRequest('p', composer({ seed: 'abc' })).params?.seed).toBeUndefined();
  });

  it('explains why generation is blocked', () => {
    const anchorPersona = { refs: [ref('a', 'anchor', 0)] };
    expect(generateBlocker({ status: null, persona: anchorPersona, mode: 'compose', model: 'g-img' })).toMatch(/Đang tải/);
    expect(generateBlocker({ status: status({ killSwitches: { generate: false, publish: true } }), persona: anchorPersona, mode: 'compose', model: 'g-img' })).toMatch(/KOL_GENERATE_ENABLED/);
    expect(generateBlocker({ status: status({ enabled: false }), persona: anchorPersona, mode: 'compose', model: 'g-img' })).toMatch(/Studio đang tắt/);
    expect(generateBlocker({ status: status(), persona: { refs: [] }, mode: 'compose', model: 'g-img' })).toMatch(/khuôn mặt chính/);
    expect(generateBlocker({ status: status(), persona: { refs: [] }, mode: 'bootstrap', model: 'g-img' })).toBeNull();
    expect(generateBlocker({ status: status(), persona: { refs: [] }, mode: 'animate', model: 'veo' })).toBeNull();
    expect(generateBlocker({ status: status(), persona: anchorPersona, mode: 'compose', model: 'fal-img' })).toMatch(/fal\.ai chưa có API key/);
    expect(generateBlocker({ status: status(), persona: anchorPersona, mode: 'compose', model: 'g-img' })).toBeNull();
  });
  it('counts picks, a camera setup once', () => {
    expect(pickCount({})).toBe(0);
    expect(pickCount({ outfitId: 'o', sceneId: 's', cameraIds: ['c1', 'c2', 'c3'], templateId: 't', realism: 'editorial' })).toBe(3);
    expect(pickCount({ cameraId: 'c' })).toBe(1);
  });

  it('seed only where the provider takes one', () => {
    expect(supportsSeed({ provider: 'gemini' })).toBe(true);
    expect(supportsSeed({ provider: 'chatgpt' })).toBe(false);
    expect(supportsSeed(null)).toBe(false);
  });

  it('splits a ChatGPT batch into one-image requests and leaves other providers alone', () => {
    const req = buildImageRequest('p', composer({ count: 3 }));
    const parts = splitForParallel(req, 'chatgpt');
    expect(parts).toHaveLength(3);
    expect(parts.every((r) => r.params?.count === 1 && r.params?.aspect === '4:5' && r.mode === 'compose')).toBe(true);
    expect(req.params?.count).toBe(3);
    expect(splitForParallel(req, 'gemini')).toEqual([req]);
    expect(splitForParallel(buildImageRequest('p', composer({ count: 1 })), 'chatgpt')).toHaveLength(1);
  });

  it('estimates time from the median of recent runs, per image', () => {
    const g = (model: string, secs: number, count = 1, status: GenerationDto['status'] = 'succeeded') =>
      ({ model, status, startedAt: 1000, finishedAt: 1000 + secs, params: { count } });
    const chat = { id: 'chatgpt-image', provider: 'chatgpt' as const };
    expect(secondsPerImage([], chat)).toBe(120);
    expect(secondsPerImage([], { id: 'g-img', provider: 'gemini' })).toBe(40);
    expect(secondsPerImage([g('chatgpt-image', 100), g('chatgpt-image', 300, 2), g('chatgpt-image', 120), g('chatgpt-image', 999, 1, 'failed'), g('x', 5)], chat)).toBe(120);
    expect(secondsPerImage([g('chatgpt-image', 100), g('chatgpt-image', 110)], chat)).toBe(105);
    expect(etaSeconds(110, 4, 'chatgpt', 3)).toBe(220);
    expect(etaSeconds(110, 2, 'chatgpt', 3)).toBe(110);
    expect(etaSeconds(30, 3, 'gemini')).toBe(90);
    expect(fmtEta(110)).toBe('~2 phút');
    expect(fmtEta(22)).toBe('~20 giây');
    expect(fmtEta(0)).toBe('');
    expect(fmtClock(75)).toBe('1:15');
  });

  it('rebuilds the composer from a past generation', () => {
    const cur = composer({ count: 3, extraPrompt: 'old', promptOverride: 'edited', selection: { hairId: 'h0' } });
    const next = composerFromGeneration({
      mode: 'compose', model: 'chatgpt-image',
      params: { aspect: '9:16', quality: 'high', count: 1, extraPrompt: 'cười nhẹ' },
      selection: { outfitId: 'o1', cameraIds: ['c1'], realism: 'editorial', sourceAssetId: 'a1' },
    }, cur);
    expect(next).toMatchObject({
      selection: { outfitId: 'o1', cameraIds: ['c1'] }, freeform: false, model: 'chatgpt-image', aspect: '9:16', quality: 'high',
      count: 3, seed: '', extraPrompt: 'cười nhẹ', realism: 'editorial', promptOverride: null,
    });
    expect(next.selection.hairId).toBeUndefined();
    const recreate = composerFromGeneration({ mode: 'recreate', model: 'g-img', params: { seed: 7 }, selection: { templateId: 't1' } }, cur);
    expect(recreate.selection).toEqual({ templateId: 't1' });
    expect(recreate.seed).toBe('7');
    const free = composerFromGeneration({ mode: 'freeform', model: 'g-img', params: { extraPrompt: 'rain' }, selection: {} }, cur);
    expect(free.freeform).toBe(true);
    expect(free.selection).toEqual({ hairId: 'h0' });
  });
});

describe('models', () => {
  it('lists configured and recommended models first', () => {
    expect(modelOptions(status(), 'image').map((o) => o.model.id)).toEqual(['g-img', 'fal-img']);
    expect(modelOptions(null, 'image')).toEqual([]);
  });

  it('picks a configured preferred model, else the recommended one', () => {
    expect(pickModel(status(), 'image', ['fal-img'])).toBe('g-img');
    expect(pickModel(status(), 'image', ['g-img'])).toBe('g-img');
    expect(pickModel(status(), 'video')).toBe('veo');
    expect(pickModel(status(), 'lipsync')).toBe('');
  });
});

describe('library and templates', () => {
  const items = [lib('1', 'Biển', 'Bãi biển Nha Trang', 2), lib('2', 'Phố', 'Phố cổ Đà Lạt', 1), lib('3', 'Biển', 'Hoàng hôn', 3), lib('4', '', 'Khác lạ', 4)];

  it('counts groups in sort order', () => {
    expect(groupCounts(items)).toEqual([{ group: 'Phố', count: 1 }, { group: 'Biển', count: 2 }, { group: 'Khác', count: 1 }]);
  });

  it('reads genders and keeps the wardrobe to the KOL\'s gender', () => {
    expect(['female', 'Nữ', 'male', 'nam', 'Nam giới', ''].map(genderOfText)).toEqual(['female', 'female', 'male', 'male', 'male', null]);
    const dress = lib('d', 'Váy', 'Váy', 1, { kind: 'outfit', gender: 'female' });
    const suit = lib('s', 'Suit', 'Suit', 2, { kind: 'outfit', gender: 'male' });
    const coat = lib('c', 'Coat', 'Coat', 3, { kind: 'outfit', gender: 'all' });
    const own = lib('o', 'Tony', 'Áo dài nam', 4, { kind: 'outfit', gender: 'female', personaId: 'tony' });
    expect([dress, suit, coat, own].filter((i) => fitsGender(i, 'male')).map((i) => i.id)).toEqual(['s', 'c', 'o']);
    expect([dress, suit, coat].filter((i) => fitsGender(i, 'female')).map((i) => i.id)).toEqual(['d', 'c']);
    expect([dress, suit, coat].filter((i) => fitsGender(i, null))).toHaveLength(3);
  });

  it('puts a KOL\'s own items and their group first', () => {
    const mixed = [lib('s1', 'Hà Nội', 'Phố cổ', 1), lib('own', 'Genie · riêng', 'Rooftop', 50, { personaId: 'p1' }), lib('s2', 'Hà Nội', 'Hồ Gươm', 2)];
    expect(filterLibrary(mixed, '', '').map((i) => i.id)).toEqual(['own', 's1', 's2']);
    expect(groupCounts(mixed).map((g) => g.group)).toEqual(['Genie · riêng', 'Hà Nội']);
  });

  it('filters by group and diacritic-insensitive query', () => {
    expect(filterLibrary(items, 'Biển', '').map((i) => i.id)).toEqual(['1', '3']);
    expect(filterLibrary(items, '', 'da lat').map((i) => i.id)).toEqual(['2']);
    expect(filterLibrary(items, '', 'HOANG').map((i) => i.id)).toEqual(['3']);
  });

  it('matches every word in any order and maps Vietnamese words to the English library terms', () => {
    const cafes = [lib('c1', 'Café & quán', 'Café tối giản', 1), lib('c2', 'Sài Gòn', 'Rooftop đêm', 2)];
    expect(filterLibrary(cafes, '', 'cà phê').map((i) => i.id)).toEqual(['c1']);
    expect(filterLibrary(cafes, '', 'giản café').map((i) => i.id)).toEqual(['c1']);
    expect(filterLibrary(cafes, '', 'gon dem').map((i) => i.id)).toEqual(['c2']);
  });

  it('groups carousel templates by set and orders by position', () => {
    const t = (id: string, kind: TemplateDto['kind'], setId: string | null, position: number, createdAt: number): TemplateDto => ({
      id, name: id, kind, setId, position, url: '', width: null, height: null, notes: '', source: 'upload', sourceUrl: '', tags: [], createdAt,
    });
    const groups = templateGroups([t('a', 'single', null, 0, 10), t('c2', 'carousel', 'S', 1, 20), t('c1', 'carousel', 'S', 0, 21), t('b', 'single', null, 0, 5)]);
    expect(groups.map((g) => g.key)).toEqual(['S', 'a', 'b']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['c1', 'c2']);
    expect(groups[0].cover.id).toBe('c1');
  });
});

describe('identity pack and pillars', () => {
  it('returns only the sort patches that change', () => {
    const refs = [ref('a', 'anchor', 0), ref('b', 'sheet', 1), ref('c', 'angle', 2)];
    expect(moveRefPatches(refs, 'c', -1)).toEqual([{ id: 'c', sort: 1 }, { id: 'b', sort: 2 }]);
    expect(moveRefPatches(refs, 'a', -1)).toEqual([]);
  });

  it('prefers the primary anchor as avatar', () => {
    expect(personaAvatar({ refs: [ref('x', 'angle', 0), ref('a', 'anchor', 1), ref('p', 'anchor', 2, { isPrimary: true })] })).toBe('/api/kol/media/ref/p');
    expect(personaAvatar({ refs: [ref('x', 'angle', 0), ref('a', 'anchor', 1)] })).toBe('/api/kol/media/ref/a');
    expect(personaAvatar({ refs: [] })).toBeNull();
  });

  it('splits pillar shares evenly to 100', () => {
    const out = evenShares([{ id: '1', name: 'a', description: '', share: 0 }, { id: '2', name: 'b', description: '', share: 0 }, { id: '3', name: 'c', description: '', share: 0 }]);
    expect(out.map((p) => p.share)).toEqual([34, 33, 33]);
  });

  it('suggests handles without diacritics', () => {
    expect(suggestHandle('Linh Chi Nguyễn')).toBe('linhchi.nguyen');
    expect(suggestHandle('Đào')).toBe('dao');
    expect(suggestHandle('  ')).toBe('');
  });
});

describe('posts', () => {
  it('parses hashtags', () => {
    expect(parseHashtags('#a, b  #c #a ##d')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseHashtags('')).toEqual([]);
  });

  it('offers actions by status', () => {
    expect(postActions(null)).toEqual(['save', 'submit', 'approve']);
    expect(postActions('review')).toContain('return');
    expect(postActions('published')).toEqual([]);
    expect(postEditable('scheduled')).toBe(true);
    expect(postEditable('publishing')).toBe(false);
  });

  it('warns about platform format rules', () => {
    expect(formatWarnings('photo', ['tiktok'], [{ kind: 'image' }])[0]).toMatch(/TikTok/);
    expect(formatWarnings('carousel', ['instagram'], [{ kind: 'image' }])).toEqual(['Carousel cần 2–10 ảnh.']);
    expect(formatWarnings('reel', ['instagram', 'tiktok'], [{ kind: 'video' }])).toEqual([]);
  });
});

describe('calendar', () => {
  it('starts weeks on Monday in local time', () => {
    expect(startOfWeek(new Date(2026, 9, 21, 15, 30)).getTime()).toBe(new Date(2026, 9, 19).getTime());
    expect(startOfWeek(new Date(2026, 9, 25, 23, 0)).getTime()).toBe(new Date(2026, 9, 19).getTime());
    expect(weekDays(new Date(2026, 9, 19)).map((d) => d.getDate())).toEqual([19, 20, 21, 22, 23, 24, 25]);
  });

  it('groups posts of the week by day and sorts them by time', () => {
    const at = (d: number, h: number) => Math.floor(new Date(2026, 9, d, h).getTime() / 1000);
    const p = (id: string, scheduledAt: number | null, status: PostDto['status'] = 'scheduled', publishedAt: number | null = null) => ({ id, status, scheduledAt, publishedAt });
    const map = postsByDay([p('late', at(20, 18)), p('early', at(20, 8)), p('next-week', at(26, 9)), p('none', null), p('pub', at(1, 1), 'published', at(22, 9))], new Date(2026, 9, 19));
    expect(map.get('2026-10-20')?.map((x) => x.id)).toEqual(['early', 'late']);
    expect(map.get('2026-10-22')?.map((x) => x.id)).toEqual(['pub']);
    expect([...map.keys()].sort()).toEqual(['2026-10-20', '2026-10-22']);
  });
});

describe('meters and growth', () => {
  it('clamps meter percentages', () => {
    expect(meterPercent(5, 10)).toBe(50);
    expect(meterPercent(15, 10)).toBe(100);
    expect(meterPercent(5, 0)).toBe(0);
    expect(meterPercent(5, null)).toBe(0);
  });

  it('normalises hour intensity and keeps empty hours null', () => {
    const out = hourIntensity([{ hour: 8, posts: 2, avgEngagement: 2 }, { hour: 20, posts: 3, avgEngagement: 4 }, { hour: 9, posts: 0, avgEngagement: null }]);
    expect(out).toHaveLength(24);
    expect(out[20]).toBe(1);
    expect(out[8]).toBe(0.5);
    expect(out[9]).toBeNull();
  });

  it('sums followers, null when unknown', () => {
    expect(sumFollowers([{ followers: 10 }, { followers: null }, { followers: 5 }])).toBe(15);
    expect(sumFollowers([{ followers: null }])).toBeNull();
  });
});
