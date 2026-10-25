// Test double of the Asset Hub: a temp studio root with one Dựng nhanh project and a transcript, a fake Pexels,
// a fake agent turn and fake ffmpeg helpers. No network, no ffmpeg, no real agent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PexelsPhoto, PexelsVideo } from '../../../../../src/integrations/pexels/client.js';
import type { LeanTurn } from '../agent/director.js';
import { addFile, clearLibraryCache, setLibraryDeps, type AssetMeta, type LibraryAsset } from '../library/store.js';
import { createVideoEditStore, type VideoEditStore } from '../store.js';
import type { AssetKind, BrollItem, EditPlan, QuickSettings, VideoProject } from '../types.js';
import { setAssetHubDeps, type AssetHubDeps, type StockClient } from './hub.js';
import { resetIndexQueue, stopAutoIndex } from './indexer.js';

export const WORDS: [string, number, number][] = [
  ['Sáng', 0.2, 0.5], ['nào', 0.5, 0.8], ['mình', 0.8, 1.0], ['cũng', 1.0, 1.2], ['pha', 1.2, 1.5], ['cà', 1.5, 1.7], ['phê', 1.7, 2.0],
  ['rồi', 2.2, 2.4], ['mở', 2.4, 2.6], ['máy', 2.6, 2.8], ['tính', 2.8, 3.1], ['làm', 3.3, 3.5], ['việc', 3.5, 3.8],
  ['ở', 4.0, 4.1], ['văn', 4.1, 4.4], ['phòng', 4.4, 4.8], ['đến', 6.0, 6.2], ['tối', 6.2, 6.5], ['mới', 6.5, 6.7], ['về', 6.7, 7.0],
];

export const pexelsVideo = (id: number, slug: string, duration: number, width = 1080, height = 1920, by = 'Ana Lee'): PexelsVideo => ({
  id, url: `https://www.pexels.com/video/${slug}-${id}/`, image: `https://images.pexels.com/videos/${id}/preview.jpg`,
  duration, width, height, user: { name: by },
  video_files: [{ id: id * 10, quality: 'hd', file_type: 'video/mp4', width, height, link: `https://videos.pexels.com/video-files/${id}/hd.mp4` }],
});

export const pexelsPhoto = (id: number, alt: string, width = 1080, height = 1620, by = 'Bao Tran'): PexelsPhoto => ({
  id, url: `https://www.pexels.com/photo/${alt.toLowerCase().replace(/\s+/g, '-')}-${id}/`, width, height, photographer: by, alt,
  src: { large2x: `https://images.pexels.com/photos/${id}/p.jpeg?auto=compress&h=1880`, medium: `https://images.pexels.com/photos/${id}/p.jpeg?h=350` },
});

export interface FakePexels extends StockClient {
  videos: PexelsVideo[];
  photos: PexelsPhoto[];
  queries: { kind: 'video' | 'photo'; query: string; orientation?: string }[];
}

export function fakePexels(videos: PexelsVideo[] = [], photos: PexelsPhoto[] = []): FakePexels {
  const fake: FakePexels = {
    videos, photos, queries: [],
    searchVideos: async (p) => { fake.queries.push({ kind: 'video', query: p.query, orientation: p.orientation }); return { videos: fake.videos }; },
    searchPhotos: async (p) => { fake.queries.push({ kind: 'photo', query: p.query, orientation: p.orientation }); return { photos: fake.photos }; },
  };
  return fake;
}

/** Captions of the candidates listed in a scoring prompt, in order. */
export function scoredCaptions(prompt: string): string[] {
  return [...prompt.matchAll(/^\d+\. .*? · "(.*)" \((?:ảnh \d+|không có ảnh[^)]*)\)$/gm)].map((m) => m[1]);
}

export interface HubKit {
  root: string;
  store: VideoEditStore;
  project: VideoProject;
  pexels: FakePexels;
  turns: LeanTurn[];
  downloads: string[];
  /** Score per candidate caption (default 1). */
  scoreOf: (caption: string) => number;
  deps: Partial<AssetHubDeps>;
  addAsset(kind: AssetKind, fileName: string, meta?: AssetMeta, extra?: Partial<LibraryAsset>): Promise<LibraryAsset>;
  setQuick(patch: Partial<QuickSettings>): void;
  savePlan(brolls: BrollItem[]): EditPlan;
  cleanup(): void;
}

export const CAPTION_REPLY = '{"caption": "Cận cảnh bàn tay rót cà phê vào cốc trắng, ánh sáng buổi sáng.", "quality": 0.81}';
export const MUSIC_REPLY = '```json\n{"mood": "Năng lượng", "genre": "Electronic", "vocals": false, "description": "Nhạc điện tử nhanh, hợp video công nghệ."}\n```';

export function makeHubKit(opts: { styleId?: string; withRootInDeps?: boolean } = {}): HubKit {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-assets-'));
  clearLibraryCache();
  setLibraryDeps({ probeDuration: async () => 8, fontInfo: () => null });
  const store = createVideoEditStore(root);
  const profile = store.createProfile({ name: 'Kênh thử' });
  const created = store.createProject({ profileId: profile.id, agentId: 'director', styleId: opts.styleId ?? 'congnghe', aspect: '9:16' });
  store.writeTranscript(created.id, {
    language: 'vi', model: 'fake', durationSec: 8, createdAt: 'x',
    words: WORDS.map(([text, start, end], i) => ({ i, text, start, end })),
  });

  const kit: HubKit = {
    root, store, project: created, pexels: fakePexels(), turns: [], downloads: [], scoreOf: () => 1, deps: {},
    async addAsset(kind, fileName, meta, extra) {
      const temp = path.join(root, 'scratch', fileName);
      fs.mkdirSync(path.dirname(temp), { recursive: true });
      fs.writeFileSync(temp, `fake ${fileName}`);
      const asset = await addFile(root, { kind, tempPath: temp, fileName, meta });
      if (!extra) return asset;
      const manifestFile = path.join(root, 'library', 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      Object.assign(manifest.entries[asset.id], extra);
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      clearLibraryCache(root);
      return { ...asset, ...extra };
    },
    setQuick(patch) {
      kit.project = store.updateProject(created.id, (p) => {
        p.quick = {
          mode: 'ai', autoCut: true, cutLevel: 'vua', templateId: 'th-vang', assets: [], stock: true, startedAt: 'x',
          music: { mode: 'ai', duck: true, snapToBeat: true, endOnFinal: true }, ...(p.quick ?? {}), ...patch,
        };
      })!;
    },
    savePlan(brolls) {
      const plan = {
        version: 1, createdAt: 'x', styleId: 'congnghe', aspect: '9:16', summary: '', sourceDurationSec: 8, outputDurationSec: 8,
        cutWords: [], gapMs: 400, keep: [{ start: 0, end: 8 }], removed: [], brolls,
        captions: { styleId: 'caption:boxed', position: 'bottom', highlight: [], maxWordsPerChunk: 3 },
        overlays: [], zooms: [], sfx: [], covers: [], meta: { title: '', caption: '', hashtags: [] }, author: 'agent',
      } as EditPlan;
      store.savePlan(created.id, plan);
      kit.project = store.updateProject(created.id, (p) => { p.planVersion = 1; p.plan = plan; })!;
      return plan;
    },
    cleanup() {
      setAssetHubDeps(null);
      setLibraryDeps(null);
      stopAutoIndex();
      resetIndexQueue();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };

  const touch = (file: string, data = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  kit.deps = {
    ...(opts.withRootInDeps === false ? {} : { root, store }),
    run: async (turn) => {
      kit.turns.push(turn);
      if (turn.title.startsWith('Chấm cảnh trám')) {
        const scores = scoredCaptions(turn.prompt).map((caption, i) => ({ n: i + 1, score: kit.scoreOf(caption), reason: 'thử' }));
        return { ok: true, output: JSON.stringify({ scores }) };
      }
      if (turn.title.startsWith('Mô tả tư liệu')) return { ok: true, output: CAPTION_REPLY };
      if (turn.title.startsWith('Gắn nhãn nhạc')) return { ok: true, output: MUSIC_REPLY };
      return { ok: false, output: '', error: 'không rõ lượt' };
    },
    seesImages: () => true,
    defaultAgentId: () => 'main',
    pexels: () => kit.pexels,
    download: async (url, dest) => { kit.downloads.push(url); touch(dest, `downloaded ${url}`); },
    frames: async (_file, times, outDir) => times.map((_, i) => { const f = path.join(outDir, `frame-${i + 1}.jpg`); touch(f); return f; }),
    duration: async () => 8,
    pcm: async () => new Float32Array(0),
    spectrogram: async (_file, dest) => { touch(dest); return true; },
  };
  setAssetHubDeps(kit.deps);
  return kit;
}

export const broll = (id: string, anchorWord: number, query: BrollItem['query'], extra: Partial<BrollItem> = {}): BrollItem => ({
  id, anchorWord, duration: 2, title: `Cảnh ${id}`, reason: 'minh hoạ', source: 'pexels', layout: 'full', enabled: true, query, ...extra,
});
