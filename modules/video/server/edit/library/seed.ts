// Starter pack: a resumable background job that fills the library with licence-clean assets.
//   fonts    Google Fonts families with the Vietnamese subset (OFL), from github.com/google/fonts
//   sfx      Kenney CC0 packs + effects synthesised with ffmpeg (synth.ts)
//   music    CC0 / CC-BY tracks from music-data.ts, each verified on its source page
//   luts     generated .cube files (luts.ts)
//   stickers a subset of Noto Emoji PNGs (Apache-2.0)
// Idempotent: an asset that is already installed is skipped, so running it again resumes where it stopped.
// Downloads go to <library>/.tmp, are type-checked by magic bytes, size-capped, and never executed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { builtinCatalog } from '../catalog/assets.js';
import { CATEGORY_LABEL, CURATED_FONTS, fontRepoDir, fontSlug, type CuratedFont } from './fonts-data.js';
import { LUT_LICENSE, LUT_SPECS, writeLut } from './luts.js';
import { MUSIC_TRACKS, type MusicTrack } from './music-data.js';
import { KENNEY_PACKS, NOTO_EMOJI_LICENSE, NOTO_EMOJI_REPO, NOTO_STICKERS, type KenneyPack, type Sticker } from './seed-data.js';
import { sniffFile, type Sniffed } from './sniff.js';
import { SYNTH_LICENSE, SYNTH_RECIPES, convertToMp3, synthesize, synthesizeTyping } from './synth.js';
import {
  installSeedAsset, isSeedInstalled, libraryStats, libraryTmpDir, libraryDir, probeAudioDuration, type SeedFileSpec,
} from './store.js';

export const SEED_GROUPS = ['fonts', 'sfx', 'music', 'luts', 'stickers'] as const;
export type SeedGroup = (typeof SEED_GROUPS)[number];

export const GROUP_LABEL: Record<SeedGroup, string> = {
  fonts: 'Font tiếng Việt', sfx: 'Tiếng động', music: 'Nhạc nền', luts: 'LUT màu', stickers: 'Nhãn dán',
};

const MB = 1024 * 1024;
const FONTS_RAW = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
const NOTO_RAW = 'https://raw.githubusercontent.com/googlefonts/noto-emoji/main';
export const DEFAULT_MAX_TOTAL_BYTES = 600 * MB;

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface SeedDeps {
  fetchImpl?: FetchImpl;
  /** Total bytes the pack may add to the library (default 600 MB). */
  maxTotalBytes?: number;
  /** Replace the data lists (tests). */
  fonts?: readonly CuratedFont[];
  music?: readonly MusicTrack[];
  stickers?: readonly Sticker[];
  kenney?: readonly KenneyPack[];
  concurrency?: number;
  /** Skip the ffmpeg-based steps (synth, typing, Kenney ogg→mp3). */
  skipFfmpeg?: boolean;
  retryDelayMs?: number;
}

export interface GroupProgress { total: number; done: number; skipped: number; failed: number }

export interface SeedStatus {
  state: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  groups: SeedGroup[];
  startedAt?: string;
  finishedAt?: string;
  /** Overall steps. */
  progress: { done: number; total: number };
  current?: string;
  byGroup: Record<SeedGroup, GroupProgress>;
  /** Files in the library per kind, and the bytes installed by this pack. */
  counts: Record<string, number>;
  bytes: number;
  /** Bytes downloaded by the running/last job. */
  downloadedBytes: number;
  skipped: { item: string; reason: string }[];
  log: string[];
  error?: string;
}

const emptyGroup = (): GroupProgress => ({ total: 0, done: 0, skipped: 0, failed: 0 });
const freshStatus = (): SeedStatus => ({
  state: 'idle', groups: [], progress: { done: 0, total: 0 },
  byGroup: { fonts: emptyGroup(), sfx: emptyGroup(), music: emptyGroup(), luts: emptyGroup(), stickers: emptyGroup() },
  counts: {}, bytes: 0, downloadedBytes: 0, skipped: [], log: [],
});

interface Job { status: SeedStatus; abort: AbortController }
const jobs = new Map<string, Job>();
const stateFile = (root: string) => path.join(libraryDir(root), 'seed-state.json');

function persist(root: string, status: SeedStatus): void {
  try {
    fs.mkdirSync(libraryDir(root), { recursive: true });
    fs.writeFileSync(stateFile(root), JSON.stringify(status));
  } catch { /* status is informational */ }
}

function withStats(root: string, status: SeedStatus): SeedStatus {
  const stats = libraryStats(root);
  return { ...status, counts: stats.byKind, bytes: stats.bytes };
}

export function getSeedStatus(root: string): SeedStatus {
  const job = jobs.get(root);
  if (job) return withStats(root, job.status);
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as SeedStatus;
    if (saved.state === 'running') {
      return withStats(root, { ...saved, state: 'error', error: 'Lần cài trước bị gián đoạn. Bấm cài lại để chạy tiếp, mục đã có sẽ được bỏ qua.' });
    }
    return withStats(root, saved);
  } catch {
    return withStats(root, freshStatus());
  }
}

export function cancelSeed(root: string): SeedStatus {
  jobs.get(root)?.abort.abort();
  return getSeedStatus(root);
}

/** Starts the job in the background and returns at once. A second call while running returns the running status. */
export function startSeed(root: string, opts: { groups?: SeedGroup[]; deps?: SeedDeps } = {}): SeedStatus {
  const running = jobs.get(root);
  if (running && running.status.state === 'running') return withStats(root, running.status);
  const groups = (opts.groups?.length ? opts.groups : [...SEED_GROUPS]).filter((g, i, a) => a.indexOf(g) === i);
  const status = freshStatus();
  status.state = 'running';
  status.groups = groups;
  status.startedAt = new Date().toISOString();
  const job: Job = { status, abort: new AbortController() };
  jobs.set(root, job);
  void runSeed(root, job, groups, opts.deps ?? {}).finally(() => persist(root, job.status));
  return withStats(root, status);
}

/** Runs the job to the end; resolves when finished. Exposed for the CLI-style run in tests. */
export async function runSeedToEnd(root: string, opts: { groups?: SeedGroup[]; deps?: SeedDeps } = {}): Promise<SeedStatus> {
  const groups = (opts.groups?.length ? opts.groups : [...SEED_GROUPS]);
  const status = freshStatus();
  status.state = 'running';
  status.groups = groups;
  status.startedAt = new Date().toISOString();
  const job: Job = { status, abort: new AbortController() };
  jobs.set(root, job);
  await runSeed(root, job, groups, opts.deps ?? {});
  persist(root, job.status);
  return withStats(root, job.status);
}

// ── Job internals ────────────────────────────────────────────────────────────

class Cancelled extends Error {}
class SkipItem extends Error {}

interface Ctx {
  root: string;
  job: Job;
  deps: SeedDeps;
  fetchImpl: FetchImpl;
  tmp: string;
  maxTotal: number;
}

function note(ctx: Ctx, line: string): void {
  const log = ctx.job.status.log;
  log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (log.length > 60) log.splice(0, log.length - 60);
}

function skip(ctx: Ctx, group: SeedGroup, item: string, reason: string): void {
  ctx.job.status.byGroup[group].skipped++;
  ctx.job.status.skipped.push({ item, reason });
  note(ctx, `bỏ qua ${item}: ${reason}`);
}

function step(ctx: Ctx, group: SeedGroup, current?: string, failed = false): void {
  const s = ctx.job.status;
  s.byGroup[group].done++;
  if (failed) s.byGroup[group].failed++;
  s.progress.done++;
  if (current) s.current = current;
}

function checkCancel(ctx: Ctx): void {
  if (ctx.job.abort.signal.aborted) throw new Cancelled();
}

async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** GET with a timeout and two retries on network errors / 5xx / 429. */
async function fetchRetry(ctx: Ctx, url: string, init: RequestInit = {}): Promise<Response> {
  const delay = ctx.deps.retryDelayMs ?? 1000;
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    checkCancel(ctx);
    try {
      const signal = AbortSignal.any([ctx.job.abort.signal, AbortSignal.timeout(90_000)]);
      const res = await ctx.fetchImpl(url, { ...init, signal, headers: { 'User-Agent': 'AIOS-VideoStudio/1.0', ...(init.headers as Record<string, string> | undefined) } });
      if (res.status === 429 || res.status >= 500) { last = new Error(`HTTP ${res.status}`); await sleep(delay * (attempt + 1)); continue; }
      return res;
    } catch (err) {
      if (ctx.job.abort.signal.aborted) throw new Cancelled();
      last = err;
      await sleep(delay * (attempt + 1));
    }
  }
  throw new Error(`không tải được (${(last as Error)?.message ?? 'lỗi mạng'})`);
}

async function fetchText(ctx: Ctx, url: string): Promise<string> {
  const res = await fetchRetry(ctx, url);
  if (!res.ok) throw new SkipItem(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Downloads `url` into the temp folder and returns the file path. A partial file from an earlier run is
 * continued with a Range request when the server allows it. The type is checked against `expect`.
 */
async function download(ctx: Ctx, url: string, opts: { maxBytes: number; expect: Sniffed[]; ext: string }): Promise<{ file: string; bytes: number }> {
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const part = path.join(ctx.tmp, `${key}.part`);
  const done = path.join(ctx.tmp, `${key}.${opts.ext}`);
  fs.mkdirSync(ctx.tmp, { recursive: true });
  const budget = ctx.maxTotal - ctx.job.status.downloadedBytes;
  const cap = Math.min(opts.maxBytes, budget);
  if (cap <= 0) throw new SkipItem('đã đủ giới hạn dung lượng của bộ khởi đầu');

  let have = 0;
  try { have = fs.statSync(part).size; } catch { have = 0; }
  const res = await fetchRetry(ctx, url, have > 0 ? { headers: { Range: `bytes=${have}-` } } : {});
  if (res.status === 416) { fs.rmSync(part, { force: true }); throw new Error('phần tải dở không dùng được, thử lại'); }
  if (!res.ok && res.status !== 206) throw new SkipItem(`HTTP ${res.status}`);
  if (!res.body) throw new Error('phản hồi rỗng');
  const append = res.status === 206 && have > 0;
  if (!append) have = 0;
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && have + declared > cap) { fs.rmSync(part, { force: true }); throw new SkipItem(`quá lớn (${Math.round((have + declared) / MB)} MB)`); }

  let written = have;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > cap) cb(new Error('quá giới hạn dung lượng')); else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), limiter, fs.createWriteStream(part, { flags: append ? 'a' : 'w', mode: 0o600 }));
  } catch (err) {
    if (ctx.job.abort.signal.aborted) throw new Cancelled(); // keep the partial file for the next run
    if (/giới hạn/.test((err as Error).message)) { fs.rmSync(part, { force: true }); throw new SkipItem((err as Error).message); }
    throw err;
  }
  fs.renameSync(part, done);
  const kind = sniffFile(done);
  if (!opts.expect.includes(kind)) {
    fs.rmSync(done, { force: true });
    throw new SkipItem(`nội dung không phải ${opts.expect.join('/')} (nhận ra: ${kind})`);
  }
  ctx.job.status.downloadedBytes += written - have;
  return { file: done, bytes: written };
}

async function guarded(ctx: Ctx, group: SeedGroup, item: string, fn: () => Promise<void>): Promise<void> {
  try {
    checkCancel(ctx);
    ctx.job.status.current = item;
    await fn();
    step(ctx, group);
  } catch (err) {
    if (err instanceof Cancelled) throw err;
    if (err instanceof SkipItem) { skip(ctx, group, item, err.message); step(ctx, group); return; }
    skip(ctx, group, item, (err as Error).message || 'lỗi không rõ');
    step(ctx, group, undefined, true);
  }
}

const builtinById = () => new Map(builtinCatalog().map((a) => [a.id, a]));

// ── Fonts ────────────────────────────────────────────────────────────────────

interface FontFileMeta { style: string; weight: number; filename: string }
export interface FontMetadata {
  license: string;
  subsets: string[];
  fonts: FontFileMeta[];
  wght?: { min: number; max: number };
}

export function parseFontMetadata(pb: string): FontMetadata {
  const license = /^license: "([^"]*)"/m.exec(pb)?.[1] ?? '';
  const subsets = [...pb.matchAll(/^subsets: "([^"]*)"/gm)].map((m) => m[1]);
  const fonts: FontFileMeta[] = [];
  for (const block of pb.matchAll(/^fonts \{([\s\S]*?)^\}/gm)) {
    const body = block[1];
    const style = /style: "([^"]*)"/.exec(body)?.[1];
    const weight = Number(/weight: (\d+)/.exec(body)?.[1]);
    const filename = /filename: "([^"]*)"/.exec(body)?.[1];
    if (style && filename && Number.isFinite(weight)) fonts.push({ style, weight, filename });
  }
  const axis = /axes \{\s*tag: "wght"\s*min_value: ([\d.]+)\s*max_value: ([\d.]+)\s*\}/.exec(pb);
  return { license, subsets, fonts, ...(axis ? { wght: { min: Number(axis[1]), max: Number(axis[2]) } } : {}) };
}

/** The faces worth installing: the upright variable file, else static 400 / 700 / 900 (nearest if missing). */
export function pickFontFiles(meta: FontMetadata): { file: FontFileMeta; variable: boolean }[] {
  const upright = meta.fonts.filter((f) => f.style === 'normal');
  const variable = upright.find((f) => f.filename.includes('['));
  if (variable) return [{ file: variable, variable: true }];
  const byWeight = new Map(upright.map((f) => [f.weight, f]));
  const wanted: FontFileMeta[] = [];
  for (const w of [400, 700, 900]) { const f = byWeight.get(w); if (f) wanted.push(f); }
  if (!byWeight.has(400) && upright.length > 0) {
    // No Regular: add the face nearest to it so there is always a body weight.
    const nearest = [...upright].sort((a, b) => Math.abs(a.weight - 400) - Math.abs(b.weight - 400))[0];
    if (!wanted.includes(nearest)) wanted.unshift(nearest);
  }
  return wanted.map((file) => ({ file, variable: false }));
}

const localFontName = (filename: string) => filename.replace(/\[[^\]]*\]/g, '-VF').replace(/[^A-Za-z0-9._-]/g, '_');

async function seedFont(ctx: Ctx, font: CuratedFont): Promise<void> {
  const slug = fontSlug(font.family);
  const id = `font:${slug}`;
  if (isSeedInstalled(ctx.root, id)) return;
  const dir = fontRepoDir(font.family);
  const meta = parseFontMetadata(await fetchText(ctx, `${FONTS_RAW}/${dir}/METADATA.pb`));
  if (meta.license !== 'OFL') throw new SkipItem(`giấy phép ${meta.license || 'không rõ'}, không phải OFL`);
  if (!meta.subsets.includes('vietnamese')) throw new SkipItem('không có subset tiếng Việt');
  const picks = pickFontFiles(meta);
  if (picks.length === 0) throw new SkipItem('không tìm thấy file font thường');

  const files: SeedFileSpec[] = [];
  for (const { file, variable } of picks) {
    const dl = await download(ctx, `${FONTS_RAW}/${dir}/${encodeURIComponent(file.filename)}`, { maxBytes: 30 * MB, expect: ['ttf', 'otf'], ext: 'font' });
    files.push({
      tempPath: dl.file,
      relName: `${slug}/${localFontName(file.filename)}`,
      face: {
        weight: variable ? Math.min(Math.max(400, meta.wght?.min ?? 400), meta.wght?.max ?? 900) : file.weight,
        style: 'normal',
        ...(variable ? { variable: true, weightMin: meta.wght?.min ?? 100, weightMax: meta.wght?.max ?? 900 } : {}),
      },
    });
  }
  const primary = Math.max(0, files.findIndex((f) => f.face?.variable || f.face?.weight === 400));
  const licenseText = await fetchRetry(ctx, `${FONTS_RAW}/${dir}/OFL.txt`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
  installSeedAsset(ctx.root, {
    id, kind: 'font', files, primary,
    meta: {
      name: font.family, family: font.family,
      description: `${font.note} Có dấu tiếng Việt, giấy phép SIL OFL.`,
      tags: ['font', 'OFL', 'tiếng Việt', CATEGORY_LABEL[font.category], ...(picks[0].variable ? ['biến thiên'] : [])],
      license: 'SIL OFL 1.1',
      sourceUrl: `https://github.com/google/fonts/tree/main/ofl/${dir}`,
    },
  });
  if (licenseText.includes('SIL OPEN FONT LICENSE')) {
    fs.writeFileSync(path.join(libraryDir(ctx.root), 'font', slug, 'OFL.txt'), licenseText);
  }
}

async function runFonts(ctx: Ctx): Promise<void> {
  const list = ctx.deps.fonts ?? CURATED_FONTS;
  ctx.job.status.byGroup.fonts.total = list.length;
  ctx.job.status.progress.total += list.length;
  await pool(list, ctx.deps.concurrency ?? 4, (font) => guarded(ctx, 'fonts', font.family, () => seedFont(ctx, font)));
}

// ── SFX ──────────────────────────────────────────────────────────────────────

async function resolveKenneyZip(ctx: Ctx, pack: KenneyPack): Promise<string> {
  try {
    const html = await fetchText(ctx, pack.page);
    const m = /https:\/\/kenney\.nl\/media\/[^"'\s]*\.zip/.exec(html);
    if (m) return m[0];
  } catch (err) {
    if (err instanceof Cancelled) throw err;
  }
  return pack.fallbackZip;
}

const kenneyId = (pack: KenneyPack, e: KenneyPack['entries'][number]) => (e.builtin ? `sfx:${e.builtin}` : `seed:sfx:kenney-${e.slug}`);

async function runKenney(ctx: Ctx, pack: KenneyPack): Promise<void> {
  const group = 'sfx';
  const pending = pack.entries.filter((e) => !isSeedInstalled(ctx.root, kenneyId(pack, e)));
  for (let i = 0; i < pack.entries.length - pending.length; i++) step(ctx, group);
  if (pending.length === 0) return;

  let zip: AdmZip;
  try {
    checkCancel(ctx);
    ctx.job.status.current = pack.title;
    const url = await resolveKenneyZip(ctx, pack);
    const dl = await download(ctx, url, { maxBytes: 60 * MB, expect: ['zip'], ext: 'zip' });
    zip = new AdmZip(dl.file);
    fs.rmSync(dl.file, { force: true });
  } catch (err) {
    if (err instanceof Cancelled) throw err;
    for (const e of pending) { skip(ctx, group, `${pack.title}: ${e.name}`, (err as Error).message); step(ctx, group, undefined, true); }
    return;
  }

  const builtins = builtinById();
  for (const e of pending) {
    await guarded(ctx, group, `${pack.title}: ${e.name}`, async () => {
      const entry = zip.getEntry(`Audio/${e.file}.ogg`);
      if (!entry) throw new SkipItem('không có trong gói');
      const raw = path.join(ctx.tmp, `kenney-${e.slug}.ogg`);
      fs.writeFileSync(raw, entry.getData(), { mode: 0o600 });
      if (sniffFile(raw) !== 'ogg') { fs.rmSync(raw, { force: true }); throw new SkipItem('không phải file ogg'); }
      let file = raw;
      let ext = 'ogg';
      if (!ctx.deps.skipFfmpeg) {
        const mp3 = path.join(ctx.tmp, `kenney-${e.slug}.mp3`);
        try { await convertToMp3(raw, mp3); file = mp3; ext = 'mp3'; fs.rmSync(raw, { force: true }); } catch { /* keep the ogg */ }
      }
      const id = kenneyId(pack, e);
      const base = e.builtin ? builtins.get(id) : undefined;
      const duration = await probeAudioDuration(file);
      installSeedAsset(ctx.root, {
        id, kind: 'sfx', durationSec: duration,
        files: [{ tempPath: file, relName: `${e.builtin ?? `kenney-${e.slug}`}.${ext}` }],
        meta: {
          name: base?.name ?? e.name,
          description: base?.description ?? `${e.name}, từ gói ${pack.title}.`,
          tags: [...new Set([...(base?.tags ?? []), ...e.tags, 'kenney', 'CC0'])],
          license: 'CC0 1.0 (Kenney)',
          sourceUrl: pack.page,
        },
      });
    });
  }
}

async function runSynth(ctx: Ctx): Promise<void> {
  const builtins = builtinById();
  for (const recipe of SYNTH_RECIPES) {
    const id = `sfx:${recipe.slug}`;
    await guarded(ctx, 'sfx', `Tự tổng hợp: ${builtins.get(id)?.name ?? recipe.slug}`, async () => {
      if (isSeedInstalled(ctx.root, id)) return;
      const out = path.join(ctx.tmp, `synth-${recipe.slug}.mp3`);
      await synthesize(recipe, out);
      const base = builtins.get(id);
      installSeedAsset(ctx.root, {
        id, kind: 'sfx', durationSec: await probeAudioDuration(out),
        files: [{ tempPath: out, relName: `${recipe.slug}.mp3` }],
        meta: {
          name: base?.name ?? recipe.slug, description: base?.description,
          tags: [...new Set([...(base?.tags ?? []), 'tự tổng hợp', 'CC0'])],
          license: SYNTH_LICENSE,
        },
      });
    });
  }
}

async function runTyping(ctx: Ctx): Promise<void> {
  const id = 'sfx:typing';
  await guarded(ctx, 'sfx', 'Gõ phím (ghép từ click Kenney)', async () => {
    if (isSeedInstalled(ctx.root, id)) return;
    const dir = path.join(libraryDir(ctx.root), 'sfx');
    const samples = ['click_001', 'click_002', 'click_003'].map((n) => {
      const slug = n === 'click_002' ? 'mouse-click' : `kenney-click-${n.slice(-1)}`;
      for (const ext of ['mp3', 'ogg']) { const f = path.join(dir, `${slug}.${ext}`); if (fs.existsSync(f)) return f; }
      return '';
    }).filter(Boolean);
    if (samples.length === 0) throw new SkipItem('chưa có mẫu click Kenney để ghép');
    const out = path.join(ctx.tmp, 'synth-typing.mp3');
    await synthesizeTyping(samples, out);
    const base = builtinById().get(id);
    installSeedAsset(ctx.root, {
      id, kind: 'sfx', durationSec: await probeAudioDuration(out),
      files: [{ tempPath: out, relName: 'typing.mp3' }],
      meta: {
        name: base?.name ?? 'Gõ phím', description: base?.description,
        tags: [...new Set([...(base?.tags ?? []), 'tự tổng hợp', 'kenney', 'CC0'])],
        license: 'CC0 1.0 (ghép từ Kenney Interface Sounds)', sourceUrl: 'https://kenney.nl/assets/interface-sounds',
      },
    });
  });
}

async function runSfx(ctx: Ctx): Promise<void> {
  const packs = ctx.deps.kenney ?? KENNEY_PACKS;
  const kenneyCount = packs.reduce((n, p) => n + p.entries.length, 0);
  const synthCount = ctx.deps.skipFfmpeg ? 0 : SYNTH_RECIPES.length + 1;
  ctx.job.status.byGroup.sfx.total = kenneyCount + synthCount;
  ctx.job.status.progress.total += kenneyCount + synthCount;
  for (const pack of packs) await runKenney(ctx, pack);
  if (!ctx.deps.skipFfmpeg) {
    await runSynth(ctx);
    await runTyping(ctx);
  }
}

// ── Music ────────────────────────────────────────────────────────────────────

async function runMusic(ctx: Ctx): Promise<void> {
  const list = ctx.deps.music ?? MUSIC_TRACKS;
  ctx.job.status.byGroup.music.total = list.length;
  ctx.job.status.progress.total += list.length;
  await pool(list, ctx.deps.concurrency ?? 3, (t) => guarded(ctx, 'music', `${t.title} — ${t.author}`, async () => {
    const id = `seed:bgm:${t.slug}`;
    if (isSeedInstalled(ctx.root, id)) return;
    const ext = t.fileUrl.split('?')[0].split('.').pop()!.toLowerCase();
    const dl = await download(ctx, t.fileUrl, { maxBytes: 40 * MB, expect: ext === 'ogg' ? ['ogg'] : ext === 'wav' ? ['wav'] : ['mp3'], ext });
    const duration = await probeAudioDuration(dl.file);
    if (duration === undefined) { fs.rmSync(dl.file, { force: true }); throw new SkipItem('ffprobe không đọc được file'); }
    if (t.maxSeconds && duration > t.maxSeconds) { fs.rmSync(dl.file, { force: true }); throw new SkipItem(`dài ${Math.round(duration)} giây`); }
    installSeedAsset(ctx.root, {
      id, kind: 'bgm', durationSec: duration,
      files: [{ tempPath: dl.file, relName: `${t.mood.slug}/${t.slug}.${ext}` }],
      meta: {
        name: t.title, description: t.description,
        tags: ['nhạc nền', t.mood.slug, ...(t.tags ?? [])],
        mood: t.mood.label, ...(t.bpm ? { bpm: t.bpm } : {}),
        license: t.license, ...(t.attribution ? { attribution: t.attribution } : {}), sourceUrl: t.pageUrl,
      },
    });
  }));
}

// ── LUTs ─────────────────────────────────────────────────────────────────────

async function runLuts(ctx: Ctx): Promise<void> {
  ctx.job.status.byGroup.luts.total = LUT_SPECS.length;
  ctx.job.status.progress.total += LUT_SPECS.length;
  const builtins = builtinById();
  for (const spec of LUT_SPECS) {
    await guarded(ctx, 'luts', spec.name, async () => {
      const id = `lut:${spec.slug}`;
      if (isSeedInstalled(ctx.root, id)) return;
      const out = path.join(ctx.tmp, `lut-${spec.slug}.cube`);
      fs.mkdirSync(ctx.tmp, { recursive: true });
      writeLut(spec, out);
      const base = builtins.get(id);
      installSeedAsset(ctx.root, {
        id, kind: 'lut', files: [{ tempPath: out, relName: `${spec.slug}.cube` }],
        meta: { name: base?.name ?? spec.name, description: spec.description, tags: [...new Set([...(base?.tags ?? []), ...spec.tags, 'LUT', '33x33x33'])], license: LUT_LICENSE },
      });
    });
  }
}

// ── Stickers ─────────────────────────────────────────────────────────────────

async function runStickers(ctx: Ctx): Promise<void> {
  const list = ctx.deps.stickers ?? NOTO_STICKERS;
  ctx.job.status.byGroup.stickers.total = list.length;
  ctx.job.status.progress.total += list.length;
  let licenseSaved = false;
  await pool(list, ctx.deps.concurrency ?? 6, (s) => guarded(ctx, 'stickers', `Emoji ${s.name}`, async () => {
    const id = `seed:image:emoji-${s.hex}`;
    if (isSeedInstalled(ctx.root, id)) return;
    const dl = await download(ctx, `${NOTO_RAW}/2D/png/128/emoji_u${s.hex}.png`, { maxBytes: 2 * MB, expect: ['png'], ext: 'png' });
    installSeedAsset(ctx.root, {
      id, kind: 'image', files: [{ tempPath: dl.file, relName: `stickers/emoji_u${s.hex}.png` }],
      meta: {
        name: `Emoji ${s.name}`, description: `Nhãn dán emoji ${s.name.toLowerCase()} (Noto Emoji, 128 px, nền trong).`,
        tags: ['sticker', 'emoji', 'nhãn dán', ...s.tags], license: NOTO_EMOJI_LICENSE, sourceUrl: `${NOTO_EMOJI_REPO}/blob/main/2D/png/128/emoji_u${s.hex}.png`,
      },
    });
    if (!licenseSaved) {
      licenseSaved = true;
      const text = await fetchRetry(ctx, `${NOTO_RAW}/2D/svg/LICENSE`).then((r) => (r.ok ? r.text() : '')).catch(() => '');
      if (text.includes('Apache License')) fs.writeFileSync(path.join(libraryDir(ctx.root), 'image', 'stickers', 'LICENSE-Noto-Emoji.txt'), text);
    }
  }));
}

// ── Driver ───────────────────────────────────────────────────────────────────

async function runSeed(root: string, job: Job, groups: SeedGroup[], deps: SeedDeps): Promise<void> {
  const ctx: Ctx = {
    root, job, deps,
    fetchImpl: deps.fetchImpl ?? ((input, init) => fetch(input, init)),
    tmp: libraryTmpDir(root),
    maxTotal: deps.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
  fs.mkdirSync(ctx.tmp, { recursive: true });
  const runners: Record<SeedGroup, (c: Ctx) => Promise<void>> = {
    fonts: runFonts, sfx: runSfx, music: runMusic, luts: runLuts, stickers: runStickers,
  };
  try {
    for (const group of SEED_GROUPS) {
      if (!groups.includes(group)) continue;
      note(ctx, `bắt đầu: ${GROUP_LABEL[group]}`);
      await runners[group](ctx);
      persist(root, job.status);
    }
    job.status.state = 'done';
    const stats = libraryStats(root);
    note(ctx, `xong. Thư viện có ${Object.values(stats.byKind).reduce((a, b) => a + b, 0)} file, ${(stats.bytes / MB).toFixed(1)} MB.`);
  } catch (err) {
    if (err instanceof Cancelled) { job.status.state = 'cancelled'; note(ctx, 'đã dừng. Chạy lại để tiếp tục.'); }
    else { job.status.state = 'error'; job.status.error = (err as Error).message; note(ctx, `lỗi: ${(err as Error).message}`); }
  } finally {
    job.status.finishedAt = new Date().toISOString();
    job.status.current = undefined;
    // Leave only finished downloads' leftovers out of the library: stale temp files are safe to drop.
    try {
      for (const name of fs.readdirSync(ctx.tmp)) {
        if (!name.endsWith('.part')) fs.rmSync(path.join(ctx.tmp, name), { force: true });
      }
    } catch { /* ignore */ }
  }
}
