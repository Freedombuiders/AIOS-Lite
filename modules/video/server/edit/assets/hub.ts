// Asset Hub wiring: where the library and projects live, the agent turn, Pexels and the ffmpeg helpers.
// registerAssetHubRoutes binds the studio's root; tests replace any part with setAssetHubDeps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPexelsClient, type PexelsClient } from '../../../../../src/integrations/pexels/client.js';
import { moduleCtx } from '../../host.js';
import { loadIntegrationValues } from '../../integration-values.js';
import { STORE_DIR } from '../../paths.js';
import type { LeanRun } from '../agent/director.js';
import { probeDuration, runFfmpeg } from '../pipeline/tools.js';
import { createVideoEditStore, type VideoEditStore } from '../store.js';
import { resolveDefaultAgentId } from '../turn.js';
import { BEAT_SR } from './beats.js';

/** The two Pexels searches the hub uses (src/integrations/pexels/client.ts). */
export type StockClient = Pick<PexelsClient, 'searchVideos' | 'searchPhotos'>;

export interface AssetHubDeps {
  /** The studio root (<data>/video-edit); the library is <root>/library. */
  root: string;
  store: VideoEditStore;
  /** One lean agent turn; null when the module is not running, so there is no agent to ask. */
  run: LeanRun | null;
  /** The agent's runtime reads images. */
  seesImages: (agentId: string) => boolean;
  defaultAgentId: () => string;
  /** Pexels client, or null when no API key is saved. */
  pexels: () => StockClient | null;
  /** Downloads an https URL to a file. */
  download: (url: string, dest: string) => Promise<void>;
  /** JPEG frames (long edge ≤ 600 px) of a video or picture at the given times; frames that fail are left out. */
  frames: (file: string, times: number[], outDir: string) => Promise<string[]>;
  /** Seconds, 0 when unknown. */
  duration: (file: string) => Promise<number>;
  /** Mono float PCM at BEAT_SR, first PCM_MAX_SEC seconds. */
  pcm: (file: string) => Promise<Float32Array>;
  /** Spectrogram picture of a track; false when ffmpeg cannot draw it. */
  spectrogram: (file: string, dest: string) => Promise<boolean>;
}

/** Long tracks are measured on their first minutes only: a video never needs more. */
export const PCM_MAX_SEC = 360;

/** Same lookup as production/engines.ts: the key the owner saved in Integrations › Pexels. */
function pexelsKey(): string | null {
  try { return loadIntegrationValues('pexels')?.api_key?.trim() || null; } catch { return null; }
}

function defaultRun(): LeanRun | null {
  const ctx = moduleCtx();
  if (!ctx) return null;
  return (turn) => ctx.agents.runLean({
    agentId: turn.agentId, title: turn.title, prompt: turn.prompt,
    ...(turn.images?.length ? { images: turn.images } : {}), ...(turn.signal ? { signal: turn.signal } : {}), ...(turn.timeoutMs ? { timeoutMs: turn.timeoutMs } : {}),
  });
}

function defaultSeesImages(agentId: string): boolean {
  const agents = moduleCtx()?.agents;
  return typeof agents?.attachments === 'function' ? agents.attachments(agentId).images : true;
}

async function defaultDownload(url: string, dest: string): Promise<void> {
  if (!/^https:\/\//.test(url)) throw new Error('Đường dẫn tải không hợp lệ.');
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Không tải được file (HTTP ${res.status}).`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function defaultFrames(file: string, times: number[], outDir: string): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const out: string[] = [];
  for (const [i, t] of times.entries()) {
    const dest = path.join(outDir, `frame-${i + 1}.jpg`);
    try {
      await runFfmpeg(['-y', '-ss', Math.max(0, t).toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=600:600:force_original_aspect_ratio=decrease', '-q:v', '4', dest], { timeoutMs: 60_000 });
      if (fs.existsSync(dest)) out.push(dest);
    } catch { /* leave this frame out */ }
  }
  return out;
}

async function defaultPcm(file: string): Promise<Float32Array> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-pcm-'));
  const raw = path.join(dir, 'audio.f32');
  try {
    await runFfmpeg(['-y', '-i', file, '-t', String(PCM_MAX_SEC), '-vn', '-ac', '1', '-ar', String(BEAT_SR), '-f', 'f32le', raw], { timeoutMs: 180_000 });
    const buf = fs.readFileSync(raw);
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function defaultSpectrogram(file: string, dest: string): Promise<boolean> {
  try {
    await runFfmpeg(['-y', '-i', file, '-t', '120', '-lavfi', 'showspectrumpic=s=800x400:legend=0', dest], { timeoutMs: 60_000 });
    return fs.existsSync(dest);
  } catch {
    return false;
  }
}

let bound: { root: string; store: VideoEditStore } | null = null;
let overrides: Partial<AssetHubDeps> = {};

/** The running studio's root and store (registerAssetHubRoutes). */
export function bindAssetHub(root: string, store: VideoEditStore): void {
  bound = { root, store };
}

/** Tests: replace parts of the hub; null restores the defaults. */
export function setAssetHubDeps(next: Partial<AssetHubDeps> | null): void {
  overrides = next ?? {};
}

export function hub(): AssetHubDeps {
  const root = overrides.root ?? bound?.root ?? path.join(STORE_DIR, 'video-edit');
  const store = overrides.store ?? (bound?.root === root ? bound.store : createVideoEditStore(root));
  return {
    run: defaultRun(),
    seesImages: defaultSeesImages,
    defaultAgentId: resolveDefaultAgentId,
    pexels: () => { const apiKey = pexelsKey(); return apiKey ? createPexelsClient({ apiKey }) : null; },
    download: defaultDownload,
    frames: defaultFrames,
    duration: (file) => probeDuration(file).catch(() => 0),
    pcm: defaultPcm,
    spectrogram: defaultSpectrogram,
    ...overrides,
    root,
    store,
  };
}
