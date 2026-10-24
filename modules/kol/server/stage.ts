/**
 * Staging: copies (and converts where a platform needs it) a post's media into
 * FB_MEDIA_DIR/kol/<targetId>/ — the only directory the Composio SDK may
 * upload from. One folder per target, mode 0700, removed after a final
 * outcome (published, failed, missed).
 *
 * Instagram images become JPEG, center-cropped into the 4:5…1.91:1 aspect
 * range and at most 1440 px wide. Videos pass through when they are already
 * MP4/H.264, otherwise they are transcoded.
 */

import fs from 'fs';
import path from 'path';

import { FB_MEDIA_DIR } from '../../_lib/composio.js';
import { ffmpegBin, ffprobeBin, runChecked } from './ffmpeg-tools.js';
import { getAssetFile } from './assets.js';
import { KolError } from './core.js';
import type { Platform } from './types.js';

export interface StagedMedia {
  /** Absolute path inside the staging folder. */
  path: string;
  kind: 'image' | 'video';
  mime: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

// ── Instagram crop math (pure) ───────────────────────────────────────

export const IG_MIN_RATIO = 0.8; // 4:5 portrait
export const IG_MAX_RATIO = 1.91; // 1.91:1 landscape
export const IG_MAX_WIDTH = 1440;

export interface ImagePlan {
  /** Center crop applied first; null when the aspect already fits. */
  crop: { x: number; y: number; w: number; h: number } | null;
  outWidth: number;
  outHeight: number;
}

/**
 * Center crop that brings width/height into [minRatio, maxRatio], then a
 * downscale to at most maxWidth. The output ratio is guaranteed in range
 * after rounding.
 */
export function planInstagramImage(width: number, height: number, maxWidth = IG_MAX_WIDTH, minRatio = IG_MIN_RATIO, maxRatio = IG_MAX_RATIO): ImagePlan {
  if (!(width > 0) || !(height > 0)) throw new Error('invalid image size');
  let w = Math.round(width);
  let h = Math.round(height);
  let crop: ImagePlan['crop'] = null;
  if (w / h < minRatio) {
    const nh = Math.floor(w / minRatio);
    crop = { x: 0, y: Math.floor((h - nh) / 2), w, h: nh };
    h = nh;
  } else if (w / h > maxRatio) {
    const nw = Math.floor(h * maxRatio);
    crop = { x: Math.floor((w - nw) / 2), y: 0, w: nw, h };
    w = nw;
  }
  const outWidth = Math.min(w, maxWidth);
  let outHeight = Math.max(1, Math.round((h * outWidth) / w));
  if (outWidth / outHeight < minRatio) outHeight = Math.floor(outWidth / minRatio);
  if (outWidth / outHeight > maxRatio) outHeight = Math.ceil(outWidth / maxRatio);
  return { crop, outWidth, outHeight };
}

/** ffmpeg video filter for a plan ("crop=…,scale=…" or just "scale=…"). */
export function planFilter(plan: ImagePlan): string {
  const parts: string[] = [];
  if (plan.crop) parts.push(`crop=${plan.crop.w}:${plan.crop.h}:${plan.crop.x}:${plan.crop.y}`);
  parts.push(`scale=${plan.outWidth}:${plan.outHeight}`);
  return parts.join(',');
}

// ── Tools (injectable) ───────────────────────────────────────────────

export interface ProbeInfo {
  codec: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

export interface StageTools {
  ffmpeg(args: string[]): Promise<void>;
  probe(file: string): Promise<ProbeInfo | null>;
}

const defaultTools: StageTools = {
  async ffmpeg(args) {
    await runChecked(ffmpegBin(), ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { timeoutMs: 15 * 60_000 });
  },
  async probe(file) {
    try {
      const res = await runChecked(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 30_000 });
      const json = JSON.parse(res.stdout) as { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]; format?: { duration?: string } };
      const v = (json.streams ?? []).find((s) => s.codec_type === 'video');
      const d = Number(json.format?.duration);
      return { codec: v?.codec_name ?? null, width: v?.width ?? null, height: v?.height ?? null, durationSec: Number.isFinite(d) ? d : null };
    } catch {
      return null;
    }
  },
};

let tools: StageTools = defaultTools;
let rootOverride: string | null = null;

/** Test hook: replace (or restore with null) ffmpeg/ffprobe. */
export function _setStageTools(t: StageTools | null): void {
  tools = t ?? defaultTools;
}

/** Test hook: stage somewhere else than FB_MEDIA_DIR/kol. */
export function _setStageRoot(dir: string | null): void {
  rootOverride = dir;
}

export function stageRoot(): string {
  return rootOverride ?? path.join(FB_MEDIA_DIR, 'kol');
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function stageDir(targetId: string): string {
  if (!SAFE_ID.test(targetId)) throw new KolError(400, 'Mã kênh đăng không hợp lệ.');
  return path.join(stageRoot(), targetId);
}

// ── Staging ──────────────────────────────────────────────────────────

const COPYABLE_IMAGE = new Set(['image/jpeg', 'image/png']);

async function stageImage(src: { abs: string; mime: string; width: number | null; height: number | null }, platform: Platform, dest: string): Promise<StagedMedia> {
  let width = src.width;
  let height = src.height;
  if (platform === 'instagram') {
    if (!width || !height) {
      const p = await tools.probe(src.abs);
      width = p?.width ?? null;
      height = p?.height ?? null;
    }
    if (!width || !height) throw new KolError(400, 'Không đọc được kích thước ảnh để chuẩn bị cho Instagram.');
    const plan = planInstagramImage(width, height);
    const out = `${dest}.jpg`;
    if (!plan.crop && plan.outWidth === width && src.mime === 'image/jpeg') {
      fs.copyFileSync(src.abs, out);
    } else {
      await tools.ffmpeg(['-i', src.abs, '-vf', planFilter(plan), '-frames:v', '1', '-q:v', '2', out]);
    }
    return { path: out, kind: 'image', mime: 'image/jpeg', width: plan.outWidth, height: plan.outHeight, durationSec: null };
  }
  if (COPYABLE_IMAGE.has(src.mime)) {
    const out = `${dest}${src.mime === 'image/png' ? '.png' : '.jpg'}`;
    fs.copyFileSync(src.abs, out);
    return { path: out, kind: 'image', mime: src.mime, width, height, durationSec: null };
  }
  const out = `${dest}.jpg`;
  await tools.ffmpeg(['-i', src.abs, '-frames:v', '1', '-q:v', '2', out]);
  return { path: out, kind: 'image', mime: 'image/jpeg', width, height, durationSec: null };
}

async function stageVideo(src: { abs: string; mime: string; width: number | null; height: number | null; durationSec: number | null }, dest: string): Promise<StagedMedia> {
  const out = `${dest}.mp4`;
  const info = await tools.probe(src.abs);
  const isMp4 = src.mime === 'video/mp4';
  const h264 = info ? info.codec === 'h264' : isMp4;
  if (isMp4 && h264) {
    fs.copyFileSync(src.abs, out);
  } else {
    await tools.ffmpeg([
      '-i', src.abs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out,
    ]);
  }
  return {
    path: out,
    kind: 'video',
    mime: 'video/mp4',
    width: src.width ?? info?.width ?? null,
    height: src.height ?? info?.height ?? null,
    durationSec: src.durationSec ?? info?.durationSec ?? null,
  };
}

/**
 * Copies/converts the post's assets for one target into its staging folder
 * (recreated from scratch). Order is kept. Throws KolError on a missing file.
 */
export async function stageMedia(targetId: string, platform: Platform, assetIds: string[]): Promise<StagedMedia[]> {
  const dir = stageDir(targetId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out: StagedMedia[] = [];
  try {
    for (const [i, id] of assetIds.entries()) {
      const file = getAssetFile(id);
      if (!file) throw new KolError(400, 'Không tìm thấy tệp ảnh/video của bài.');
      if (!fs.existsSync(file.abs)) throw new KolError(400, 'Tệp ảnh/video của bài đã bị xóa khỏi ổ đĩa.');
      const dest = path.join(dir, String(i + 1).padStart(2, '0'));
      if (file.kind === 'image') out.push(await stageImage(file, platform, dest));
      else if (file.kind === 'video') out.push(await stageVideo(file, dest));
      else throw new KolError(400, 'Không đăng được tệp âm thanh riêng.');
    }
  } catch (err) {
    cleanupStage(targetId);
    if (err instanceof KolError) throw err;
    throw new KolError(500, `Không chuẩn bị được tệp để đăng: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
  return out;
}

/** Removes a target's staging folder (best effort, never outside the staging root). */
export function cleanupStage(targetId: string): void {
  if (!SAFE_ID.test(targetId)) return;
  try {
    fs.rmSync(path.join(stageRoot(), targetId), { recursive: true, force: true });
  } catch {
    // Leaving files behind is harmless.
  }
}
