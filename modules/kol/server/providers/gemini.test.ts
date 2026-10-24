import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../../config.js')>()), GOOGLE_API_KEY: '' }));

import { _setGeminiClientForTests, buildJudgePrompt, GEMINI_MODELS, geminiAdapter, judgeIdentity, parseJudgeJson, type GeminiClientLike } from './gemini.js';
import type { ImageRequest } from './types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kol-gemini-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => _setGeminiClientForTests(null));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const file = path.join(dir, 'a.png');
fs.writeFileSync(file, PNG);
const model = (id: string) => GEMINI_MODELS.find((m) => m.id === id)!;

const imageResponse = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'here' }, { inlineData: { data: PNG.toString('base64'), mimeType: 'image/png' } }] } }] };

function fakeClient(over: Partial<GeminiClientLike['models']> = {}, getOp?: GeminiClientLike['operations']['getVideosOperation']): GeminiClientLike & { models: { generateContent: ReturnType<typeof vi.fn>; generateVideos: ReturnType<typeof vi.fn> } } {
  return {
    models: {
      generateContent: vi.fn(async () => imageResponse),
      generateVideos: vi.fn(async () => ({ name: 'models/veo/operations/op-1', done: false })),
      ...over,
    },
    operations: { getVideosOperation: getOp ?? (vi.fn(async () => ({ done: false })) as never) },
  } as never;
}

const req = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  model: model('gemini-3-pro-image'), prompt: 'PROMPT', refs: [{ path: file, mime: 'image/png', role: 'identity', label: 'Mia — identity reference' }],
  aspect: '4:5', quality: 'high', count: 1, idempotencyKey: 'g1', ...over,
});

describe('gemini models', () => {
  it('uses the confirmed ids and is unconfigured without GOOGLE_API_KEY', () => {
    expect(GEMINI_MODELS.map((m) => m.id)).toEqual(['gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'veo-3.1-fast-generate-preview', 'veo-3.1-generate-preview']);
    expect(geminiAdapter.configured()).toBe(false);
  });
});

describe('gemini images', () => {
  it('sends labelled inline images, IMAGE output and the size from the quality', async () => {
    const c = fakeClient();
    _setGeminiClientForTests(c);
    const res = await geminiAdapter.generateImage(req());
    expect(res.outputs).toHaveLength(1);
    expect(res.outputs[0].bytes?.equals(PNG)).toBe(true);
    const params = c.models.generateContent.mock.calls[0][0] as { model: string; contents: { parts: unknown[] }[]; config: Record<string, unknown> };
    expect(params.model).toBe('gemini-3-pro-image');
    expect(params.contents[0].parts[0]).toEqual({ text: 'Image 1 (Mia — identity reference):' });
    expect(params.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } });
    expect(params.contents[0].parts[2]).toEqual({ text: 'PROMPT' });
    expect(params.config).toMatchObject({ responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:5', imageSize: '2K' } });
  });

  it('skips interim thought images and keeps the final one', async () => {
    const FINAL = Buffer.from('final-image');
    _setGeminiClientForTests(fakeClient({ generateContent: vi.fn(async () => ({ candidates: [{ content: { parts: [
      { thought: true, inlineData: { data: Buffer.from('draft').toString('base64'), mimeType: 'image/png' } },
      { inlineData: { data: FINAL.toString('base64'), mimeType: 'image/png' } },
    ] } }] })) }));
    const res = await geminiAdapter.generateImage(req());
    expect(res.outputs[0].bytes?.equals(FINAL)).toBe(true);
  });

  it('makes one call per image with consecutive seeds, and no imageSize for Nano Banana', async () => {
    const c = fakeClient();
    _setGeminiClientForTests(c);
    await geminiAdapter.generateImage(req({ model: model('gemini-2.5-flash-image'), quality: 'standard', count: 3, seed: 10 }));
    expect(c.models.generateContent).toHaveBeenCalledTimes(3);
    const configs = c.models.generateContent.mock.calls.map((x) => (x[0] as { config: Record<string, unknown> }).config);
    expect(configs.map((x) => x.seed)).toEqual([10, 11, 12]);
    expect(configs[0].imageConfig).toEqual({ aspectRatio: '4:5' });
  });

  it('reports a blocked image as a safety error and an API 401 as auth', async () => {
    _setGeminiClientForTests(fakeClient({ generateContent: vi.fn(async () => ({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] })) }));
    await expect(geminiAdapter.generateImage(req())).rejects.toMatchObject({ kind: 'safety' });
    const err = Object.assign(new Error('{"error":{"message":"API key not valid"}}'), { status: 401 });
    _setGeminiClientForTests(fakeClient({ generateContent: vi.fn(async () => { throw err; }) }));
    await expect(geminiAdapter.generateImage(req({ count: 3 }))).rejects.toMatchObject({ kind: 'auth', message: 'gemini: API key not valid' });
  });
});

describe('veo', () => {
  it('submits the start frame and maps quality to resolution (1080p only at 8 s)', async () => {
    const c = fakeClient();
    _setGeminiClientForTests(c);
    const base = { model: model('veo-3.1-fast-generate-preview'), prompt: 'Mia smiles', startFrame: { path: file, mime: 'image/png', role: 'source' as const, label: 'start' }, refs: [], audioFile: null, aspect: '9:16' as const, audio: true, idempotencyKey: 'v' };
    const { handle } = await geminiAdapter.submitVideo({ ...base, quality: 'high', durationSec: 8, seed: 42 });
    expect(handle).toBe('models/veo/operations/op-1');
    const p = c.models.generateVideos.mock.calls[0][0] as { image: unknown; config: Record<string, unknown> };
    expect(p.image).toEqual({ imageBytes: PNG.toString('base64'), mimeType: 'image/png' });
    expect(p.config).toMatchObject({ durationSeconds: 8, resolution: '1080p', aspectRatio: '9:16', personGeneration: 'allow_adult', numberOfVideos: 1 });
    // Not accepted by the Gemini API for Veo.
    expect(p.config).not.toHaveProperty('seed');
    expect(p.config).not.toHaveProperty('generateAudio');
    await geminiAdapter.submitVideo({ ...base, quality: 'high', durationSec: 6 });
    expect((c.models.generateVideos.mock.calls[1][0] as { config: Record<string, unknown> }).config).toMatchObject({ durationSeconds: 6, resolution: '720p' });
  });

  it('polls the operation by name: pending, done with bytes, failed, filtered', async () => {
    const VIDEO = Buffer.from('fake-mp4');
    const get = vi.fn()
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: true, response: { generatedVideos: [{ video: { videoBytes: VIDEO.toString('base64'), mimeType: 'video/mp4' } }] } })
      .mockResolvedValueOnce({ done: true, error: { message: 'quota exceeded' } })
      .mockResolvedValueOnce({ done: true, response: { generatedVideos: [], raiMediaFilteredReasons: ['celebrity'] } });
    _setGeminiClientForTests(fakeClient({}, get as never));
    const m = model('veo-3.1-fast-generate-preview');
    expect(await geminiAdapter.pollVideo('op-1', m)).toEqual({ state: 'pending' });
    expect((get.mock.calls[0][0] as { operation: { name: string } }).operation.name).toBe('op-1');
    const done = await geminiAdapter.pollVideo('op-1', m);
    expect(done.state).toBe('done');
    expect(done.state === 'done' && done.outputs[0].bytes?.equals(VIDEO)).toBe(true);
    expect(await geminiAdapter.pollVideo('op-1', m)).toEqual({ state: 'failed', error: 'gemini: quota exceeded' });
    expect(await geminiAdapter.pollVideo('op-1', m)).toMatchObject({ state: 'failed', error: expect.stringContaining('safety') });
  });
});

describe('judge', () => {
  it('parses JSON answers defensively', () => {
    expect(parseJudgeJson('{"score": 88.6, "same_person": true, "issues": ["mũi to hơn", ""]}')).toEqual({ score: 89, samePerson: true, issues: ['mũi to hơn'], signaturePresent: null, realism: null });
    expect(parseJudgeJson('Sure! ```json\n{"score": 140, "same_person": "true", "issues": []}\n```')).toEqual({ score: 100, samePerson: true, issues: [], signaturePresent: null, realism: null });
    expect(parseJudgeJson('{"score": 93, "same_person": true, "issues": [], "realism": 71.6}')?.realism).toBe(72);
    expect(parseJudgeJson('{"score": 93, "same_person": true, "issues": [], "realism": 130}')?.realism).toBe(100);
    expect(parseJudgeJson('{"score": "n/a"}')).toBeNull();
    expect(parseJudgeJson('no json')).toBeNull();
  });

  it('builds the comparison prompt around identity only', () => {
    const p = buildJudgePrompt('Mia', 'mole under the left eye', 2);
    expect(p).toContain('Images 1–2 are the approved reference renders of the character Mia');
    expect(p).toContain('FICTIONAL character');
    const withSig = buildJudgePrompt('Mia', '', 2, 'gold hoop earrings, a coin necklace');
    expect(withSig).toContain('MAIN element is the first item listed');
    expect(withSig).toContain('Missing secondary accessories never make it false');
    expect(p).toContain('mole under the left eye');
    expect(p).toContain('Ignore clothing, hairstyle');
    expect(p).toContain('IN VIETNAMESE');
  });

  it('tells the judge the truth about a real, consenting person', () => {
    const p = buildJudgePrompt('Tony Trieu', '', 3, 'round thin metal glasses', true);
    expect(p).toContain('Tony Trieu is a real adult who runs this studio and consented');
    expect(p).toContain('Images 1–3 are reference photos and approved renders of Tony Trieu');
    expect(p).not.toContain('FICTIONAL');
  });

  it('sends anchors then the candidate and returns score and tokens', async () => {
    const generateContent = vi.fn(async (_params: unknown) => ({ text: '{"score":91,"same_person":true,"issues":[]}', usageMetadata: { promptTokenCount: 2500, candidatesTokenCount: 20, thoughtsTokenCount: 5 } }));
    _setGeminiClientForTests(fakeClient({ generateContent }));
    const r = await judgeIdentity({ model: 'gemini-2.5-flash', personaName: 'Mia', marks: '', anchors: [{ path: file, mime: 'image/png' }, { path: file, mime: 'image/png' }], candidate: { path: file, mime: 'image/png' } });
    expect(r).toEqual({ score: 91, samePerson: true, issues: [], signaturePresent: null, realism: null, inputTokens: 2500, outputTokens: 25 });
    const p = generateContent.mock.calls[0][0] as { contents: { parts: { text?: string }[] }[]; config: Record<string, unknown> };
    const texts = p.contents[0].parts.map((x) => x.text).filter(Boolean);
    expect(texts.slice(0, 3)).toEqual(['Image 1 (reference):', 'Image 2 (reference):', 'Image 3 (candidate):']);
    expect(p.config).toMatchObject({ temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } });
  });
});
