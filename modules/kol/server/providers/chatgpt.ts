/**
 * ChatGPT provider: OpenAI image generation through Codex's built-in `image_gen` tool,
 * signed in with the owner's ChatGPT plan (`codex login`) — no per-image price — or with
 * OPENAI_API_KEY when one is set (then OpenAI bills the API account).
 *
 * One Codex turn per request (src/kol/codex.ts): the identity references are attached as
 * images in prompt order, the composed prompt is passed verbatim, and the model calls
 * image_gen once per requested image. Aspect ratio is asked for in the prompt; outputs that
 * miss it by more than 2 % are center-cropped to the exact ratio.
 *
 * Also the ChatGPT identity judge: the same runner with no tools and a JSON output schema.
 */

import fs from 'fs';
import path from 'path';

import { imageSize } from 'image-size';

import { CODEX_LOGIN_HINT, codexAuthMode, codexRunner } from '../codex.js';
import { loadSettings } from '../core.js';
import { ffmpegBin, runBin, tempPath } from '../files.js';
import { aspectRatioValue } from '../prompt.js';
import { planFilter, planInstagramImage } from '../stage.js';
import type { Aspect, ModelInfo } from '../types.js';
import { buildJudgePrompt, parseJudgeJson, type JudgeRequest, type JudgeResult } from './gemini.js';
import { ProviderError, type ImageRequest, type ImageResponse, type InputFile, type MediaOut, type ProviderAdapter } from './types.js';

export const CHATGPT_IMAGE_MODEL = 'chatgpt-image';

const ASPECTS: Aspect[] = ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9', '5:4', '4:3', '3:2'];
/** Codex takes about two minutes per image (95–120 s measured); leave room for four plus start-up. */
const PER_IMAGE_MS = 150_000;
const JUDGE_TIMEOUT_MS = 120_000;
/**
 * Attached images per turn: identity refs first (the composer already ordered and capped them).
 * ChatGPT's image tool refuses more than 5 reference images ("accepts at most 5 attached reference images", 2026-10-20).
 */
const MAX_REFS = 5;

function model(): ModelInfo {
  const apiKey = codexAuthMode() === 'api-key';
  return {
    id: CHATGPT_IMAGE_MODEL,
    provider: 'chatgpt',
    kind: 'image',
    label: 'ChatGPT Images (gpt-image qua Codex)',
    maxRefs: MAX_REFS,
    aspects: ASPECTS,
    qualities: ['standard', 'high'],
    priceNote: apiKey ? 'Tính vào tài khoản API OpenAI (OPENAI_API_KEY) · ~2 phút/ảnh' : 'Trong gói ChatGPT, không tính tiền mỗi ảnh · ~2 phút/ảnh',
  };
}

const ORIENTATION = (aspect: Aspect): string => {
  const r = aspectRatioValue(aspect);
  return r === 1 ? 'square' : r < 1 ? 'vertical' : 'horizontal';
};

/** The instruction Codex follows: attach roles, then call image_gen `count` times with the prompt verbatim. */
export type CodexPart = { type: 'text'; text: string } | { type: 'local_image'; path: string };

export function imageTurnInput(req: Pick<ImageRequest, 'prompt' | 'refs' | 'aspect' | 'count' | 'quality'>): CodexPart[] {
  const parts: CodexPart[] = [];
  const refs = req.refs.slice(0, MAX_REFS);
  if (refs.length) {
    parts.push({ type: 'text', text: `You are an image production operator for a photo studio. ${refs.length} reference image${refs.length > 1 ? 's are' : ' is'} attached, in this order:` });
    refs.forEach((r, i) => {
      parts.push({ type: 'text', text: `Image ${i + 1}: ${r.label}` });
      parts.push({ type: 'local_image', path: r.path });
    });
  } else {
    parts.push({ type: 'text', text: 'You are an image production operator for a photo studio. No reference images are attached.' });
  }
  const n = Math.max(1, Math.min(4, req.count));
  const size = `${req.aspect} ${ORIENTATION(req.aspect)} aspect ratio${req.quality === 'high' ? ', highest quality' : ''}`;
  parts.push({
    type: 'text',
    text: [
      `Call the image_gen tool exactly ${n} time${n > 1 ? 's' : ''}${n > 1 ? ' (one image per call, each a separate take of the same brief)' : ''}.`,
      refs.length ? 'Pass the attached reference images to image_gen as reference/input images so the person stays identical.' : '',
      `Output format: ${size}.`,
      'Use the PROMPT below verbatim as the image_gen prompt. Do not shorten, soften, translate or rewrite it, and do not add text, captions or watermarks.',
      'Do not call any other tool. When the images are generated, reply with the single word DONE.',
      '',
      'PROMPT:',
      req.prompt,
    ].filter((l) => l !== '').join('\n'),
  });
  return parts;
}

/** Center-crops an image to the requested aspect when it misses by more than 2 %. Returns the original on any problem. */
async function fitAspect(out: { bytes: Buffer; mime: string }, aspect: Aspect): Promise<MediaOut> {
  try {
    const dims = imageSize(out.bytes);
    const w = dims.width ?? 0;
    const h = dims.height ?? 0;
    const target = aspectRatioValue(aspect);
    if (!(w > 0 && h > 0) || Math.abs(Math.log((w / h) / target)) <= Math.log(1.02)) return { bytes: out.bytes, mime: out.mime };
    const plan = planInstagramImage(w, h, w, target, target);
    const src = tempPath(out.mime === 'image/jpeg' ? '.jpg' : '.png');
    const dest = tempPath('.png');
    fs.writeFileSync(src, out.bytes);
    try {
      const res = await runBin(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-vf', planFilter(plan), dest], 60_000);
      if (res.code !== 0 || !fs.existsSync(dest)) return { bytes: out.bytes, mime: out.mime };
      return { bytes: fs.readFileSync(dest), mime: 'image/png' };
    } finally {
      for (const f of [src, dest]) { try { fs.rmSync(f, { force: true }); } catch { /* temp */ } }
    }
  } catch {
    return { bytes: out.bytes, mime: out.mime };
  }
}

async function generateImage(req: ImageRequest): Promise<ImageResponse> {
  if (codexAuthMode() === 'none') throw new ProviderError('auth', 'Codex is not signed in');
  const missing = req.refs.find((r) => !fs.existsSync(r.path));
  if (missing) throw new ProviderError('rejected', `reference image missing: ${path.basename(missing.path)}`);
  const count = Math.max(1, Math.min(4, req.count));
  const settings = loadSettings();
  const result = await codexRunner()({
    input: imageTurnInput({ ...req, count }),
    model: settings.codexModel,
    imageGen: true,
    signal: req.signal,
    timeoutMs: 30_000 + PER_IMAGE_MS * count,
  });
  if (result.images.length === 0) {
    const said = result.finalResponse.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new ProviderError(/safety|policy|can['’]?t|cannot|unable|not able|won['’]?t|declin|refus/i.test(said) ? 'safety' : 'unknown', said ? `no image generated: ${said}` : 'no image generated');
  }
  const outputs: MediaOut[] = [];
  for (const img of result.images.slice(0, count)) outputs.push(await fitAspect(img, req.aspect));
  // Subscription images cost nothing per call. In API-key mode OpenAI bills the account: the
  // owner's price override (USD per image) is used when set, so Budgets still sees the spend.
  const override = settings.priceOverrides[CHATGPT_IMAGE_MODEL];
  const reportedCostUsd = codexAuthMode() === 'api-key' && typeof override === 'number' ? override * outputs.length : 0;
  return { outputs, reportedCostUsd };
}

export const chatgptAdapter: ProviderAdapter = {
  id: 'chatgpt',
  label: 'ChatGPT (Codex)',
  hint: CODEX_LOGIN_HINT,
  configured: () => codexAuthMode() !== 'none',
  models: () => [model()],
  generateImage,
  submitVideo: async () => { throw new ProviderError('unsupported', 'ChatGPT does not generate video'); },
  pollVideo: async () => ({ state: 'failed', error: 'ChatGPT does not generate video' }),
};

// ── Identity judge ───────────────────────────────────────────────────

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    same_person: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    signature_present: { type: ['boolean', 'null'] },
    realism: { type: 'integer' },
  },
  required: ['score', 'same_person', 'issues', 'signature_present', 'realism'],
  additionalProperties: false,
};

export function chatgptJudgeConfigured(): boolean {
  return codexAuthMode() !== 'none';
}

/** Same contract as the Gemini judge (anchors first, candidate last). */
export async function judgeIdentityChatgpt(req: JudgeRequest): Promise<JudgeResult> {
  if (req.anchors.length === 0) throw new ProviderError('rejected', 'judge: no anchor image');
  const input: CodexPart[] = [];
  req.anchors.forEach((a, i) => {
    input.push({ type: 'text', text: `Image ${i + 1} (reference):` });
    input.push({ type: 'local_image', path: a.path });
  });
  input.push({ type: 'text', text: `Image ${req.anchors.length + 1} (candidate):` });
  input.push({ type: 'local_image', path: req.candidate.path });
  input.push({ type: 'text', text: `${buildJudgePrompt(req.personaName, req.marks, req.anchors.length, req.signature ?? '', req.realPerson)}\nDo not call any tool.` });
  const result = await codexRunner()({
    input,
    model: loadSettings().codexModel,
    imageGen: false,
    outputSchema: JUDGE_SCHEMA,
    signal: req.signal,
    timeoutMs: JUDGE_TIMEOUT_MS,
  });
  const parsed = parseJudgeJson(result.finalResponse);
  if (!parsed) throw new ProviderError('unknown', 'judge: unreadable answer');
  return { ...parsed, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

/** Exposed for tests: the attachment order the judge and generator use. */
export function _attachmentPaths(refs: InputFile[]): string[] {
  return refs.slice(0, MAX_REFS).map((r) => r.path);
}
