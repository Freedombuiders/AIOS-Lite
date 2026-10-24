/**
 * Scene engines: start a scene on its provider, then poll until the clip is on disk.
 * Every engine writes the same output: scenes/<id>.mp4 (+ .srt for HeyGen) and a thumbnail.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { loadIntegrationValues } from '../../integration-values.js';
import { createPexelsClient } from '../../../../../src/integrations/pexels/client.js';
import { bestVideoFile } from '../../../../../src/integrations/pexels/commands.js';
import { makeThumbnail } from '../media.js';
import { probeDuration, runFfmpeg } from '../pipeline/tools.js';
import type { HeygenClient } from './heygen.js';
import { FAL_VIDEO_MODEL, VEO_MODEL, veoAspect, type KolBridge } from './kol-bridge.js';
import type { ProductionStore } from './store.js';
import type { EngineStatus, KolVoice, Production, ProductionScene } from './types.js';
import { VEO_MAX_SEC } from './types.js';

export interface RocketLike {
  submit(input: unknown, provenance?: { agentId?: string; project?: string }): Promise<{ id: string; jobId?: string; state: string; output: string }>;
}

/** Licence-free stock footage (Pexels): free b-roll for scenes without a KOL. */
export interface StockSource {
  configured(): boolean;
  /** `pick` rotates through the matches: a retake gets the next clip instead of the same one. */
  find(query: string, aspect: Production['aspect'], minSec: number, pick?: number): Promise<{ link: string; by: string; pageUrl: string; durationSec: number } | null>;
  download(url: string, dest: string): Promise<void>;
}

function pexelsKey(): string | null {
  try { return loadIntegrationValues('pexels')?.api_key?.trim() || null; } catch { return null; }
}

export const pexelsStock: StockSource = {
  configured: () => Boolean(pexelsKey()),
  async find(query, aspect, minSec, pick = 0) {
    const apiKey = pexelsKey();
    if (!apiKey) return null;
    const orientation = aspect === '16:9' ? 'landscape' : aspect === '1:1' ? 'square' : 'portrait';
    const r = await createPexelsClient({ apiKey }).searchVideos({ query, orientation, perPage: 15 });
    const long = (r.videos ?? []).filter((v) => v.duration >= Math.max(2, minSec * 0.8));
    const hits = (long.length ? long : r.videos ?? [])
      .map((v) => ({ v, file: bestVideoFile(v.video_files) }))
      .filter((x) => x.file?.link);
    if (!hits.length) return null;
    const { v, file } = hits[Math.abs(pick) % hits.length];
    return { link: file!.link, by: v.user?.name ?? 'Pexels', pageUrl: v.url, durationSec: v.duration };
  },
  async download(url, dest) {
    if (!/^https:\/\//.test(url)) throw new Error('Đường dẫn video stock không hợp lệ.');
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`Không tải được video stock (HTTP ${res.status}).`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  },
};

export interface EngineDeps {
  heygen: HeygenClient;
  /** Stock footage source (default Pexels). */
  stock?: StockSource;
  kol: KolBridge;
  rocket: RocketLike | null;
  /** Where the RocketFlow extension drops finished files (studio-<requestId>/). */
  rocketDownloadRoot: string;
  rocketInstalled: () => boolean;
  store: ProductionStore;
  /** Test seams. */
  thumbnail?: (src: string, dest: string, durationSec: number) => Promise<void>;
  probe?: (file: string) => Promise<number>;
  sheet?: (file: string, dest: string, durationSec: number, start: number) => Promise<void>;
}

export type StartResult = { job: NonNullable<ProductionScene['job']> } | { output: NonNullable<ProductionScene['output']> };
export type PollResult = 'pending' | { output: NonNullable<ProductionScene['output']> } | { error: string };

/** Veo speaks a short line natively; longer lines belong to HeyGen. */
export const VEO_SCRIPT_MAX = 200;
/** A RocketFlow job with no file after this long is reported, never resubmitted. */
const ROCKET_TIMEOUT_MS = 30 * 60_000;

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function engineStatuses(deps: Pick<EngineDeps, 'heygen' | 'kol' | 'rocketInstalled' | 'stock'>, extra: { hyperframes: EngineStatus; whisper: EngineStatus; elevenlabs: EngineStatus }): EngineStatus[] {
  const heygen = deps.heygen.configured();
  const stock = (deps.stock ?? pexelsStock).configured();
  const veo = deps.kol.ready('gemini');
  const fal = deps.kol.ready('fal');
  const rocket = deps.rocketInstalled();
  return [
    { id: 'heygen', label: 'HeyGen', role: 'KOL nói trước ống kính bằng giọng nhân bản, khớp khẩu hình, không giới hạn độ dài', ready: heygen,
      detail: heygen ? 'Đã kết nối' : 'Chưa có API key', fix: heygen ? null : 'Integrations › HeyGen' },
    { id: 'veo', label: 'Google Veo 3.1', role: 'Cảnh KOL chuyển động (giữ đúng mặt) và B-roll từ mô tả; nói câu ngắn ≤ 8 giây', ready: veo,
      detail: veo ? 'Đã kết nối (GOOGLE_API_KEY)' : 'Chưa có GOOGLE_API_KEY', fix: veo ? null : 'Thêm GOOGLE_API_KEY vào .env' },
    { id: 'fal', label: 'fal.ai (Kling, Seedance…)', role: 'Cảnh KOL chuyển động bằng các model video hàng đầu', ready: fal,
      detail: fal ? 'Đã kết nối' : 'Chưa có API key', fix: fal ? null : 'Integrations › fal.ai' },
    { id: 'rocketflow', label: 'RocketFlow (Google Flow)', role: 'B-roll qua Google Flow bằng tài khoản của bạn', ready: rocket,
      detail: rocket ? 'Đã cài tiện ích' : 'Chưa cài RocketFlow trên máy này', fix: rocket ? null : 'Cài RocketFlow, đặt ROCKETFLOW_MCP_SERVER rồi khởi động lại' },
    { id: 'stock', label: 'Pexels (stock)', role: 'B-roll quay thật miễn phí, đúng khung hình, có ghi công tác giả', ready: stock,
      detail: stock ? 'Đã kết nối' : 'Chưa có API key', fix: stock ? null : 'Integrations › Pexels' },
    extra.hyperframes,
    extra.whisper,
    extra.elevenlabs,
  ];
}

/** A licensed (real) person: Veo refuses real names and likenesses, so their face never goes to Veo. */
export function isRealPerson(kolId: string | null, deps: Pick<EngineDeps, 'kol'>): boolean {
  return Boolean(kolId && deps.kol.persona(kolId)?.identitySource === 'licensed');
}

const fold = (s: string) => [...s].map((ch) => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D') || ch).join('');

/** Replaces real people's names and handles in a model prompt with "the presenter" (Veo blocks real names). */
export function scrubRealNames(text: string, p: Pick<Production, 'cast'>, deps: Pick<EngineDeps, 'kol'>): string {
  // Fold accents per character (NFC first) so match positions in the folded text map 1:1 to the original.
  let out = text.normalize('NFC');
  for (const id of p.cast) {
    const persona = deps.kol.persona(id);
    if (persona?.identitySource !== 'licensed') continue;
    for (const name of [persona.name, persona.handle ? `@${persona.handle}` : '', persona.handle].filter((x) => x && x.length > 2)) {
      const pattern = new RegExp(fold(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
      const folded = fold(out);
      let rebuilt = '';
      let last = 0;
      for (const m of folded.matchAll(pattern)) { rebuilt += out.slice(last, m.index) + 'the presenter'; last = (m.index ?? 0) + m[0].length; }
      out = rebuilt + out.slice(last);
    }
  }
  return out;
}

/** Why a scene cannot start yet (Vietnamese), or null when it can. */
export function sceneProblem(scene: ProductionScene, deps: Pick<EngineDeps, 'heygen' | 'kol' | 'rocketInstalled' | 'stock'>, voices: Record<string, KolVoice>): string | null {
  switch (scene.engine) {
    case 'heygen':
      if (!deps.heygen.configured()) return 'Chưa kết nối HeyGen (Integrations › HeyGen).';
      if (!scene.kolId) return 'Cảnh nói cần chọn KOL.';
      if (!voices[scene.kolId]) return 'Chưa chọn giọng HeyGen cho KOL này (Video Studio › Kết nối).';
      if (!scene.text.trim()) return 'Cảnh nói cần lời thoại.';
      return null;
    case 'veo':
      if (!deps.kol.ready('gemini')) return 'Chưa có GOOGLE_API_KEY cho Veo.';
      if (isRealPerson(scene.kolId, deps)) {
        return `${deps.kol.persona(scene.kolId!)?.name ?? 'KOL này'} là người thật: Veo không dựng khuôn mặt hay tên người thật. Cảnh nói dùng HeyGen; B-roll thì bỏ KOL khỏi cảnh.`;
      }
      if (scene.kind === 'talking' && scene.text.trim().length > VEO_SCRIPT_MAX) return `Veo chỉ nói câu ngắn (≤ ${VEO_SCRIPT_MAX} ký tự, ≤ 8 giây). Dùng HeyGen hoặc tách cảnh.`;
      if (scene.kind === 'talking' && !scene.kolId) return 'Cảnh nói cần chọn KOL.';
      return null;
    case 'fal':
      if (!deps.kol.ready('fal')) return 'Chưa kết nối fal.ai (Integrations › fal.ai).';
      if (!scene.kolId) return 'fal tạo video từ ảnh: chọn KOL cho cảnh này.';
      return null;
    case 'rocketflow':
      if (!deps.rocketInstalled()) return 'Chưa cài RocketFlow trên máy này.';
      if (isRealPerson(scene.kolId, deps)) {
        return `${deps.kol.persona(scene.kolId!)?.name ?? 'KOL này'} là người thật: Google Flow (Veo) không dựng khuôn mặt người thật. Dùng HeyGen cho cảnh nói.`;
      }
      if (scene.kind === 'talking' && !scene.text.trim()) return 'Cảnh nói cần lời thoại.';
      if (scene.kind === 'talking' && scene.text.trim().length > VEO_SCRIPT_MAX) return `Flow (Veo) chỉ nói câu ngắn (≤ ${VEO_SCRIPT_MAX} ký tự, ≤ 8 giây). Tách cảnh hoặc dùng HeyGen.`;
      if (scene.kind !== 'talking' && !scene.visual.trim()) return 'Cảnh B-roll cần mô tả hình ảnh.';
      return null;
    case 'stock':
      if (!(deps.stock ?? pexelsStock).configured()) return 'Chưa kết nối Pexels (Integrations › Pexels).';
      if (!scene.visual.trim()) return 'Cảnh stock cần mô tả hình ảnh (tiếng Anh tìm tốt hơn).';
      return null;
    case 'clip':
      return scene.clipAssetId ? null : 'Chọn một video có sẵn cho cảnh này.';
  }
}

/** The KOL image used as the face/start frame: the scene's pick, else the KOL's newest approved image. */
export function sourceFor(scene: ProductionScene, deps: Pick<EngineDeps, 'kol'>, voices: Record<string, KolVoice>): string {
  if (scene.sourceAssetId) return scene.sourceAssetId;
  const m = scene.kolId ? deps.kol.member(scene.kolId, voices) : null;
  const first = m?.images[0]?.id;
  if (!first) throw new Error('KOL chưa có ảnh nào đã duyệt để làm khuôn mặt.');
  return first;
}

/**
 * Probes the take and makes its thumbnail. `cap` limits what plays (stock footage is often far longer
 * than the scene): the whole file stays as `sourceSec`, so the owner or the director can re-trim.
 */
async function finishFile(p: Production, scene: ProductionScene, deps: EngineDeps, file: string, srt: string | null, credit?: string, cap?: number): Promise<NonNullable<ProductionScene['output']>> {
  const probe = deps.probe ?? probeDuration;
  let sourceSec = scene.durationSec;
  try { sourceSec = (await probe(file)) || scene.durationSec; } catch { /* keep the planned length */ }
  const durationSec = cap ? Math.round(Math.min(sourceSec, cap) * 1000) / 1000 : sourceSec;
  const thumb = deps.store.sceneFile(p.id, scene.id, 'jpg');
  try { await (deps.thumbnail ?? makeThumbnail)(file, thumb, durationSec); } catch { /* no thumb */ }
  return { file: path.basename(file), durationSec, sourceSec, subtitles: srt ? path.basename(srt) : null, thumb: fs.existsSync(thumb) ? path.basename(thumb) : null, ...(credit ? { credit } : {}) };
}

/** A strip of evenly spaced frames from a take, so the director can look at what was generated. */
export async function contactSheet(file: string, dest: string, durationSec: number, opts: { start?: number; frames?: number; ffmpeg?: typeof runFfmpeg } = {}): Promise<void> {
  const frames = Math.max(2, Math.min(6, opts.frames ?? 4));
  const span = Math.max(0.5, durationSec);
  const rate = frames / span;
  await (opts.ffmpeg ?? runFfmpeg)([
    '-y', '-ss', String(Math.max(0, opts.start ?? 0)), '-t', String(span), '-i', file,
    '-vf', `fps=${rate.toFixed(4)},scale=320:-2,tile=${frames}x1:padding=4:color=black`, '-frames:v', '1', '-q:v', '5', dest,
  ], { timeoutMs: 60_000 });
}

export async function startScene(p: Production, scene: ProductionScene, deps: EngineDeps, voices: Record<string, KolVoice>): Promise<StartResult> {
  const problem = sceneProblem(scene, deps, voices);
  if (problem) throw new Error(problem);
  const now = new Date().toISOString();
  const motion = scene.visual.trim();

  switch (scene.engine) {
    case 'heygen': {
      const kolId = scene.kolId!;
      const assetId = sourceFor(scene, deps, voices);
      const image = deps.kol.imageFile(kolId, assetId);
      const voice = voices[kolId]!;
      const uploaded = await deps.heygen.uploadImage(image.abs);
      const aspect = p.aspect === '4:5' ? '4:5' : p.aspect;
      const videoId = await deps.heygen.createImageVideo({
        assetId: uploaded, script: scene.text.trim(), voiceId: voice.voiceId, aspect,
        title: `${p.title} · cảnh ${p.scenes.indexOf(scene) + 1}`,
        motionPrompt: [
          'Natural, confident presenter speaking to camera: subtle head movement, keeps eye contact with the lens, occasional relaxed hand gestures at chest height.',
          motion,
        ].filter(Boolean).join(' '),
        // The take number makes an approved retake a new request instead of returning the last video.
        idempotencyKey: `vs-${scene.id}-${scene.take ?? 0}-${hash(`${scene.text}|${voice.voiceId}|${assetId}|${aspect}`)}`,
      });
      return { job: { provider: 'heygen', ref: videoId, startedAt: now } };
    }
    case 'veo':
    case 'fal': {
      if (!scene.kolId && scene.engine === 'veo') {
        const prompt = scrubRealNames(motion || scene.text, p, deps);
        const handle = await deps.kol.submitBroll({ prompt, aspect: veoAspect(p.aspect), durationSec: Math.min(VEO_MAX_SEC, scene.durationSec), key: `vs-${scene.id}-${scene.take ?? 0}-${hash(prompt)}` });
        return { job: { provider: 'veo-broll', ref: handle, startedAt: now } };
      }
      const talking = scene.kind === 'talking';
      const genId = deps.kol.requestVideo({
        kolId: scene.kolId!,
        sourceAssetId: sourceFor(scene, deps, voices),
        model: scene.model || (scene.engine === 'veo' ? VEO_MODEL : FAL_VIDEO_MODEL),
        aspect: veoAspect(p.aspect),
        durationSec: Math.min(scene.engine === 'veo' ? VEO_MAX_SEC : 15, scene.durationSec),
        prompt: scene.engine === 'veo' ? scrubRealNames(motion, p, deps) : motion,
        ...(talking ? { script: scene.text.trim() } : {}),
        audio: talking,
      });
      return { job: { provider: 'kol', ref: genId, startedAt: now } };
    }
    case 'rocketflow': {
      // Google Flow "Ingredients to Video" (Veo 3.1): up to 3 images of the KOL keep the character consistent.
      const refs: string[] = [];
      if (scene.kolId) {
        const m = deps.kol.member(scene.kolId, voices);
        const ids = [sourceFor(scene, deps, voices), ...(m?.images ?? []).map((i) => i.id)];
        for (const id of [...new Set(ids)].slice(0, 3)) {
          try { refs.push(deps.kol.imageFile(scene.kolId, id).abs); } catch { /* skip a missing file */ }
        }
      }
      const name = scene.kolId ? deps.kol.persona(scene.kolId)?.name : null;
      const prompt = scene.kind === 'talking'
        ? [
          `${refs.length ? 'The person from the reference images' : 'The presenter'}${name ? ` (${name})` : ''} speaks directly to camera in Vietnamese, natural lip sync, natural blinking and head movement.`,
          motion ? `Setting and action: ${motion}.` : '',
          `Dialogue (Vietnamese, spoken exactly): "${scene.text.trim()}"`,
          'Keep the face, hair and outfit identical to the reference images. No subtitles, no on-screen text.',
        ].filter(Boolean).join(' ')
        : [refs.length ? 'Keep the character identical to the reference images.' : '', motion].filter(Boolean).join(' ');
      const job = await deps.rocket!.submit({
        // A new request id per take: an approved retake is a new Flow job.
        requestId: randomUUID(),
        title: `${p.title} · cảnh ${p.scenes.indexOf(scene) + 1}`.slice(0, 120),
        kind: 'video',
        prompts: [scrubRealNames(prompt, p, deps)],
        aspect_ratio: p.aspect === '16:9' ? '16:9' : p.aspect === '1:1' ? '1:1' : '9:16',
        duration: `${Math.min(VEO_MAX_SEC, Math.round(scene.durationSec))}s`,
        ...(refs.length ? { reference_images: refs } : {}),
      }, { project: p.id });
      if (job.state === 'unknown') throw new Error('RocketFlow không xác nhận đã nhận việc. Kiểm tra hàng đợi trong tiện ích, không gửi lại.');
      return { job: { provider: 'rocketflow', ref: job.id, startedAt: now } };
    }
    case 'stock': {
      const stock = deps.stock ?? pexelsStock;
      const hit = await stock.find(motion, p.aspect, scene.durationSec, Math.max(0, (scene.take ?? 1) - 1));
      if (!hit) throw new Error('Không tìm thấy video stock phù hợp. Thử mô tả khác (tiếng Anh, cụ thể hơn).');
      const dest = deps.store.sceneFile(p.id, scene.id, 'mp4');
      await stock.download(hit.link, dest);
      return { output: await finishFile(p, scene, deps, dest, null, `Video: ${hit.by} · Pexels (${hit.pageUrl})`, scene.durationSec) };
    }
    case 'clip': {
      const v = deps.kol.videoFile(scene.clipAssetId!);
      const dest = deps.store.sceneFile(p.id, scene.id, 'mp4');
      fs.copyFileSync(v.abs, dest);
      return { output: await finishFile(p, scene, deps, dest, null, undefined, scene.durationSec) };
    }
  }
}

export async function pollScene(p: Production, scene: ProductionScene, deps: EngineDeps): Promise<PollResult> {
  const job = scene.job;
  if (!job) return { error: 'Cảnh không có việc đang chạy.' };
  const dest = deps.store.sceneFile(p.id, scene.id, 'mp4');

  if (job.provider === 'heygen') {
    const s = await deps.heygen.getVideo(job.ref);
    if (s.status === 'failed') return { error: s.error ?? 'HeyGen báo lỗi.' };
    if (s.status !== 'completed' || !s.videoUrl) return 'pending';
    await deps.heygen.download(s.videoUrl, dest);
    let srt: string | null = null;
    if (s.subtitleUrl) {
      const f = deps.store.sceneFile(p.id, scene.id, 'srt');
      try { await deps.heygen.download(s.subtitleUrl, f); srt = f; } catch { /* captions come from the script */ }
    }
    return { output: await finishFile(p, scene, deps, dest, srt) };
  }

  if (job.provider === 'kol') {
    const g = deps.kol.generation(job.ref);
    if (!g) return { error: 'Không tìm thấy việc tạo video trong KOL Studio.' };
    if (g.status === 'failed') return { error: g.error || 'KOL Studio báo lỗi khi tạo video.' };
    if (g.status !== 'done' || !g.assetId) return 'pending';
    fs.copyFileSync(deps.kol.videoFile(g.assetId).abs, dest);
    return { output: await finishFile(p, scene, deps, dest, null) };
  }

  if (job.provider === 'veo-broll') {
    const r = await deps.kol.pollBroll(job.ref, dest);
    if (r === 'pending') return 'pending';
    if ('error' in r) return { error: r.error };
    return { output: await finishFile(p, scene, deps, dest, null) };
  }

  if (job.provider === 'rocketflow') {
    const folder = path.join(deps.rocketDownloadRoot, `studio-${job.ref}`);
    let found: string | null = null;
    try { found = fs.readdirSync(folder).filter((n) => /\.(mp4|mov|webm)$/i.test(n)).map((n) => path.join(folder, n))[0] ?? null; } catch { /* not yet */ }
    if (found) {
      // Wait for the browser to finish writing: size must be stable across two polls.
      const size = fs.statSync(found).size;
      const marker = `${dest}.size`;
      const prev = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : -1;
      fs.writeFileSync(marker, String(size));
      if (size > 0 && size === prev) {
        fs.copyFileSync(found, dest);
        fs.rmSync(marker, { force: true });
        return { output: await finishFile(p, scene, deps, dest, null) };
      }
      return 'pending';
    }
    if (Date.now() - Date.parse(job.startedAt) > ROCKET_TIMEOUT_MS) return { error: 'RocketFlow chưa trả file sau 30 phút. Kiểm tra hàng đợi trong tiện ích (không gửi lại tự động).' };
    return 'pending';
  }

  return { error: `Không biết cách theo dõi việc ${job.provider}.` };
}
