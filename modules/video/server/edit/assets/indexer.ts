// Asset Hub index: the agent looks at 2–6 frames of a clip (or the picture) and writes a Vietnamese caption
// and a quality score; a music track gets its tempo and strong beats measured from PCM, then the agent labels
// mood / genre / vocals. A light queue indexes new library files one at a time in the background.
import fs from 'node:fs';
import path from 'node:path';

import {
  assetFilePath, findAsset, LibraryError, libraryTmpDir, onLibraryAdded, recordAssetIndex,
  type AssetIndexPatch, type LibraryAsset,
} from '../library/store.js';
import { analyzeBeats, BEAT_SR, type BeatAnalysis } from './beats.js';
import { hub } from './hub.js';
import { clipIndexPrompt, musicLabelPrompt, parseClipIndex, parseMusicLabel } from './prompts.js';

export interface IndexResult {
  asset: LibraryAsset;
  notes: string[];
}

const VISUAL = new Set(['video', 'image']);
const INDEX_TIMEOUT_MS = 4 * 60_000;
/** Background queue cap: files beyond it wait for an explicit POST /assets/index. */
const MAX_PENDING = 100;

/** OpenStoryline's frame count: 3 per second of footage, at least 2, at most 6, sampled at bucket centres. */
export function frameTimes(durationSec: number): number[] {
  if (!(durationSec > 0)) return [0];
  const n = Math.min(6, Math.max(2, Math.ceil(durationSec * 3)));
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * durationSec / n) * 1000) / 1000);
}

export const isIndexable = (a: Pick<LibraryAsset, 'kind'>) => VISUAL.has(a.kind) || a.kind === 'bgm';

function tempDir(root: string): string {
  fs.mkdirSync(libraryTmpDir(root), { recursive: true });
  return fs.mkdtempSync(path.join(libraryTmpDir(root), 'index-'));
}

async function indexVisual(asset: LibraryAsset, file: string, agentId: string, notes: string[]): Promise<AssetIndexPatch | null> {
  const h = hub();
  if (!h.run) { notes.push('Chưa có agent để xem tư liệu (module video chưa chạy).'); return null; }
  if (!h.seesImages(agentId)) { notes.push(`Agent "${agentId}" không đọc được ảnh nên chưa mô tả được tư liệu.`); return null; }
  const dir = tempDir(h.root);
  try {
    const durationSec = asset.kind === 'video' ? asset.durationSec || await h.duration(file) : undefined;
    const images = await h.frames(file, asset.kind === 'video' ? frameTimes(durationSec ?? 0) : [0], dir);
    if (images.length === 0) { notes.push('Không trích được khung hình để xem (kiểm tra ffmpeg).'); return null; }
    const res = await h.run({
      agentId, title: `Mô tả tư liệu: ${asset.name}`.slice(0, 120), timeoutMs: INDEX_TIMEOUT_MS, images,
      prompt: clipIndexPrompt({ kind: asset.kind === 'video' ? 'video' : 'image', name: asset.name, durationSec, frames: images.length, note: asset.description }),
    });
    if (!res.ok) { notes.push(`Agent chưa mô tả được: ${res.error ?? 'không rõ lỗi'}.`); return null; }
    const parsed = parseClipIndex(res.output);
    if (!parsed) { notes.push('Câu trả lời của agent không đúng dạng JSON caption/quality.'); return null; }
    return { caption: parsed.caption, ...(parsed.quality !== undefined ? { quality: parsed.quality } : {}), indexedAt: new Date().toISOString() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function indexMusic(asset: LibraryAsset, file: string, agentId: string, force: boolean, notes: string[]): Promise<AssetIndexPatch | null> {
  const h = hub();
  const patch: AssetIndexPatch = {};
  let measured: BeatAnalysis | null = null;
  if (force || !asset.beats?.length) {
    try {
      measured = analyzeBeats(await h.pcm(file), BEAT_SR);
      if (measured.bpm > 0 && measured.accents.length > 0) {
        patch.beats = measured.accents;
        if (force || !asset.bpm) patch.bpm = Math.round(measured.bpm);
      } else {
        notes.push('Không đo được nhịp của bài này.');
      }
    } catch (err) {
      notes.push(`Không đọc được âm thanh để đo nhịp: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  if (force || !asset.indexedAt) {
    if (!h.run) {
      notes.push('Chưa có agent để gắn nhãn nhạc (module video chưa chạy).');
    } else {
      const dir = tempDir(h.root);
      try {
        const spectrogram = path.join(dir, 'spectrogram.png');
        const withPicture = h.seesImages(agentId) && await h.spectrogram(file, spectrogram);
        const res = await h.run({
          agentId, title: `Gắn nhãn nhạc: ${asset.name}`.slice(0, 120), timeoutMs: INDEX_TIMEOUT_MS,
          ...(withPicture ? { images: [spectrogram] } : {}),
          prompt: musicLabelPrompt({
            name: asset.name, description: asset.description, tags: asset.tags, mood: asset.mood,
            durationSec: asset.durationSec ?? measured?.durationSec, bpm: patch.bpm ?? asset.bpm ?? measured?.bpm,
            energyMeanDb: measured?.energyMeanDb, dynamicRangeDb: measured?.dynamicRangeDb, spectrogram: withPicture,
          }),
        });
        const label = res.ok ? parseMusicLabel(res.output) : null;
        if (!label) {
          notes.push(res.ok ? 'Câu trả lời của agent không đúng dạng JSON nhãn nhạc.' : `Agent chưa gắn nhãn được: ${res.error ?? 'không rõ lỗi'}.`);
        } else {
          // The owner's (or the starter pack's) mood stays; the agent only fills a missing one.
          if (label.mood && !asset.mood) patch.mood = label.mood;
          if (label.genre) patch.genre = label.genre;
          if (label.vocals !== undefined) patch.vocals = label.vocals;
          if (label.description) patch.caption = label.description;
          patch.indexedAt = new Date().toISOString();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Index one library file now. `force` re-describes / re-measures a file that already has an index. */
export async function indexAsset(id: string, opts: { force?: boolean; agentId?: string } = {}): Promise<IndexResult> {
  const h = hub();
  let asset = findAsset(h.root, id);
  if (asset?.aliasOf) asset = findAsset(h.root, asset.aliasOf);
  if (!asset) throw new LibraryError(404, 'Không tìm thấy mục này.', 'not_found');
  if (!isIndexable(asset)) throw new LibraryError(422, 'Chỉ lập chỉ mục được video, ảnh và nhạc nền.', 'not_indexable');
  const file = assetFilePath(h.root, asset);
  if (!file) throw new LibraryError(404, 'Mục này chưa có file.', 'no_file');

  const force = Boolean(opts.force);
  const done = asset.kind === 'bgm' ? Boolean(asset.indexedAt && asset.beats?.length) : Boolean(asset.indexedAt && asset.caption);
  if (done && !force) return { asset, notes: ['Đã lập chỉ mục từ trước.'] };

  const notes: string[] = [];
  const agentId = opts.agentId ?? h.defaultAgentId();
  const patch = asset.kind === 'bgm'
    ? await indexMusic(asset, file, agentId, force, notes)
    : await indexVisual(asset, file, agentId, notes);
  return { asset: patch ? recordAssetIndex(h.root, asset.id, patch) : asset, notes };
}

// ── Background queue ──

const pending: string[] = [];
/** Files that did not index in this process: not retried automatically (POST /assets/index still works). */
const failed = new Set<string>();
let draining: Promise<void> | null = null;

async function drain(): Promise<void> {
  while (pending.length > 0) {
    const id = pending.shift()!;
    try {
      const r = await indexAsset(id);
      if (!r.asset.indexedAt) failed.add(id);
    } catch {
      failed.add(id);
    }
  }
}

/** Queue files for background indexing (skipped when no agent can run). */
export function enqueueIndex(ids: string[]): void {
  if (!hub().run) return;
  for (const id of ids) {
    if (pending.length >= MAX_PENDING) break;
    if (!pending.includes(id) && !failed.has(id)) pending.push(id);
  }
  if (!draining && pending.length > 0) draining = drain().finally(() => { draining = null; });
}

/** Resolves when the background queue is empty (tests, shutdown). */
export const indexQueueIdle = (): Promise<void> => draining ?? Promise.resolve();

export function resetIndexQueue(): void {
  pending.length = 0;
  failed.clear();
}

let stopAuto: (() => void) | null = null;

/** Index new library files of the studio's root as they arrive. Idempotent. */
export function startAutoIndex(): void {
  if (stopAuto) return;
  stopAuto = onLibraryAdded((root, assets) => {
    if (root !== hub().root) return;
    enqueueIndex(assets.filter((a) => isIndexable(a) && !a.indexedAt).map((a) => a.id));
  });
}

export function stopAutoIndex(): void {
  stopAuto?.();
  stopAuto = null;
}
