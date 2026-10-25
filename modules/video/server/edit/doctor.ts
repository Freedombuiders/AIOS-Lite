import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIntegrationValues } from '../integration-values.js';
import { STORE_DIR } from '../paths.js';
import type { DoctorCheck } from './types.js';
import { defaultAgentProvider } from './turn.js';
import { childPath, findBin, FFMPEG_HINT, missingToolHint } from '../bin.js';
import { hasTonemapFilters } from './pipeline/normalize.js';
import { ffmpegBin, ffprobeBin, hyperframesVersion } from './pipeline/tools.js';

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: number;
  total: number;
  requiredOk: boolean;
}

/** What the checks read from the machine; tests replace parts of it. */
export interface DoctorDeps {
  /** stdout of a tool; rejects when the tool is missing or fails. */
  run: (cmd: string, args: string[]) => Promise<string>;
  /** The Pexels API key saved in Kết nối › Integrations › Pexels, or null. */
  pexelsKey: () => string | null;
  /** hyperframes versions in the npx cache (~/.npm/_npx), newest first. */
  cachedHyperframes: () => string[];
  /** Path of npx, or null. */
  npx: () => string | null;
}

const CACHE_MS = 30_000;
const MIN_FREE_BYTES = 5 * 1024 ** 3;
let cache: { at: number; key: string; result: DoctorResult } | null = null;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(findBin(cmd) ?? cmd, args, { timeout: 5000, env: { ...process.env, PATH: childPath() }, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try { return await fn(); } catch { return null; }
};

function findWhisperModel(): { file: string; size: number } | null {
  const env = process.env.VIDEO_EDIT_WHISPER_MODEL;
  const candidates: string[] = [];
  if (env) candidates.push(env);
  else {
    for (const dir of [path.join(os.homedir(), '.cache', 'whisper-cpp'), '/opt/homebrew/share/whisper-cpp']) {
      try {
        for (const n of fs.readdirSync(dir).sort()) {
          if (/^ggml-.*\.bin$/.test(n) && !n.startsWith('for-tests')) candidates.push(path.join(dir, n));
        }
      } catch { /* dir missing */ }
    }
  }
  for (const file of candidates) {
    try { return { file, size: fs.statSync(file).size }; } catch { /* next */ }
  }
  return null;
}

function cachedHyperframes(): string[] {
  const npx = path.join(os.homedir(), '.npm', '_npx');
  const found: { v: string; mtime: number }[] = [];
  try {
    for (const dir of fs.readdirSync(npx)) {
      const pkg = path.join(npx, dir, 'node_modules', 'hyperframes', 'package.json');
      try {
        const mtime = fs.statSync(pkg).mtimeMs;
        const v = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: string }).version;
        if (v) found.push({ v, mtime });
      } catch { /* not this one */ }
    }
  } catch { /* no npx cache */ }
  return [...new Set(found.sort((a, b) => b.mtime - a.mtime).map((f) => f.v))];
}

/** Same lookup as the Asset Hub (assets/hub.ts): the key the owner saved in Integrations › Pexels. */
function pexelsKey(): string | null {
  try { return loadIntegrationValues('pexels')?.api_key?.trim() || null; } catch { return null; }
}

const DEFAULT_DEPS: DoctorDeps = { run, pexelsKey, cachedHyperframes, npx: () => findBin('npx') };

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** Every check, uncached. runDoctor caches it; tests call it with fake deps. */
export async function computeDoctor(root: string, deps: Partial<DoctorDeps> = {}): Promise<DoctorResult> {
  const { run, pexelsKey, cachedHyperframes, npx } = { ...DEFAULT_DEPS, ...deps };
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  const ffmpegVersion = await safe(() => run(ffmpegBin(), ['-version']));
  add({
    id: 'ffmpeg', label: 'ffmpeg', required: true, ok: Boolean(ffmpegVersion),
    detail: ffmpegVersion ? (/ffmpeg version (\S+)/.exec(ffmpegVersion)?.[1] ?? 'đã cài') : 'chưa cài',
    ...(ffmpegVersion ? {} : { fix: FFMPEG_HINT }),
  });

  const ffprobeVersion = await safe(() => run(ffprobeBin(), ['-version']));
  add({
    id: 'ffprobe', label: 'ffprobe', required: true, ok: Boolean(ffprobeVersion),
    detail: ffprobeVersion ? (/ffprobe version (\S+)/.exec(ffprobeVersion)?.[1] ?? 'đã cài') : 'chưa cài',
    ...(ffprobeVersion ? {} : { fix: FFMPEG_HINT }),
  });

  const filters = ffmpegVersion ? await safe(() => run(ffmpegBin(), ['-hide_banner', '-filters'])) : null;
  const hasAss = Boolean(filters && filters.includes(' ass '));
  add({
    id: 'ffmpeg-libass', label: 'ffmpeg có libass (đốt phụ đề)', required: true, ok: hasAss,
    detail: hasAss ? 'có bộ lọc ass' : 'ffmpeg thiếu libass',
    ...(hasAss ? {} : { fix: 'brew reinstall ffmpeg (bản có libass)' }),
  });

  const audioNeeds = ['silencedetect', 'sidechaincompress', 'loudnorm'];
  const missingAudio = audioNeeds.filter((f) => !filters || !filters.includes(` ${f} `));
  add({
    id: 'ffmpeg-audio', label: 'ffmpeg có bộ lọc âm thanh', required: true, ok: missingAudio.length === 0,
    detail: missingAudio.length === 0 ? audioNeeds.join(', ') : `thiếu ${missingAudio.join(', ')}`,
    ...(missingAudio.length === 0 ? {} : { fix: 'brew reinstall ffmpeg' }),
  });

  // HDR footage (iPhone HLG, PQ) is tone-mapped to SDR at ingest with zscale + tonemap, which need zimg.
  const zimg = Boolean(filters && hasTonemapFilters(filters));
  add({
    id: 'ffmpeg-zimg', label: 'ffmpeg có zimg (video HDR iPhone sang SDR)', required: false, ok: zimg,
    detail: zimg ? 'có zscale và tonemap' : 'ffmpeg thiếu zimg: video HDR giữ nguyên màu, có thể bị gắt',
    ...(zimg ? {} : { fix: 'Cài ffmpeg bản có zimg (brew install ffmpeg)' }),
  });

  const encoders = ffmpegVersion ? await safe(() => run(ffmpegBin(), ['-hide_banner', '-encoders'])) : null;
  const hasVt = Boolean(encoders && encoders.includes('h264_videotoolbox'));
  add({
    id: 'videotoolbox', label: 'VideoToolbox (xuất nhanh bằng GPU)', required: false, ok: hasVt,
    detail: hasVt ? 'h264_videotoolbox' : 'không có, sẽ dùng libx264 (chậm hơn)',
  });

  const whisperPath = findBin('whisper-cli');
  add({
    id: 'whisper-cli', label: 'whisper-cli (chép lời)', required: true, ok: Boolean(whisperPath),
    detail: whisperPath || 'chưa cài',
    ...(whisperPath ? {} : { fix: missingToolHint('whisper-cli') }),
  });

  const model = findWhisperModel();
  add({
    id: 'whisper-model', label: 'Model whisper tiếng Việt', required: true, ok: Boolean(model),
    detail: model ? `${path.basename(model.file)} · ${mb(model.size)}` : 'chưa có model ggml-*.bin',
    ...(model ? {} : { fix: 'Tải ggml-large-v3-turbo-q5_0.bin vào ~/.cache/whisper-cpp hoặc đặt VIDEO_EDIT_WHISPER_MODEL' }),
  });

  // Every export renders with `npx -y hyperframes@<pin>` (pipeline/render.ts): the pinned version must be cached
  // or npx downloads it on the first export (needs the network).
  const pin = hyperframesVersion();
  const installed = /\d+\.\d+\.\d+\S*/.exec((await safe(() => run('hyperframes', ['--version']))) ?? '')?.[0] ?? null;
  const cached = cachedHyperframes();
  const npxPath = npx();
  const hfReady = Boolean(npxPath) && (cached.includes(pin) || installed === pin);
  const other = installed ?? cached[0] ?? null;
  add({
    id: 'hyperframes', label: 'HyperFrames (dựng hiệu ứng và xuất video)', required: false, ok: hfReady,
    detail: !npxPath
      ? 'chưa có Node.js (npx): chưa xuất video được'
      : hfReady
        ? `phiên bản ${pin}`
        : `chưa tải bản ${pin}${other ? ` (máy có bản ${other})` : ''}: lần xuất đầu sẽ tự tải, cần mạng`,
    ...(hfReady ? {} : { fix: npxPath ? `Tải sẵn: npx -y hyperframes@${pin} --version` : missingToolHint('npx') }),
  });

  const chrome = fs.existsSync('/Applications/Google Chrome.app') || fs.existsSync(path.join(os.homedir(), '.cache', 'puppeteer'));
  add({
    id: 'chrome', label: 'Chrome (dựng hiệu ứng HyperFrames)', required: false, ok: chrome,
    detail: chrome ? 'có' : 'chưa thấy Chrome',
    ...(chrome ? {} : { fix: 'Cài Google Chrome' }),
  });

  // Dựng nhanh searches Pexels for B-roll slots; without a key it uses the owner's footage and library only.
  const pexels = Boolean(pexelsKey());
  add({
    id: 'pexels', label: 'Pexels (tìm cảnh trám cho Dựng nhanh)', required: false, ok: pexels,
    detail: pexels ? 'đã có API key' : 'chưa có API key: Dựng nhanh chỉ dùng tư liệu của bạn và Kho của tôi',
    ...(pexels ? {} : { fix: 'Lấy API key miễn phí ở pexels.com/api rồi dán vào Kết nối › Integrations › Pexels' }),
  });

  const ytdlp = await safe(() => run('yt-dlp', ['--version']));
  add({
    id: 'yt-dlp', label: 'yt-dlp (học từ kênh mẫu)', required: false, ok: Boolean(ytdlp),
    detail: ytdlp ? ytdlp.trim() : 'chưa cài',
    ...(ytdlp ? {} : { fix: 'brew install yt-dlp' }),
  });

  let freeBytes: number | null = null;
  for (const dir of [root, STORE_DIR, os.homedir()]) {
    try {
      const s = fs.statfsSync(dir);
      freeBytes = s.bavail * s.bsize;
      break;
    } catch { /* try the next path */ }
  }
  const diskOk = freeBytes !== null && freeBytes >= MIN_FREE_BYTES;
  add({
    id: 'disk', label: 'Dung lượng ổ đĩa', required: true, ok: diskOk,
    detail: freeBytes === null ? 'không đọc được' : `còn ${(freeBytes / 1024 ** 3).toFixed(1)} GB`,
    ...(diskOk ? {} : { fix: 'Giải phóng ít nhất 5 GB' }),
  });

  const engine = await safe(async () => defaultAgentProvider());
  add({
    id: 'engine', label: 'Agent dựng', required: true, ok: Boolean(engine),
    detail: engine ? `${engine.engineLabel} · ${engine.agentId}` : 'chưa có agent mặc định dùng được',
    ...(engine ? {} : { fix: 'Tạo agent hoặc đặt VIDEO_EDIT_AGENT' }),
  });

  return {
    checks,
    ok: checks.filter((c) => c.ok).length,
    total: checks.length,
    requiredOk: checks.every((c) => !c.required || c.ok),
  };
}

export async function runDoctor(root: string = path.join(STORE_DIR, 'video-edit')): Promise<DoctorResult> {
  const now = Date.now();
  if (cache && cache.key === root && now - cache.at < CACHE_MS) return cache.result;
  let result: DoctorResult;
  try {
    result = await computeDoctor(root);
  } catch {
    result = { checks: [], ok: 0, total: 0, requiredOk: false };
  }
  cache = { at: now, key: root, result };
  return result;
}
