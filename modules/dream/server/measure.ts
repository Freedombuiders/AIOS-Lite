// Measuring one reference video, the steps of the video-learn skill done in code. Each step takes the work dir
// (data/modules/dream/tmp/<id>/) and returns plain numbers; the caller deletes the dir afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { DOWNLOAD_TIMEOUT_MS, execTool, FFMPEG_TIMEOUT_MS } from './run.js';

export interface ToolPaths {
  ytdlp: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
  /** only tests shorten these; the app uses 5 min for the download and 2 min per ffmpeg/ffprobe call */
  timeouts?: { downloadMs?: number; ffmpegMs?: number };
}

const dlTimeout = (t: ToolPaths) => t.timeouts?.downloadMs ?? DOWNLOAD_TIMEOUT_MS;
const ffTimeout = (t: ToolPaths) => t.timeouts?.ffmpegMs ?? FFMPEG_TIMEOUT_MS;

/** A step failed for a reason the owner should read (Vietnamese). */
export class MeasureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeasureError';
  }
}

export const MAX_FILESIZE = '200M';
export const SCENE_THRESHOLD = 0.3;
const SUB_LANGS = 'vi.*,en';
export const MAX_SUBTITLE_CHARS = 3000;

/** yt-dlp arguments. The link is the last argument, after `--`, so even a link starting with "-" is not an option. */
export function ytdlpArgs(url: string, dir: string): string[] {
  return [
    '--ignore-config',
    '--no-playlist',
    // a subtitle that fails (YouTube often answers 429 for them) must not abort the video itself
    '--ignore-errors',
    '--max-filesize', MAX_FILESIZE,
    '-f', 'bv*[height<=720]+ba/b[height<=720]',
    '--write-info-json',
    '--write-auto-subs',
    '--sub-langs', SUB_LANGS,
    '--sub-format', 'vtt/best',
    '--no-progress',
    '--no-cache-dir',
    '-o', path.join(dir, 'video.%(ext)s'),
    '--',
    url,
  ];
}

/** Why yt-dlp could not give us the video, in Vietnamese. No workaround is tried for any of these. */
export function downloadReason(output: string): string {
  const t = output.toLowerCase();
  if (/max-filesize|larger than max|file is larger/.test(t)) return 'Video lớn hơn 200 MB nên không tải. Không thử cách khác.';
  if (/private video|video is private|this video is private|is private/.test(t)) return 'Video riêng tư, không tải được. Không thử cách khác.';
  if (/sign in|log in|login|logged-in|cookies|members[- ]only|age[- ]restricted|confirm your age|requires authentication/.test(t)) {
    return 'Video cần đăng nhập mới xem được. Chỉ phân tích video công khai, không dùng tài khoản.';
  }
  if (/unsupported url/.test(t)) return 'yt-dlp không hỗ trợ trang này.';
  if (/not available|unavailable|removed|http error 404|does not exist/.test(t)) return 'Video không còn hoặc không xem công khai được.';
  const last = output.trim().split('\n').filter((l) => /error/i.test(l)).pop() ?? output.trim().split('\n').pop() ?? '';
  return `yt-dlp không tải được video${last ? `: ${last.replace(/\s+/g, ' ').slice(0, 160)}` : '.'}`;
}

export interface Downloaded {
  video: string;
  info: Record<string, unknown> | null;
  subtitles: string | null;
}

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.flv', '.3gp']);

/** Step 1: download into `dir` (≤ 720p, ≤ 200 MB, info json, auto subtitles vi/en). */
export async function download(tools: ToolPaths, url: string, dir: string, signal?: AbortSignal): Promise<Downloaded> {
  if (!tools.ytdlp) throw new MeasureError('Máy chưa cài yt-dlp nên chưa mổ xẻ được video. Cài bằng: brew install yt-dlp');
  const r = await execTool(tools.ytdlp, ytdlpArgs(url, dir), { timeoutMs: dlTimeout(tools), cwd: dir, signal, label: 'yt-dlp' });
  const out = `${r.stderr}\n${r.stdout}`;
  const files = fs.readdirSync(dir);
  const video = files.find((f) => f.startsWith('video.') && VIDEO_EXT.has(path.extname(f).toLowerCase()) && !f.endsWith('.part'));
  // the video file decides: with --ignore-errors a failed subtitle gives a non-zero exit but a usable video
  if (!video) throw new MeasureError(downloadReason(out));
  let info: Record<string, unknown> | null = null;
  const infoFile = files.find((f) => f.endsWith('.info.json'));
  if (infoFile) {
    try { info = JSON.parse(fs.readFileSync(path.join(dir, infoFile), 'utf8')) as Record<string, unknown>; } catch { info = null; }
  }
  return { video: path.join(dir, video), info, subtitles: readSubtitles(dir, files) };
}

/** Vietnamese subtitles first, else English; plain text, cues de-duplicated, at most MAX_SUBTITLE_CHARS. */
export function readSubtitles(dir: string, files: string[] = fs.readdirSync(dir)): string | null {
  const subs = files.filter((f) => /\.(vtt|srt)$/i.test(f));
  const pick = subs.find((f) => /\.vi[.-]/i.test(f)) ?? subs.find((f) => /\.en[.-]/i.test(f)) ?? subs[0];
  if (!pick) return null;
  let raw: string;
  try { raw = fs.readFileSync(path.join(dir, pick), 'utf8'); } catch { return null; }
  const text = subtitleText(raw);
  return text ? text.slice(0, MAX_SUBTITLE_CHARS) : null;
}

/** WebVTT/SRT to plain lines: no header, timings, cue numbers or tags; auto-sub rolling repeats removed. */
export function subtitleText(raw: string): string {
  const out: string[] = [];
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const l = line.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!l || /^WEBVTT/i.test(l) || /^(Kind|Language|NOTE|STYLE)\b/.test(l) || /-->/.test(l) || /^\d+$/.test(l)) continue;
    if (out[out.length - 1] === l) continue;
    out.push(l);
  }
  return out.join('\n');
}

/** Step 2: length in seconds (ffprobe). */
export async function probeDuration(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<number> {
  if (!tools.ffprobe) throw new MeasureError('Máy chưa cài ffprobe (đi kèm ffmpeg). Cài bằng: brew install ffmpeg');
  const r = await execTool(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: ffTimeout(tools), signal, label: 'ffprobe' });
  const n = Number(r.stdout.trim().split('\n')[0]);
  if (r.code !== 0 || !Number.isFinite(n) || n <= 0) throw new MeasureError('ffprobe không đọc được độ dài video.');
  return n;
}

/** Step 3: scene-change times in seconds (ffmpeg select scene > 0.3 + showinfo). Approximate by nature. */
export async function sceneTimes(tools: ToolPaths, file: string, signal?: AbortSignal): Promise<number[]> {
  if (!tools.ffmpeg) throw new MeasureError('Máy chưa cài ffmpeg. Cài bằng: brew install ffmpeg');
  const r = await execTool(
    tools.ffmpeg,
    ['-hide_banner', '-nostdin', '-i', file, '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, '-an', '-f', 'null', '-'],
    { timeoutMs: ffTimeout(tools), signal, label: 'ffmpeg' },
  );
  if (r.code !== 0) throw new MeasureError(`ffmpeg lỗi khi đo đổi cảnh (mã ${r.code}).`);
  return [...r.stderr.matchAll(/pts_time:\s*([0-9.]+)/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

/** Step 4: four frames from the first 3 seconds, 540 wide. Returns their paths. */
export async function hookFrames(tools: ToolPaths, file: string, dir: string, signal?: AbortSignal): Promise<string[]> {
  if (!tools.ffmpeg) throw new MeasureError('Máy chưa cài ffmpeg. Cài bằng: brew install ffmpeg');
  const r = await execTool(
    tools.ffmpeg,
    ['-hide_banner', '-nostdin', '-y', '-i', file, '-t', '3', '-vf', 'fps=4/3,scale=540:-2', '-frames:v', '4', path.join(dir, 'hook%02d.jpg')],
    { timeoutMs: ffTimeout(tools), signal, label: 'ffmpeg' },
  );
  if (r.code !== 0) throw new MeasureError(`ffmpeg lỗi khi trích khung hình (mã ${r.code}).`);
  return fs.readdirSync(dir).filter((f) => /^hook\d+\.jpg$/.test(f)).sort().map((f) => path.join(dir, f));
}

export interface CutStats {
  cuts: number;
  cutsPerMin: number;
  cutsFirst3s: number;
  longestSceneS: number;
}

/** Pure: cut numbers from scene-change times and the length. */
export function cutStats(times: number[], durationS: number): CutStats {
  const inside = times.filter((t) => t > 0 && t < durationS);
  const bounds = [0, ...inside, durationS];
  let longest = 0;
  for (let i = 1; i < bounds.length; i++) longest = Math.max(longest, bounds[i] - bounds[i - 1]);
  return {
    cuts: inside.length,
    cutsPerMin: durationS > 0 ? Math.round((inside.length / (durationS / 60)) * 10) / 10 : 0,
    cutsFirst3s: inside.filter((t) => t < 3).length,
    longestSceneS: Math.round(longest * 10) / 10,
  };
}

export interface PublicInfo {
  platform: string | null;
  nativeId: string | null;
  title: string | null;
  uploader: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  durationS: number | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);

/** Public numbers from yt-dlp's info json. Title and uploader are network data: kept short, one line. */
export function publicInfo(info: Record<string, unknown> | null): PublicInfo {
  const i = info ?? {};
  return {
    platform: text(i.extractor_key ?? i.extractor, 40)?.toLowerCase() ?? null,
    nativeId: text(i.id, 80),
    title: text(i.title, 160),
    uploader: text(i.channel ?? i.uploader, 80),
    views: num(i.view_count),
    likes: num(i.like_count),
    comments: num(i.comment_count),
    durationS: num(i.duration),
  };
}
