// Finding the command-line media tools (ffmpeg, ffprobe, yt-dlp, whisper-cli, npx), also when the app was started
// without Homebrew on PATH. Shared by Video Studio (its doctor and pipeline) and Dream 100 (reference videos).
// Moved here from modules/video/server/bin.ts, which now re-exports it, so neither module depends on the other.
import fs from 'node:fs';
import path from 'node:path';

const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin'];
const cache = new Map<string, string | null>();

const isExecutable = (file: string): boolean => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
};

export const searchDirs = (): string[] => [...new Set([...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...EXTRA_DIRS])];

/** PATH for child processes: Homebrew first, so `npx` and `hyperframes` find node and ffmpeg. */
export const childPath = (): string => [...new Set([...EXTRA_DIRS.slice(0, 2), ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)])].join(path.delimiter);

/** Absolute path of a tool, or null when it is not installed. Cached; call resetBinCache() after installing. */
export function findBin(name: string): string | null {
  if (path.isAbsolute(name)) return isExecutable(name) ? name : null;
  if (cache.has(name)) return cache.get(name) ?? null;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const hit = searchDirs().map((d) => path.join(d, exe)).find(isExecutable) ?? null;
  cache.set(name, hit);
  return hit;
}

export const resetBinCache = (): void => cache.clear();

export const FFMPEG_HINT = 'Chưa cài ffmpeg. Mở Terminal và chạy: brew install ffmpeg (ffmpeg và ffprobe thường nằm ở /opt/homebrew/bin), rồi tải lại trang. Hoặc đặt VIDEO_EDIT_FFMPEG và VIDEO_EDIT_FFPROBE tới đường dẫn đầy đủ.';
export const YTDLP_HINT = 'Chưa cài yt-dlp. Mở Terminal và chạy: brew install yt-dlp (hoặc pipx install yt-dlp), rồi thử lại.';

export class MissingToolError extends Error {
  constructor(readonly tool: string, hint: string) { super(hint); this.name = 'MissingToolError'; }
}

const HINTS: Record<string, string> = {
  ffmpeg: FFMPEG_HINT,
  ffprobe: FFMPEG_HINT,
  'yt-dlp': YTDLP_HINT,
  'whisper-cli': 'Chưa cài whisper-cli (chép lời). Chạy: brew install whisper-cpp, rồi tải model ggml-large-v3-turbo-q5_0.bin vào ~/.cache/whisper-cpp.',
  npx: 'Chưa thấy Node.js (npx). Cài Node.js 22 rồi thử lại.',
};

export const missingToolHint = (tool: string): string => HINTS[tool] ?? `Chưa cài ${tool}.`;

/** Resolve or throw a Vietnamese error that says how to install the tool. */
export function requireBin(name: string): string {
  const bin = findBin(name);
  if (!bin) throw new MissingToolError(name, missingToolHint(name));
  return bin;
}

/** ffmpeg to run: VIDEO_EDIT_FFMPEG, else the one found on PATH/Homebrew, else the bare name. */
export const ffmpegBin = (): string => process.env.VIDEO_EDIT_FFMPEG?.trim() || findBin('ffmpeg') || 'ffmpeg';
/** ffprobe to run: VIDEO_EDIT_FFPROBE, else the one found on PATH/Homebrew, else the bare name. */
export const ffprobeBin = (): string => process.env.VIDEO_EDIT_FFPROBE?.trim() || findBin('ffprobe') || 'ffprobe';

export type MediaTool = 'yt-dlp' | 'ffmpeg' | 'ffprobe';

export interface MediaToolStatus {
  tool: MediaTool;
  /** absolute path, or null when not found */
  path: string | null;
  /** Vietnamese install command/hint when missing */
  fix?: string;
}

/** Install command shown to the owner for each tool. */
export const INSTALL_COMMAND: Record<MediaTool, string> = {
  'yt-dlp': 'brew install yt-dlp',
  ffmpeg: 'brew install ffmpeg',
  ffprobe: 'brew install ffmpeg',
};

/** Path of one media tool, honouring VIDEO_EDIT_FFMPEG / VIDEO_EDIT_FFPROBE; null when it is not installed. */
export function locateMediaTool(tool: MediaTool): string | null {
  const env = tool === 'ffmpeg' ? process.env.VIDEO_EDIT_FFMPEG?.trim() : tool === 'ffprobe' ? process.env.VIDEO_EDIT_FFPROBE?.trim() : undefined;
  return findBin(env || tool);
}

/** Which of the tools are installed, and how to install the missing ones. Does not run anything. */
export function mediaTools(tools: MediaTool[] = ['yt-dlp', 'ffmpeg', 'ffprobe']): MediaToolStatus[] {
  return tools.map((tool) => {
    const p = locateMediaTool(tool);
    return p ? { tool, path: p } : { tool, path: null, fix: INSTALL_COMMAND[tool] };
  });
}
