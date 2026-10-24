import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  process.env.VIDEO_EDIT_FFMPEG = '/nonexistent/ffmpeg-for-tests';
  process.env.VIDEO_EDIT_FFPROBE = '/nonexistent/ffprobe-for-tests';
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kol-previews-')) };
});
vi.mock('./config.js', async (orig) => ({ ...(await orig<typeof import('./config.js')>()), STORE_DIR: store.dir, GOOGLE_API_KEY: '' }));

import fs from 'fs';
import path from 'path';

import { _initTestDatabase } from './test-db.js';
import { _setJudgeForTests, type JudgeFn } from './consistency.js';
import { KolError, kolDb, saveSettings } from './core.js';
import { chatgptImagesToday, claimChatgptTurn, releaseChatgptTurn } from './generations.js';
import { createLibraryItem, genderOfText, getLibraryItem, getLibraryPreviewFile, listLibrary, patchLibraryItem } from './library.js';
import { createPersona } from './personas.js';
import { addRefFromUpload } from './refs.js';
import {
  _awaitPreviewJob, _setPersonaRetryDelayForTests, autoRunBudget, CHATGPT_RESERVE, keepsPersonaPhoto, personaRealismFloor, previewJobStatus, previewOrder, previewPrompt, readAutoPlan, requiredVariants, resumeInterruptedRun, setAutoPlan, startPreviewJob, stopPreviewJob,
  tickAutoPreviews,
} from './library-previews.js';
import { _setProviderAdapterForTests } from './providers/index.js';
import { ProviderError, type ImageRequest, type ProviderAdapter } from './providers/types.js';
import { LIBRARY_SPEND_ID } from './spend.js';
import type { ModelInfo, ProviderId } from './types.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const ALL = ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9', '5:4', '4:3', '3:2'] as ModelInfo['aspects'];
const FLASH: ModelInfo = { id: 'gemini-2.5-flash-image', provider: 'gemini', kind: 'image', label: 'Nano Banana', maxRefs: 3, aspects: ALL, qualities: ['standard'], priceNote: '' };
const CHAT: ModelInfo = { id: 'chatgpt-image', provider: 'chatgpt', kind: 'image', label: 'ChatGPT Images', maxRefs: 8, aspects: ALL, qualities: ['standard', 'high'], priceNote: '' };

let generateImage: ReturnType<typeof vi.fn<(req: ImageRequest) => Promise<{ outputs: { bytes: Buffer; mime: string }[] }>>>;

function adapter(id: ProviderId, models: ModelInfo[]): ProviderAdapter {
  return {
    id, label: id, hint: '', configured: () => true, models: () => models,
    generateImage: (req) => generateImage(req), submitVideo: async () => ({ handle: '' }), pollVideo: async () => ({ state: 'failed', error: '' }),
  };
}

const spend = () => kolDb().prepare('SELECT persona_id, provider, model, cost_usd FROM kol_spend ORDER BY id').all() as { persona_id: string; provider: string; model: string; cost_usd: number }[];

beforeEach(() => {
  _initTestDatabase();
  _setPersonaRetryDelayForTests(0);
  generateImage = vi.fn(async () => ({ outputs: [{ bytes: PNG, mime: 'image/png' }] }));
  _setProviderAdapterForTests('gemini', adapter('gemini', [FLASH]));
  _setProviderAdapterForTests('chatgpt', adapter('chatgpt', [CHAT]));
  saveSettings({ dailyCapUsd: 50, monthlyCapUsd: 500, concurrency: 2, chatgptDailyLimit: 60 });
});

afterEach(async () => {
  stopPreviewJob();
  await _awaitPreviewJob();
  _setJudgeForTests(null);
  for (const id of ['gemini', 'chatgpt'] as ProviderId[]) _setProviderAdapterForTests(id, null);
});

afterAll(() => fs.rmSync(store.dir, { recursive: true, force: true }));

describe('previewPrompt', () => {
  it('gives each kind its house style and none to camera setups', () => {
    expect(previewPrompt({ kind: 'outfit', prompt: 'a white linen set.' })).toMatch(/invisible ghost mannequin.*a white linen set\. The complete outfit/s);
    expect(previewPrompt({ kind: 'scene', prompt: 'a rooftop pool' })).toContain('with nobody in it: a rooftop pool.');
    expect(previewPrompt({ kind: 'expression', prompt: 'winking' })).toContain('showing exactly this expression or gesture: winking.');
    expect(previewPrompt({ kind: 'look', prompt: 'Kodak Portra 400' })).toContain('rendered in this exact look and colour grade: Kodak Portra 400.');
    for (const kind of ['outfit', 'hair', 'expression', 'pose', 'scene', 'look', 'effect'] as const) {
      expect(previewPrompt({ kind, prompt: 'x' })).toContain('no text, letters');
    }
    expect(previewPrompt({ kind: 'camera', prompt: 'shot on an iPhone' })).toBeNull();
    expect(previewPrompt({ kind: 'outfit', prompt: '   ' })).toBeNull();
  });
});

describe('gender', () => {
  it('reads a persona\'s written gender', () => {
    expect(genderOfText('female')).toBe('female');
    expect(genderOfText('Nữ')).toBe('female');
    expect(genderOfText('male')).toBe('male');
    expect(genderOfText('nam')).toBe('male');
    expect(genderOfText('')).toBeNull();
  });

  it('classifies the builtins and adds men\'s hair, outfits and poses', () => {
    const all = listLibrary();
    const g = (id: string) => all.find((i) => i.id === id)?.gender;
    expect(g('b-outfit-ao-dai-white')).toBe('female');
    expect(g('b-outfit-trench-coat')).toBe('all');
    expect(g('b-outfit-men-navy-suit')).toBe('male');
    expect(g('b-hair-long-beach-waves')).toBe('female');
    expect(g('b-hair-wolf-cut')).toBe('all');
    expect(g('b-hair-men-undercut')).toBe('male');
    expect(g('b-expr-wink')).toBe('all');
    expect(g('b-expr-hair-flip')).toBe('female');
    expect(g('b-pose-twirl')).toBe('female');
    expect(g('b-pose-men-adjust-cuff')).toBe('male');
    expect(g('b-scene-hanoi-old-quarter') ?? 'all').toBe('all');
    expect(all.filter((i) => i.kind === 'hair' && i.gender === 'male').length).toBeGreaterThanOrEqual(12);
    expect(all.filter((i) => i.kind === 'outfit' && i.gender === 'male').length).toBeGreaterThanOrEqual(20);
  });

  it('needs the right versions: nobody for outfits and places, both for people, the owner\'s gender for own items', () => {
    expect(requiredVariants({ kind: 'outfit', gender: 'female', personaId: null }, null)).toEqual(['none']);
    expect(requiredVariants({ kind: 'scene', gender: 'all', personaId: 'p' }, 'male')).toEqual(['none']);
    expect(requiredVariants({ kind: 'expression', gender: 'all', personaId: null }, null)).toEqual(['female', 'male']);
    expect(requiredVariants({ kind: 'hair', gender: 'male', personaId: null }, null)).toEqual(['male']);
    expect(requiredVariants({ kind: 'pose', gender: 'all', personaId: 'tony' }, 'male')).toEqual(['male']);
    expect(requiredVariants({ kind: 'camera', gender: 'all', personaId: null }, null)).toEqual([]);
    expect(previewPrompt({ kind: 'pose', prompt: 'arms crossed' }, 'male')).toContain('He wears');
    expect(previewPrompt({ kind: 'hair', prompt: 'undercut' }, 'male')).toMatch(/^A barbershop portfolio photo of this hairstyle: undercut\. A young Vietnamese man in his early thirties, clean-shaven, head/);
  });

  it('draws a man\'s own poses with the man model', async () => {
    const tony = createPersona({ name: 'Tony', appearance: { gender: 'male' } as never });
    const pose = createLibraryItem({ kind: 'pose', group: 'Tony', name: 'Cầm micro', prompt: 'holding a microphone on stage', personaId: tony.id });
    startPreviewJob({ model: 'gemini-2.5-flash-image', ids: [pose.id] });
    await _awaitPreviewJob();
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(generateImage.mock.calls[0][0].prompt).toContain('Vietnamese man');
    expect(listLibrary({ personaId: tony.id }).find((i) => i.id === pose.id)!.previewUrl).toContain('variant=male');
  });
});

describe('previewOrder', () => {
  it('draws a persona\'s own items first, then by kind priority and library order', () => {
    const it = (id: string, kind: 'outfit' | 'effect' | 'scene', personaId: string | null, sort: number) => ({ id, kind, personaId, sort });
    const order = previewOrder([it('fx', 'effect', null, 0), it('o2', 'outfit', null, 2), it('own-s', 'scene', 'p1', 9), it('o1', 'outfit', null, 1), it('own-o', 'outfit', 'p1', 5)]);
    expect(order.map((x) => x.id)).toEqual(['own-o', 'own-s', 'o1', 'o2', 'fx']);
  });
});

describe('preview job', () => {
  it('reports coverage and the price of the missing photos', () => {
    const s = previewJobStatus('gemini-2.5-flash-image');
    const total = Object.values(s.coverage).reduce((n, c) => n + c.total, 0);
    expect(s.coverage.camera).toBeUndefined();
    expect(total).toBeGreaterThan(100);
    // Items for everyone that show a person need a woman's and a man's photo: more photos than items.
    const count = s.estimate!.count;
    expect(count).toBeGreaterThan(total);
    expect(s.estimate).toEqual({ model: 'gemini-2.5-flash-image', count, usd: Math.round(count * 0.039 * 1e4) / 1e4 });
    expect(previewJobStatus('chatgpt-image').estimate?.usd).toBe(0);
  });

  it('draws the missing photos, a woman\'s and a man\'s for items for everyone, display-only, and records the spend', async () => {
    startPreviewJob({ model: 'gemini-2.5-flash-image', kinds: ['expression'], limit: 4 });
    expect(() => startPreviewJob({ model: 'gemini-2.5-flash-image' })).toThrow(KolError);
    await _awaitPreviewJob();
    const s = previewJobStatus();
    expect(s).toMatchObject({ running: false, total: 4, done: 4, failed: 0, model: 'gemini-2.5-flash-image' });
    expect(s.costUsd).toBeCloseTo(0.156, 6);
    expect(generateImage).toHaveBeenCalledTimes(4);
    const prompts = generateImage.mock.calls.map((c) => c[0].prompt);
    expect(generateImage.mock.calls[0][0]).toMatchObject({ aspect: '4:5', refs: [], count: 1 });
    expect(prompts.filter((p) => p.includes('Vietnamese woman'))).toHaveLength(2);
    expect(prompts.filter((p) => p.includes('Vietnamese man'))).toHaveLength(2);

    const drawn = listLibrary({ kind: 'expression' }).filter((i) => i.previewUrl);
    expect(drawn).toHaveLength(2);
    expect(drawn[0].previewUrl).toMatch(/^\/api\/kol\/media\/preview\/[\w-]+\?variant=female&v=[0-9a-f]{8}$/);
    expect(listLibrary({ kind: 'expression', gender: 'male' }).find((i) => i.id === drawn[0].id)!.previewUrl).toContain('variant=male');
    expect(drawn[0].imageUrl).toBeNull();
    expect(fs.existsSync(getLibraryPreviewFile(drawn[0].id, 'male')!)).toBe(true);
    expect(spend().every((r) => r.persona_id === LIBRARY_SPEND_ID && r.provider === 'gemini')).toBe(true);
    expect(previewJobStatus().coverage.expression.withPreview).toBe(2);

    // A second run skips what is drawn; nothing left in the ids asked → 400.
    const ids = drawn.map((i) => i.id);
    expect(() => startPreviewJob({ model: 'gemini-2.5-flash-image', ids })).toThrow(/Không còn mục nào/);
    startPreviewJob({ model: 'gemini-2.5-flash-image', ids: [ids[0]], force: true });
    await _awaitPreviewJob();
    expect(getLibraryItem(ids[0])!.previewUrl).not.toBe(drawn[0].previewUrl);
  });

  it('drops a stale photo when the prompt changes', async () => {
    const item = createLibraryItem({ kind: 'outfit', group: 'Của tôi', name: 'Váy đỏ', prompt: 'a red dress' });
    startPreviewJob({ model: 'gemini-2.5-flash-image', ids: [item.id] });
    await _awaitPreviewJob();
    expect(getLibraryItem(item.id)!.previewUrl).not.toBeNull();
    const file = getLibraryPreviewFile(item.id)!;
    patchLibraryItem(item.id, { name: 'Váy đỏ rượu' });
    expect(getLibraryItem(item.id)!.previewUrl).not.toBeNull();
    patchLibraryItem(item.id, { prompt: 'a burgundy dress' });
    expect(getLibraryItem(item.id)!.previewUrl).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('stops at the daily cap before spending past it', async () => {
    saveSettings({ dailyCapUsd: 0.1 });
    startPreviewJob({ model: 'gemini-2.5-flash-image', kinds: ['scene'], limit: 6 });
    await _awaitPreviewJob();
    const s = previewJobStatus();
    expect(s.done).toBe(2);
    expect(s.stopReason).toContain('hạn mức ngày');
    expect(spend().reduce((n, r) => n + r.cost_usd, 0)).toBeLessThanOrEqual(0.1);
  });

  it('counts ChatGPT photos against the ChatGPT daily limit', async () => {
    saveSettings({ chatgptDailyLimit: 2 });
    startPreviewJob({ model: 'chatgpt-image', kinds: ['hair'], limit: 5 });
    await _awaitPreviewJob();
    const s = previewJobStatus();
    expect(s.done).toBe(2);
    expect(s.stopReason).toContain('ảnh ChatGPT hôm nay');
    expect(chatgptImagesToday()).toBe(2);
    expect(spend().every((r) => r.cost_usd === 0)).toBe(true);
  });

  it('shares the ChatGPT pool with the Studio and lets the owner\'s queued images go first', () => {
    saveSettings({ chatgptParallel: 2 });
    const insert = (id: string, status: string) => kolDb().prepare(
      `INSERT INTO kol_generations (id, persona_id, kind, mode, status, provider, model, params_json, selection_json, prompt, refs_json,
         estimate_usd, cost_usd, cost_status, provider_request_id, error, attempts, requested_by, post_id, created_at)
       VALUES (?, 'p', 'image', 'compose', ?, 'chatgpt', 'chatgpt-image', '{}', '{}', '', '[]', 0, 0, 'estimated', NULL, '', 0, 'owner', NULL, 1)`,
    ).run(id, status);
    insert('g1', 'queued');
    expect(claimChatgptTurn()).toBe(false);
    kolDb().prepare("UPDATE kol_generations SET status = 'running' WHERE id = 'g1'").run();
    expect(claimChatgptTurn()).toBe(true);
    expect(claimChatgptTurn()).toBe(false);
    releaseChatgptTurn();
    kolDb().prepare("UPDATE kol_generations SET status = 'succeeded' WHERE id = 'g1'").run();
    expect(claimChatgptTurn()).toBe(true);
    expect(claimChatgptTurn()).toBe(true);
    expect(claimChatgptTurn()).toBe(false);
    releaseChatgptTurn();
    releaseChatgptTurn();
  });

  it('retries a dropped connection once, then records the failure and carries on', async () => {
    let n = 0;
    generateImage = vi.fn(async () => {
      n += 1;
      if (n <= 3) throw new ProviderError('network', 'stream disconnected');
      return { outputs: [{ bytes: PNG, mime: 'image/png' }] };
    });
    saveSettings({ concurrency: 1 });
    startPreviewJob({ model: 'gemini-2.5-flash-image', kinds: ['pose'], limit: 2 });
    await _awaitPreviewJob();
    const s = previewJobStatus();
    expect(s).toMatchObject({ done: 1, failed: 1 });
    expect(s.errors).toHaveLength(1);
  });

  it('stops for good on an auth error', async () => {
    generateImage = vi.fn(async () => { throw new ProviderError('auth', 'bad key'); });
    startPreviewJob({ model: 'gemini-2.5-flash-image', kinds: ['effect'] });
    await _awaitPreviewJob();
    const s = previewJobStatus();
    expect(s.done).toBe(0);
    expect(s.failed).toBeLessThanOrEqual(3);
    expect(s.stopReason).not.toBe('');
  });
});

describe('a KOL\'s own photos', () => {
  const tempPng = () => {
    const f = path.join(fs.mkdtempSync(path.join(store.dir, 'up-')), 'x.png');
    fs.writeFileSync(f, PNG);
    return f;
  };
  const judge = (...scores: number[]): JudgeFn => {
    let i = 0;
    return vi.fn(async () => ({ score: scores[Math.min(i++, scores.length - 1)], samePerson: true, issues: [], inputTokens: 3000, outputTokens: 100 }));
  };
  async function tony() {
    const p = createPersona({ name: 'Tony', appearance: { gender: 'male' } as never });
    await addRefFromUpload(p.id, tempPng(), { kind: 'anchor' });
    return p;
  }

  it('draws the item on the KOL itself with its identity pack, judges it, and shows it only for that KOL', async () => {
    const p = await tony();
    const fn = judge(95);
    _setJudgeForTests(fn);
    const before = previewJobStatus(undefined, p.id);
    expect(before.personaId).toBe(p.id);
    expect(Object.keys(before.coverage)).toEqual(['outfit', 'hair', 'expression', 'pose', 'look', 'effect', 'scene']);
    // Shared items for women only are not in a man's set.
    const womenOnly = listLibrary({ kind: 'outfit' }).filter((i) => i.gender === 'female').length;
    expect(before.coverage.outfit.total).toBe(listLibrary({ kind: 'outfit' }).length - womenOnly);

    startPreviewJob({ model: 'gemini-2.5-flash-image', personaId: p.id, kinds: ['outfit'], limit: 2 });
    await _awaitPreviewJob();
    const s = previewJobStatus(undefined, p.id);
    expect(s).toMatchObject({ done: 2, failed: 0, runPersonaId: p.id });
    expect(s.coverage.outfit.withPreview).toBe(2);
    const req = generateImage.mock.calls[0][0];
    expect(req.refs.length).toBeGreaterThanOrEqual(1);
    expect(req.prompt).toContain('IDENTITY LOCK');
    expect(req.prompt).toContain('Catalog photo for an outfit picker');
    expect(req.prompt).toContain('untouched RAW photograph of a real human');
    expect(fn).toHaveBeenCalledTimes(2);

    const mine = listLibrary({ personaId: p.id, kind: 'outfit' }).filter((i) => i.previewIsPersona);
    expect(mine).toHaveLength(2);
    expect(mine[0].previewUrl).toMatch(new RegExp(`\\?persona=${p.id}&v=[0-9a-f]{8}$`));
    expect(fs.existsSync(getLibraryPreviewFile(mine[0].id, null, p.id)!)).toBe(true);
    // Other KOLs and the shared library keep the catalog photo.
    expect(listLibrary({ kind: 'outfit' }).find((i) => i.id === mine[0].id)!.previewIsPersona).toBe(false);
    expect(spend().every((r) => r.persona_id === LIBRARY_SPEND_ID)).toBe(true);

    // New wording: the KOL's photo is stale and goes.
    patchLibraryItem(mine[0].id, { prompt: 'a navy linen suit' });
    expect(listLibrary({ personaId: p.id, kind: 'outfit' }).find((i) => i.id === mine[0].id)!.previewIsPersona).toBe(false);
  });

  it('redraws a photo the judge does not pass, and keeps the catalog photo when the redraw drifts too', async () => {
    const p = await tony();
    _setJudgeForTests(judge(40, 96));
    startPreviewJob({ model: 'gemini-2.5-flash-image', personaId: p.id, kinds: ['expression'], limit: 1 });
    await _awaitPreviewJob();
    expect(previewJobStatus(undefined, p.id)).toMatchObject({ done: 1, failed: 0 });
    expect(generateImage).toHaveBeenCalledTimes(2);

    // A pass under the 90-point floor of KOL photos is redrawn too.
    _setJudgeForTests(judge(86, 93));
    generateImage.mockClear();
    startPreviewJob({ model: 'gemini-2.5-flash-image', personaId: p.id, kinds: ['hair'], limit: 1 });
    await _awaitPreviewJob();
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(previewJobStatus(undefined, p.id).coverage.hair.withPreview).toBe(1);

    _setJudgeForTests(judge(40));
    generateImage.mockClear();
    startPreviewJob({ model: 'gemini-2.5-flash-image', personaId: p.id, kinds: ['expression'], limit: 1 });
    await _awaitPreviewJob();
    const s = previewJobStatus(undefined, p.id);
    expect(s).toMatchObject({ done: 0, failed: 1 });
    expect(s.errors[0].error).toContain('Lệch mặt (40/100)');
    expect(generateImage).toHaveBeenCalledTimes(3);
    expect(s.coverage.expression.withPreview).toBe(1);

    // Same face but an AI look (realism under the floor) is redrawn until it reads as a real photo.
    let n = 0;
    _setJudgeForTests(vi.fn(async () => ({ score: 95, samePerson: true, issues: [], realism: n++ === 0 ? 70 : 88, inputTokens: 3000, outputTokens: 100 })));
    generateImage.mockClear();
    startPreviewJob({ model: 'gemini-2.5-flash-image', personaId: p.id, kinds: ['pose'], limit: 1 });
    await _awaitPreviewJob();
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(previewJobStatus(undefined, p.id).coverage.pose.withPreview).toBe(1);

    // A judge that cannot answer is asked again; a photo that stays unjudged is not kept.
    const flaky = vi.fn().mockRejectedValueOnce(new Error('Codex exited')).mockResolvedValue({ score: 96, samePerson: true, issues: [], realism: 90, inputTokens: 1, outputTokens: 1 });
    _setJudgeForTests(flaky);
    generateImage.mockClear();
    startPreviewJob({ model: 'gemini-2.5-flash-image', personaId: p.id, kinds: ['look'], limit: 1 });
    await _awaitPreviewJob();
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(previewJobStatus(undefined, p.id).coverage.look.withPreview).toBe(1);
  });

  it('gives up on an item after two failed runs in automatic runs only, and goes through a queue of KOLs', async () => {
    const p = await tony();
    const q = createPersona({ name: 'Genie', appearance: { gender: 'female' } as never });
    await addRefFromUpload(q.id, tempPng(), { kind: 'anchor' });
    _setJudgeForTests(judge(40));
    const one = listLibrary({ personaId: p.id, kind: 'effect' }).find((i) => i.gender !== 'female')!;
    for (let run = 0; run < 2; run++) {
      startPreviewJob({ model: 'gemini-2.5-flash-image', personaId: p.id, ids: [one.id] });
      await _awaitPreviewJob();
    }
    const s = previewJobStatus(undefined, p.id);
    expect(s.gaveUp).toEqual([expect.objectContaining({ id: one.id, name: one.name })]);
    expect(s.gaveUp[0].error).toContain('Lệch mặt');

    // Queue: Tony first, Genie next. Tony's set minus the given-up item is drawn by automatic runs.
    _setJudgeForTests(judge(95));
    kolDb().prepare('INSERT INTO kol_persona_previews (persona_id, item_id, file, score, created_at) SELECT ?, id, \'x.jpg\', 95, 0 FROM kol_library WHERE id != ?').run(p.id, one.id);
    setAutoPlan({ enabled: true, model: 'gemini-2.5-flash-image', personaIds: [p.id, q.id] });
    await _awaitPreviewJob();
    // Tony had only the given-up item left: the plan moved on to Genie and drew her set.
    expect(readAutoPlan()).toMatchObject({ personaId: q.id, queue: [] });
    expect(previewJobStatus(undefined, q.id).runPersonaId).toBe(q.id);
    expect(previewJobStatus(undefined, p.id).coverage.effect.withPreview).toBe(previewJobStatus(undefined, p.id).coverage.effect.total - 1);

    expect(() => startPreviewJob({ model: 'gemini-2.5-flash-image', personaId: p.id, ids: [one.id], skipGivenUp: true })).toThrow(/Không còn mục nào/);
    // The owner can still draw a given-up item on purpose; a pass clears it.
    startPreviewJob({ model: 'gemini-2.5-flash-image', personaId: p.id, ids: [one.id] });
    await _awaitPreviewJob();
    expect(previewJobStatus(undefined, p.id).gaveUp).toEqual([]);
  });

  it('refuses a KOL without an anchor before spending', () => {
    const p = createPersona({ name: 'Nobody', appearance: { gender: 'male' } as never });
    expect(() => startPreviewJob({ model: 'gemini-2.5-flash-image', personaId: p.id })).toThrow(/ảnh gốc/);
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe('automatic continuation', () => {
  // Today at hour h, so the ledger rows written now fall on the same local day.
  const at = (h: number) => { const d = new Date(); d.setHours(h, 15, 0, 0); return d; };

  it('opens at night or when the owner is away, and keeps ChatGPT images for the owner', () => {
    const base = { provider: 'chatgpt' as const, chatgptUsed: 0, chatgptLimit: 60, missing: 395 };
    const day = at(14);
    const recent = day.getTime() / 1000 - 600;
    expect(autoRunBudget({ ...base, now: day, lastActivitySec: recent })).toBe(0);
    expect(autoRunBudget({ ...base, now: day, lastActivitySec: recent - 3600 })).toBe(60 - CHATGPT_RESERVE);
    expect(autoRunBudget({ ...base, now: at(2), lastActivitySec: at(2).getTime() / 1000 - 60 })).toBe(45);
    expect(autoRunBudget({ ...base, now: at(2), lastActivitySec: null, chatgptUsed: 50 })).toBe(0);
    expect(autoRunBudget({ ...base, now: at(2), lastActivitySec: null, missing: 10 })).toBe(10);
    expect(autoRunBudget({ ...base, provider: 'gemini', now: at(3), lastActivitySec: null })).toBe(395);
    expect(autoRunBudget({ ...base, now: at(3), lastActivitySec: null, missing: 0 })).toBe(0);
  });

  it('starts a run within the budget, waits for the owner\'s jobs and switches off when done', async () => {
    saveSettings({ chatgptDailyLimit: 20 });
    setAutoPlan({ enabled: false, model: 'chatgpt-image' });
    expect(readAutoPlan()).toEqual({ enabled: false, model: 'chatgpt-image', personaId: null, queue: [] });
    expect(tickAutoPreviews(at(2))).toBe(false);

    kolDb().prepare(
      `INSERT INTO kol_generations (id, persona_id, kind, mode, status, provider, model, params_json, selection_json, prompt, refs_json,
         estimate_usd, cost_usd, cost_status, provider_request_id, error, attempts, requested_by, post_id, created_at)
       VALUES ('g1', 'p', 'image', 'compose', 'queued', 'chatgpt', 'chatgpt-image', '{}', '{}', '', '[]', 0, 0, 'estimated', NULL, '', 0, 'owner', NULL, 1)`,
    ).run();
    writePlanOn();
    expect(tickAutoPreviews(at(2))).toBe(false);
    kolDb().prepare("UPDATE kol_generations SET status = 'succeeded' WHERE id = 'g1'").run();

    expect(tickAutoPreviews(at(2))).toBe(true);
    await _awaitPreviewJob();
    expect(previewJobStatus().done).toBe(20 - CHATGPT_RESERVE);
    expect(previewJobStatus().auto).toEqual({ enabled: true, model: 'chatgpt-image', reserve: CHATGPT_RESERVE, personaId: null, queue: [] });
    // The day's share is used: nothing more until the counter resets.
    expect(tickAutoPreviews(at(3))).toBe(false);

    function writePlanOn() { kolDb().prepare("INSERT INTO kol_settings (key, value) VALUES ('previewAuto', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ enabled: true, model: 'chatgpt-image' })); }
  });

  it('refuses to start a manual run once ChatGPT\'s daily limit is used', () => {
    saveSettings({ chatgptDailyLimit: 1 });
    kolDb().prepare("INSERT INTO kol_spend (persona_id, generation_id, provider, model, kind, cost_usd, cost_status, requested_by, created_at) VALUES ('_library', NULL, 'chatgpt', 'chatgpt-image', 'image', 0, 'estimated', 'x', ?)")
      .run(Math.floor(Date.now() / 1000));
    expect(() => startPreviewJob({ model: 'chatgpt-image', limit: 1 })).toThrow(/ảnh ChatGPT hôm nay/);
  });
});

describe('resume after a restart', () => {
  const marker = () => kolDb().prepare("SELECT value FROM kol_settings WHERE key = 'previewRun'").get() as { value: string } | undefined;

  it('marks an owner\'s run, clears the mark when it ends, and picks up a run a restart cut short', async () => {
    startPreviewJob({ model: 'gemini-2.5-flash-image', kinds: ['effect'], limit: 1 });
    expect(JSON.parse(marker()!.value)).toMatchObject({ model: 'gemini-2.5-flash-image', kinds: ['effect'], requestedBy: 'owner' });
    await _awaitPreviewJob();
    expect(marker()).toBeUndefined();

    // A process that died mid-run leaves the mark behind.
    kolDb().prepare("INSERT INTO kol_settings (key, value) VALUES ('previewRun', ?)").run(JSON.stringify({ model: 'gemini-2.5-flash-image', kinds: ['effect'], requestedBy: 'owner' }));
    expect(resumeInterruptedRun()).toBe(true);
    await _awaitPreviewJob();
    expect(previewJobStatus().coverage.effect.withPreview).toBe(13);
    expect(marker()).toBeUndefined();
    // Nothing left: the mark is dropped instead of retried forever.
    kolDb().prepare("INSERT INTO kol_settings (key, value) VALUES ('previewRun', ?)").run(JSON.stringify({ model: 'gemini-2.5-flash-image', kinds: ['effect'], requestedBy: 'owner' }));
    expect(resumeInterruptedRun()).toBe(false);
    expect(marker()).toBeUndefined();
  });
});

describe('keepsPersonaPhoto', () => {
  it('keeps a same-person, real-looking photo and rejects drift or an AI look', () => {
    expect(keepsPersonaPhoto({ verdict: 'pass', score: 94, realism: 88 })).toBe(true);
    expect(keepsPersonaPhoto({ verdict: 'pass', score: 94, realism: null })).toBe(true);
    expect(keepsPersonaPhoto({ verdict: 'pass', score: 94, realism: 72 })).toBe(false);
    expect(keepsPersonaPhoto({ verdict: 'pass', score: 88, realism: 95 })).toBe(false);
    expect(keepsPersonaPhoto({ verdict: 'warn', score: 92, realism: 95 })).toBe(false);
    expect(keepsPersonaPhoto({ verdict: 'skipped', score: null })).toBe(false);
    expect(keepsPersonaPhoto({ verdict: 'pass', score: 94, realism: 76 }, 75)).toBe(true);
  });

  it('reads a per-KOL realism floor, defaulting to 80', () => {
    expect(personaRealismFloor('p1')).toBe(80);
    kolDb().prepare("INSERT INTO kol_settings (key, value) VALUES ('personaRealismFloor', ?)").run(JSON.stringify({ p1: 75, p2: 'x' }));
    expect(personaRealismFloor('p1')).toBe(75);
    expect(personaRealismFloor('p2')).toBe(80);
  });
});
