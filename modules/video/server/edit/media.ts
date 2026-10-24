import { findBin, childPath, missingToolHint, MissingToolError } from '../bin.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaInfo } from './types.js';

function run(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(findBin(cmd) ?? cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: childPath() } }, (err, stdout) => {
      if (!err) return resolve(stdout);
      reject((err as NodeJS.ErrnoException).code === 'ENOENT' ? new MissingToolError(cmd, missingToolHint(cmd)) : err);
    });
  });
}

function parseFps(rate: unknown): number {
  if (typeof rate !== 'string') return 0;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d) return 0;
  return Math.round((n / d) * 100) / 100;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 30_000);
  const json = JSON.parse(out) as { streams?: ProbeStream[]; format?: { duration?: string } };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('Tệp không có hình ảnh');
  const audio = streams.find((s) => s.codec_type === 'audio');

  const rawRotation = video.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation ?? Number(video.tags?.rotate);
  const rotation = Number.isFinite(rawRotation) ? ((Math.round(rawRotation as number) % 360) + 360) % 360 : 0;
  const durationSec = Number(json.format?.duration ?? video.duration);

  return {
    fileName: path.basename(file),
    sizeBytes: fs.statSync(file).size,
    durationSec: Number.isFinite(durationSec) ? Math.round(durationSec * 100) / 100 : 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFps(video.r_frame_rate) || parseFps(video.avg_frame_rate),
    videoCodec: video.codec_name ?? 'unknown',
    ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
    hasAudio: Boolean(audio),
    ...(rotation ? { rotation } : {}),
  };
}

export async function makeThumbnail(src: string, dest: string, durationSec: number): Promise<void> {
  const at = Math.max(0, Math.min(1, durationSec / 2));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-y', dest], 60_000);
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "0:38 · 1920×1080 · 30fps · 12 MB" — the ticket's one-line summary of a source video. */
export function ingestSummary(info: MediaInfo): string {
  const s = Math.round(info.durationSec);
  const swap = info.rotation === 90 || info.rotation === 270;
  const [w, h] = swap ? [info.height, info.width] : [info.width, info.height];
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · ${w}×${h} · ${Math.round(info.fps)}fps · ${formatSize(info.sizeBytes)}`;
}
