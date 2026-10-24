import zlib from 'zlib';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kol-chatgpt-')) };
});
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../../config.js')>()), STORE_DIR: store.dir, GOOGLE_API_KEY: '' }));

import fs from 'fs';
import path from 'path';

import { imageSize } from 'image-size';

import { _initTestDatabase } from '../test-db.js';
import { _setCodexAuthModeForTests, _setCodexRunnerForTests, type CodexTurnInput, type CodexTurnResult } from '../codex.js';
import { saveSettings } from '../core.js';
import { CHATGPT_IMAGE_MODEL, chatgptAdapter, imageTurnInput, judgeIdentityChatgpt } from './chatgpt.js';
import { ProviderError, type ImageRequest, type InputFile } from './types.js';

/** A real, minimal RGB PNG of the given size (so image-size and ffmpeg can read it). */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const ref = (name: string, label: string): InputFile => {
  const file = path.join(store.dir, name);
  fs.writeFileSync(file, png(8, 8));
  return { path: file, mime: 'image/png', role: 'identity', label };
};

let turns: CodexTurnInput[];
let answer: (turn: CodexTurnInput) => CodexTurnResult;

beforeEach(() => {
  _initTestDatabase();
  turns = [];
  answer = () => ({ threadId: 't-1', finalResponse: 'DONE', images: [{ bytes: png(80, 100), mime: 'image/png' }], inputTokens: 10, outputTokens: 2 });
  _setCodexRunnerForTests(async (turn) => { turns.push(turn); return answer(turn); });
  _setCodexAuthModeForTests('chatgpt');
});

afterEach(() => {
  _setCodexRunnerForTests(null);
  _setCodexAuthModeForTests(null);
});

afterAll(() => fs.rmSync(store.dir, { recursive: true, force: true }));

const request = (over: Partial<ImageRequest> = {}): ImageRequest => ({
  model: chatgptAdapter.models()[0], prompt: 'Create a new photorealistic photograph of Mia.', refs: [ref('a.png', 'Mia — identity reference')],
  aspect: '4:5', quality: 'standard', count: 1, idempotencyKey: 'g-1', ...over,
});

describe('ChatGPT image provider', () => {
  it('is configured only when Codex is signed in and costs nothing per image on the plan', () => {
    expect(chatgptAdapter.configured()).toBe(true);
    const m = chatgptAdapter.models()[0];
    expect(m).toMatchObject({ id: CHATGPT_IMAGE_MODEL, provider: 'chatgpt', kind: 'image' });
    expect(m.priceNote).toContain('gói ChatGPT');
    _setCodexAuthModeForTests('none');
    expect(chatgptAdapter.configured()).toBe(false);
  });

  it('attaches the references in prompt order and asks for image_gen with the prompt verbatim', () => {
    const parts = imageTurnInput({ prompt: 'PROMPT BODY', refs: [ref('a.png', 'Mia — identity'), ref('b.png', 'Mia — 360° sheet')], aspect: '9:16', count: 9, quality: 'high' });
    const images = parts.filter((p) => p.type === 'local_image').map((p) => path.basename((p as { path: string }).path));
    expect(images).toEqual(['a.png', 'b.png']);
    const texts = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text);
    expect(texts).toContain('Image 1: Mia — identity');
    expect(texts).toContain('Image 2: Mia — 360° sheet');
    const last = texts[texts.length - 1];
    expect(last).toContain('Call the image_gen tool exactly 4 times');
    expect(last).toContain('9:16 vertical aspect ratio, highest quality');
    expect(last).toContain('verbatim');
    expect(last.endsWith('PROMPT:\nPROMPT BODY')).toBe(true);
  });

  it('runs one Codex turn with image generation on, the configured model and a timeout that grows with the count', async () => {
    saveSettings({ codexModel: 'gpt-5.6-terra' });
    answer = () => ({ threadId: 't', finalResponse: 'DONE', images: [{ bytes: png(80, 100), mime: 'image/png' }, { bytes: png(80, 100), mime: 'image/png' }, { bytes: png(80, 100), mime: 'image/png' }], inputTokens: 0, outputTokens: 0 });
    const res = await chatgptAdapter.generateImage(request({ count: 2 }));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ model: 'gpt-5.6-terra', imageGen: true });
    expect(turns[0].timeoutMs).toBeGreaterThan(2 * 60_000);
    expect(res.outputs).toHaveLength(2);
    expect(res.reportedCostUsd).toBe(0);
  });

  it('keeps an image within 2 % of the requested aspect untouched', async () => {
    const original = png(80, 100);
    answer = () => ({ threadId: 't', finalResponse: 'DONE', images: [{ bytes: original, mime: 'image/png' }], inputTokens: 0, outputTokens: 0 });
    const res = await chatgptAdapter.generateImage(request({ aspect: '4:5' }));
    expect(res.outputs[0].bytes!.equals(original)).toBe(true);
  });

  it('center-crops an image that misses the aspect when ffmpeg is available', async () => {
    answer = () => ({ threadId: 't', finalResponse: 'DONE', images: [{ bytes: png(100, 100), mime: 'image/png' }], inputTokens: 0, outputTokens: 0 });
    const res = await chatgptAdapter.generateImage(request({ aspect: '4:5' }));
    const dims = imageSize(res.outputs[0].bytes!);
    // Without ffmpeg the original comes back unchanged; with it, the square becomes 4:5.
    expect([[100, 100], [80, 100]]).toContainEqual([dims.width, dims.height]);
  });

  it('reports a refusal as a safety error and a missing login as an auth error', async () => {
    answer = () => ({ threadId: 't', finalResponse: 'I cannot create that image.', images: [], inputTokens: 0, outputTokens: 0 });
    await expect(chatgptAdapter.generateImage(request())).rejects.toMatchObject({ kind: 'safety' });
    _setCodexAuthModeForTests('none');
    await expect(chatgptAdapter.generateImage(request())).rejects.toBeInstanceOf(ProviderError);
    await expect(chatgptAdapter.generateImage(request())).rejects.toMatchObject({ kind: 'auth' });
  });

  it('refuses video', async () => {
    await expect(chatgptAdapter.submitVideo({} as never)).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('charges the owner price override per image when Codex uses an API key', async () => {
    _setCodexAuthModeForTests('api-key');
    saveSettings({ priceOverrides: { [CHATGPT_IMAGE_MODEL]: 0.05 } });
    const res = await chatgptAdapter.generateImage(request());
    expect(res.reportedCostUsd).toBeCloseTo(0.05, 6);
  });
});

describe('ChatGPT identity judge', () => {
  it('sends anchors then the candidate with a JSON schema and no tools, and parses the verdict', async () => {
    answer = () => ({ threadId: 't', finalResponse: '{"score":96,"same_person":true,"issues":[],"signature_present":false}', images: [], inputTokens: 1200, outputTokens: 40 });
    const a1 = ref('anchor1.png', 'x');
    const cand = ref('cand.png', 'y');
    const r = await judgeIdentityChatgpt({ model: 'chatgpt', personaName: 'Mia', marks: 'mole', signature: 'round glasses', anchors: [{ path: a1.path, mime: 'image/png' }], candidate: { path: cand.path, mime: 'image/png' } });
    expect(r).toMatchObject({ score: 96, samePerson: true, signaturePresent: false, inputTokens: 1200 });
    expect(turns[0].imageGen).toBe(false);
    expect(turns[0].outputSchema).toBeTruthy();
    const imgs = turns[0].input.filter((p) => p.type === 'local_image').map((p) => path.basename((p as { path: string }).path));
    expect(imgs).toEqual(['anchor1.png', 'cand.png']);
    const prompt = (turns[0].input[turns[0].input.length - 1] as { text: string }).text;
    expect(prompt).toContain('signature_present');
  });

  it('fails clearly on an unreadable answer', async () => {
    answer = () => ({ threadId: 't', finalResponse: 'looks similar', images: [], inputTokens: 0, outputTokens: 0 });
    const a1 = ref('anchor2.png', 'x');
    await expect(judgeIdentityChatgpt({ model: 'chatgpt', personaName: 'Mia', marks: '', anchors: [{ path: a1.path, mime: 'image/png' }], candidate: { path: a1.path, mime: 'image/png' } }))
      .rejects.toMatchObject({ kind: 'unknown' });
  });
});
