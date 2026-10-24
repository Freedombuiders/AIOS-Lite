/**
 * Gemini adapter (Google AI Studio key GOOGLE_API_KEY): image models (Nano
 * Banana family) through generateContent with IMAGE output, Veo 3.1 through
 * generateVideos + operation polling, and the identity judge (vision model,
 * JSON out). Model ids were confirmed with models.list on 2026-10-20.
 */

import fs from 'node:fs';

import { GenerateVideosOperation, GoogleGenAI, Type } from '@google/genai';

import { googleApiKey } from '../config.js';
import { readBytes, send } from '../media-http.js';
import { priceNoteFor } from '../pricing.js';
import type { Aspect, ModelInfo, Quality } from '../types.js';
import {
  kindForStatus, ProviderError,
  type ImageRequest, type ImageResponse, type MediaOut, type ProviderAdapter, type VideoPoll, type VideoRequest,
} from './types.js';

const ALL_ASPECTS: Aspect[] = ['1:1', '4:5', '3:4', '2:3', '9:16', '16:9', '5:4', '4:3', '3:2'];
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;

interface GeminiImageSpec {
  /** Quality → imageConfig.imageSize. Absent: the model has one size and takes no imageSize. */
  sizes?: Partial<Record<Quality, '1K' | '2K' | '4K'>>;
}

/** The one place Gemini model ids live. */
const IMAGE_SPECS: Record<string, GeminiImageSpec> = {
  'gemini-3-pro-image': { sizes: { standard: '1K', high: '2K', ultra: '4K' } },
  'gemini-3.1-flash-image': { sizes: { standard: '1K', high: '2K', ultra: '4K' } },
  'gemini-2.5-flash-image': {},
};

export const GEMINI_MODELS: ModelInfo[] = [
  {
    id: 'gemini-3-pro-image', provider: 'gemini', kind: 'image', label: 'Nano Banana Pro (Gemini 3 Pro Image)',
    maxRefs: 14, aspects: ALL_ASPECTS, qualities: ['standard', 'high', 'ultra'], priceNote: priceNoteFor('gemini-3-pro-image'), recommended: true,
  },
  {
    id: 'gemini-3.1-flash-image', provider: 'gemini', kind: 'image', label: 'Nano Banana 2 (Gemini 3.1 Flash Image)',
    maxRefs: 14, aspects: ALL_ASPECTS, qualities: ['standard', 'high', 'ultra'], priceNote: priceNoteFor('gemini-3.1-flash-image'),
  },
  {
    id: 'gemini-2.5-flash-image', provider: 'gemini', kind: 'image', label: 'Nano Banana (Gemini 2.5 Flash Image)',
    maxRefs: 3, aspects: ALL_ASPECTS, qualities: ['standard'], priceNote: priceNoteFor('gemini-2.5-flash-image'),
  },
  {
    id: 'veo-3.1-fast-generate-preview', provider: 'gemini', kind: 'video', label: 'Veo 3.1 Fast',
    maxRefs: 1, aspects: ['9:16', '16:9'], qualities: ['standard', 'high'], durations: [4, 6, 8], audio: true,
    priceNote: priceNoteFor('veo-3.1-fast-generate-preview'), recommended: true,
  },
  {
    id: 'veo-3.1-generate-preview', provider: 'gemini', kind: 'video', label: 'Veo 3.1',
    maxRefs: 1, aspects: ['9:16', '16:9'], qualities: ['standard', 'high'], durations: [4, 6, 8], audio: true,
    priceNote: priceNoteFor('veo-3.1-generate-preview'),
  },
];

// ── Client ───────────────────────────────────────────────────────────

/** The slice of the SDK this adapter uses; tests pass a fake. */
export interface GeminiClientLike {
  models: {
    generateContent(params: unknown): Promise<unknown>;
    generateVideos(params: unknown): Promise<{ name?: string; done?: boolean; error?: Record<string, unknown> }>;
  };
  operations: {
    getVideosOperation(params: { operation: GenerateVideosOperation }): Promise<GenerateVideosOperation>;
  };
}

let clientOverride: GeminiClientLike | null = null;
let keyOverride: string | null = null;
let cached: { key: string; client: GeminiClientLike } | null = null;

/** @internal tests only. */
export function _setGeminiClientForTests(client: GeminiClientLike | null, key: string | null = client ? 'test-key' : null): void {
  clientOverride = client;
  keyOverride = key;
}

export function geminiKey(): string {
  return keyOverride ?? googleApiKey();
}

function client(): GeminiClientLike {
  if (clientOverride) return clientOverride;
  const key = geminiKey();
  if (!key) throw new ProviderError('auth', 'GOOGLE_API_KEY is not set');
  if (!cached || cached.key !== key) cached = { key, client: new GoogleGenAI({ apiKey: key }) as unknown as GeminiClientLike };
  return cached.client;
}

/** SDK error → ProviderError, with no url or key in the message. */
function wrap(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined;
  const raw = err instanceof Error ? err.message : String(err);
  let msg = raw.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]');
  const key = geminiKey();
  if (key) msg = msg.split(key).join('***');
  // The SDK often embeds the JSON error body: keep its message only.
  const m = /"message"\s*:\s*"([^"]{1,300})"/.exec(msg);
  if (m) msg = m[1];
  if (/aborted|timed? ?out/i.test(raw)) return new ProviderError('timeout', `gemini: ${msg.slice(0, 300)}`, status);
  if (/SAFETY|blocked|PROHIBITED/i.test(raw) && !status) return new ProviderError('safety', `gemini: ${msg.slice(0, 300)}`);
  return new ProviderError(status ? kindForStatus(status) : 'unknown', `gemini: ${msg.slice(0, 300)}`, status);
}

async function inline(p: { path: string; mime: string }): Promise<{ inlineData: { mimeType: string; data: string } }> {
  const data = (await fs.promises.readFile(p.path)).toString('base64');
  return { inlineData: { mimeType: p.mime, data } };
}

interface GenContentResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean; inlineData?: { data?: string; mimeType?: string } }[] } }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  text?: string;
}

const SAFETY_REASONS = /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/i;

/** Final images of a response. Interim "thought" images (Gemini 3 Pro Image) are skipped. */
function imagesOf(res: GenContentResponse): MediaOut[] {
  const out: MediaOut[] = [];
  for (const c of res.candidates ?? []) {
    for (const part of c.content?.parts ?? []) {
      if (part.thought) continue;
      const d = part.inlineData;
      if (d?.data && (d.mimeType ?? 'image/png').startsWith('image/')) out.push({ bytes: Buffer.from(d.data, 'base64'), mime: d.mimeType ?? 'image/png' });
    }
  }
  return out;
}

function noImageError(res: GenContentResponse): ProviderError {
  const block = res.promptFeedback?.blockReason;
  const finish = res.candidates?.[0]?.finishReason;
  const reason = block || finish || 'no image returned';
  if (SAFETY_REASONS.test(String(reason))) return new ProviderError('safety', `gemini: ${reason}`);
  return new ProviderError('rejected', `gemini: model returned no image (${reason})`);
}

// ── Images ───────────────────────────────────────────────────────────

async function generateImage(req: ImageRequest): Promise<ImageResponse> {
  const spec = IMAGE_SPECS[req.model.id];
  if (!spec) throw new ProviderError('unsupported', `gemini: unknown image model ${req.model.id}`);
  const parts: unknown[] = [];
  for (const [i, ref] of req.refs.entries()) {
    parts.push({ text: `Image ${i + 1} (${ref.label}):` });
    parts.push(await inline(ref));
  }
  parts.push({ text: req.prompt });
  const size = spec.sizes?.[req.quality] ?? spec.sizes?.standard;
  const config: Record<string, unknown> = {
    responseModalities: ['IMAGE'],
    imageConfig: { aspectRatio: req.aspect, ...(size ? { imageSize: size } : {}) },
    ...(req.signal ? { abortSignal: req.signal } : {}),
  };
  const outputs: MediaOut[] = [];
  let firstError: ProviderError | null = null;
  // The image models return one picture per call: one call per requested image.
  for (let i = 0; i < Math.max(1, req.count); i++) {
    try {
      const seed = req.seed !== undefined ? req.seed + i : undefined;
      const res = await client().models.generateContent({
        model: req.model.id,
        contents: [{ role: 'user', parts }],
        config: seed !== undefined ? { ...config, seed } : config,
      }) as GenContentResponse;
      const imgs = imagesOf(res);
      if (imgs.length === 0) throw noImageError(res);
      outputs.push(imgs[imgs.length - 1]);
    } catch (err) {
      const e = wrap(err);
      firstError ??= e;
      // Auth/quota failures will repeat: stop early.
      if (e.kind === 'auth' || e.kind === 'quota') break;
    }
  }
  if (outputs.length === 0) throw firstError ?? new ProviderError('unknown', 'gemini: no image');
  return { outputs, reportedCostUsd: null };
}

// ── Video (Veo) ──────────────────────────────────────────────────────

async function submitVideo(req: VideoRequest): Promise<{ handle: string }> {
  if (req.model.kind !== 'video') throw new ProviderError('unsupported', 'gemini: lipsync is not available on Gemini');
  const durations = req.model.durations ?? [8];
  const duration = durations.includes(req.durationSec) ? req.durationSec : durations[durations.length - 1];
  // 1080p is only allowed with 8 s clips.
  const resolution = req.quality === 'high' && duration === 8 ? '1080p' : '720p';
  const config: Record<string, unknown> = {
    numberOfVideos: 1,
    durationSeconds: duration,
    aspectRatio: req.aspect === '16:9' ? '16:9' : '9:16',
    resolution,
    negativePrompt: 'face morphing, identity change, warped face, extra fingers, distorted hands, text, watermark, subtitles, logo',
    ...(req.startFrame ? { personGeneration: 'allow_adult' } : {}),
    // The Gemini API rejects `seed` and `generateAudio` for Veo (the SDK throws); Veo 3.x always makes audio there.
  };
  const params: Record<string, unknown> = { model: req.model.id, prompt: req.prompt, config };
  if (req.startFrame) {
    const data = (await fs.promises.readFile(req.startFrame.path)).toString('base64');
    params.image = { imageBytes: data, mimeType: req.startFrame.mime };
  }
  try {
    const op = await client().models.generateVideos(params);
    if (!op.name) throw new ProviderError('unknown', 'gemini: Veo returned no operation id');
    return { handle: op.name };
  } catch (err) {
    throw wrap(err);
  }
}

async function downloadVideo(video: { uri?: string; videoBytes?: string; mimeType?: string }, signal?: AbortSignal): Promise<MediaOut> {
  if (video.videoBytes) return { bytes: Buffer.from(video.videoBytes, 'base64'), mime: video.mimeType ?? 'video/mp4' };
  if (!video.uri) throw new ProviderError('unknown', 'gemini: Veo result has no video');
  const key = geminiKey();
  const res = await send({
    service: 'gemini', secret: key, url: video.uri,
    headers: { 'x-goog-api-key': key, Accept: '*/*' },
  }, { timeoutMs: 300_000, signal });
  return { bytes: await readBytes(res, MAX_VIDEO_BYTES, 'gemini'), mime: video.mimeType ?? 'video/mp4' };
}

async function pollVideo(handle: string, _model: ModelInfo, signal?: AbortSignal): Promise<VideoPoll> {
  const op = new GenerateVideosOperation();
  op.name = handle;
  let res: GenerateVideosOperation;
  try {
    res = await client().operations.getVideosOperation({ operation: op });
  } catch (err) {
    const e = wrap(err);
    if (e.status === 404) return { state: 'failed', error: 'gemini: operation not found (expired)' };
    throw e;
  }
  if (!res.done) return { state: 'pending' };
  if (res.error) {
    const msg = typeof res.error.message === 'string' ? res.error.message : 'video generation failed';
    return { state: 'failed', error: `gemini: ${msg.slice(0, 300)}` };
  }
  const videos = res.response?.generatedVideos ?? [];
  const first = videos.find((v) => v.video)?.video;
  if (!first) {
    const reasons = res.response?.raiMediaFilteredReasons?.join('; ');
    return { state: 'failed', error: reasons ? `gemini: blocked by safety filter (${reasons.slice(0, 200)})` : 'gemini: no video returned' };
  }
  try {
    return { state: 'done', outputs: [await downloadVideo(first, signal)], reportedCostUsd: null };
  } catch (err) {
    throw err instanceof ProviderError ? err : new ProviderError(kindForStatus((err as { status?: number }).status), (err as Error).message);
  }
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  label: 'Google Gemini',
  hint: 'Thêm khóa GOOGLE_API_KEY (Google AI Studio) ở Kết nối.',
  configured: () => Boolean(geminiKey()),
  models: () => GEMINI_MODELS,
  generateImage,
  submitVideo,
  pollVideo,
};

// ── Identity judge ───────────────────────────────────────────────────

export interface JudgeImage { path: string; mime: string }
export interface JudgeRequest {
  model: string;
  personaName: string;
  /** Permanent marks the judge should look for (moles, freckles…). */
  marks: string;
  /** The persona's signature look (glasses, earrings…), checked separately from the face. */
  signature?: string;
  /** The persona is a real, consenting adult (identity source 'licensed'): the references are real photos. */
  realPerson?: boolean;
  anchors: JudgeImage[];
  candidate: JudgeImage;
  signal?: AbortSignal;
}
export interface JudgeResult {
  score: number;
  samePerson: boolean;
  issues: string[];
  /** false when the signature look is clearly missing, true when present, null when not visible or not asked. */
  signaturePresent?: boolean | null;
  /** 0–100: how much the candidate reads as a real, unretouched camera photo (null when the judge gave none). */
  realism?: number | null;
  inputTokens: number;
  outputTokens: number;
}

export function judgeConfigured(): boolean {
  return Boolean(geminiKey());
}

export function buildJudgePrompt(personaName: string, marks: string, anchorCount: number, signature = '', realPerson = false): string {
  const sig = signature.trim();
  return [
    ...(realPerson
      ? [
        `You are a strict likeness checker for a personal-brand studio. ${personaName || 'The owner'} is a real adult who runs this studio and consented to AI renders of his or her own likeness for their own social channels. This is a quality check of a render against that person's own reference photos, requested by that person; it is not identifying an unknown person.`,
        `Images 1–${anchorCount} are reference photos and approved renders of ${personaName || 'the owner'}. The LAST image is a newly generated AI candidate render.`,
      ]
      : [
        'You are a strict character-consistency checker for a virtual-influencer studio. Every image here is AI-generated and shows a FICTIONAL character; this is a continuity check between renders of that character, not the identification of a real person.',
        `Images 1–${anchorCount} are the approved reference renders of the character ${personaName || 'the persona'}. The LAST image is a newly generated candidate render.`,
      ]),
    'Judge ONLY whether the candidate depicts the same character design: facial bone structure, face shape, eye shape, spacing and colour, eyebrows, nose, lips, jawline, ears, skin tone'
      + (marks.trim() ? `, and these permanent marks: ${marks.trim()}` : '') + '.',
    'Ignore clothing, hairstyle and hair colour changes, makeup, lighting, pose, expression, camera angle, background and photo style.',
    'Score 0–100: 95–100 unmistakably the same person; 85–94 same person with minor drift; 70–84 clear resemblance but noticeable drift; 50–69 only a family-like resemblance; below 50 a different person.',
    'If no face is clearly visible in the candidate, give score 0, same_person false and say so.',
    'In "issues" list up to 5 short problems IN VIETNAMESE (identity drift such as "mũi to hơn", "mắt khác màu", plus realism defects such as "tay thừa ngón", "da nhựa"). Empty list when there is nothing to fix.',
    ...(sig
      ? [`Separately, check the signature look the audience recognises: ${sig}. Its MAIN element is the first item listed; the others are secondary accessories that clothing, hair or framing may hide. Set "signature_present" to false only when the main element is clearly missing from the candidate, true when it is there, and null when that part of the body is not visible (cropped, turned away, covered by hair). Missing secondary accessories never make it false. This check does NOT change the identity score.`]
      : []),
    'Separately, score "realism" 0–100 for the candidate alone: how much it reads as a real, unretouched photograph of a real human on a real camera. '
      + '90–100 indistinguishable from a real camera photo (natural skin texture and pores, natural light, believable fabric and hair); '
      + '80–89 a real photo with light retouching; 65–79 noticeably AI-polished (airbrushed or waxy skin, doll-like perfection, CGI sheen, over-smooth hair); '
      + 'below 65 obviously AI (plastic skin, malformed hands, fingers or teeth, garbled text, impossible anatomy). Realism does NOT change the identity score.',
    `Answer with JSON only: {"score": number, "same_person": boolean, "issues": string[], "realism": number${sig ? ', "signature_present": boolean | null' : ''}}.`,
  ].join('\n');
}

/** Parses the judge's JSON defensively. */
export function parseJudgeJson(text: string): { score: number; samePerson: boolean; issues: string[]; signaturePresent: boolean | null; realism: number | null } | null {
  let raw: unknown;
  const trimmed = text.trim();
  try {
    raw = JSON.parse(trimmed);
  } catch {
    const m = /\{[\s\S]*\}/.exec(trimmed);
    if (!m) return null;
    try { raw = JSON.parse(m[0]); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const score = Number(o.score);
  if (!Number.isFinite(score)) return null;
  const same = o.same_person ?? o.samePerson;
  const issues = Array.isArray(o.issues) ? o.issues.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 160)).slice(0, 5) : [];
  const sig = o.signature_present ?? o.signaturePresent;
  const signaturePresent = sig === true || sig === 'true' ? true : sig === false || sig === 'false' ? false : null;
  const real = o.realism == null || o.realism === '' ? NaN : Number(o.realism);
  const realism = Number.isFinite(real) ? Math.max(0, Math.min(100, Math.round(real))) : null;
  return { score: Math.max(0, Math.min(100, Math.round(score))), samePerson: same === true || same === 'true', issues, signaturePresent, realism };
}

export async function judgeIdentity(req: JudgeRequest): Promise<JudgeResult> {
  if (req.anchors.length === 0) throw new ProviderError('rejected', 'judge: no anchor image');
  const parts: unknown[] = [];
  for (const [i, a] of req.anchors.entries()) {
    parts.push({ text: `Image ${i + 1} (reference):` });
    parts.push(await inline(a));
  }
  parts.push({ text: `Image ${req.anchors.length + 1} (candidate):` });
  parts.push(await inline(req.candidate));
  parts.push({ text: buildJudgePrompt(req.personaName, req.marks, req.anchors.length, req.signature ?? '', req.realPerson) });
  const config: Record<string, unknown> = {
    temperature: 0,
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        score: { type: Type.INTEGER },
        same_person: { type: Type.BOOLEAN },
        issues: { type: Type.ARRAY, items: { type: Type.STRING } },
        realism: { type: Type.INTEGER },
        ...(req.signature?.trim() ? { signature_present: { type: Type.BOOLEAN, nullable: true } } : {}),
      },
      required: ['score', 'same_person', 'issues'],
    },
    ...(req.model.startsWith('gemini-2.5-flash') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    ...(req.signal ? { abortSignal: req.signal } : {}),
  };
  let res: GenContentResponse;
  try {
    res = await client().models.generateContent({ model: req.model, contents: [{ role: 'user', parts }], config }) as GenContentResponse;
  } catch (err) {
    throw wrap(err);
  }
  const text = res.text ?? res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const parsed = parseJudgeJson(text);
  if (!parsed) throw new ProviderError('unknown', 'judge: unreadable answer');
  const u = res.usageMetadata ?? {};
  return {
    ...parsed,
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}
