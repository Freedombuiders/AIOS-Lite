/** Finds the command-line tools Video Studio needs, also when the app was started without Homebrew on PATH. */
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

export class MissingToolError extends Error {
  constructor(readonly tool: string, hint: string) { super(hint); this.name = 'MissingToolError'; }
}

const HINTS: Record<string, string> = {
  ffmpeg: FFMPEG_HINT,
  ffprobe: FFMPEG_HINT,
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
