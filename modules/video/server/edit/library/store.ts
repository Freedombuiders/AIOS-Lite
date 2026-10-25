// Asset library of the Video Studio: a manifest (<root>/library/manifest.json) of the files under
// <root>/library/<kind>/..., merged with the builtin catalog (catalog/assets.ts).
//
// Paths: every `file` stored in the manifest is relative to <root>/library (e.g. "font/be-vietnam-pro/x.ttf").
// All manifest mutations are synchronous read-modify-write, so one process never interleaves two of them;
// slow work (ffprobe) happens before the synchronous apply step.
import { childPath, findBin } from '../../bin.js';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ASSET_KINDS, type AssetKind, type VideoAsset } from '../types.js';
import { BGM_MOODS, KIND_EXTENSIONS, builtinCatalog, normalizeText } from '../catalog/assets.js';

export const DEFAULT_LICENSE = 'chưa rõ — do bạn thêm';

export interface LibraryFace {
  /** Relative to <root>/library. */
  file: string;
  weight: number;
  style: 'normal' | 'italic';
  variable?: boolean;
  weightMin?: number;
  weightMax?: number;
}

/** A VideoAsset plus the library-only details (font faces, builtin alias target). */
export interface LibraryAsset extends VideoAsset {
  /** Font family when the asset is a font. */
  family?: string;
  faces?: LibraryFace[];
  /** Set on a builtin entry (e.g. bgm:tap-trung) that resolves to a real track. */
  aliasOf?: string;
}

type StoredEntry = Omit<LibraryAsset, 'available' | 'tags'> & { tags?: string[] };

interface Manifest {
  version: 1;
  entries: Record<string, StoredEntry>;
}

export interface LibraryDeps {
  probeDuration: (file: string) => Promise<number | undefined>;
  /** Family / style / CSS weight of a font file, or null when it cannot be read. */
  fontInfo: (file: string) => { family: string; style: string; weight: number; italic: boolean } | null;
}

// ── Paths ────────────────────────────────────────────────────────────────────

export const libraryDir = (root: string) => path.join(root, 'library');
export const libraryTmpDir = (root: string) => path.join(libraryDir(root), '.tmp');
const manifestPath = (root: string) => path.join(libraryDir(root), 'manifest.json');

/** Absolute path of a manifest-relative file, or null when it would leave the library folder. */
export function resolveLibraryFile(root: string, rel: string): string | null {
  const base = path.resolve(libraryDir(root));
  const abs = path.resolve(base, rel);
  return abs === base || !abs.startsWith(base + path.sep) ? null : abs;
}

// ── Deps (ffprobe / fc-scan), replaceable in tests ───────────────────────────

function defaultProbeDuration(file: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(findBin('ffprobe') ?? 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 30_000, env: { ...process.env, PATH: childPath() } }, (err, stdout) => {
      const n = err ? NaN : Number(String(stdout).trim());
      resolve(Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined);
    });
  });
}

const FC_WEIGHTS: [number, number][] = [[0, 100], [40, 200], [50, 300], [80, 400], [100, 500], [180, 600], [200, 700], [205, 800], [210, 900]];
const cssWeight = (fc: number) => FC_WEIGHTS.reduce((best, cur) => (Math.abs(cur[0] - fc) < Math.abs(best[0] - fc) ? cur : best))[1];

function nameFromFile(file: string): { family: string; style: string; weight: number; italic: boolean } {
  const base = path.basename(file).replace(/\.[^.]+$/, '').replace(/\[[^\]]*\]/g, '');
  const [rawFamily, rawStyle = 'Regular'] = base.split(/[-_](?=[A-Za-z]+$)/);
  const family = rawFamily.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_]+/g, ' ').trim() || base;
  const s = rawStyle.toLowerCase();
  const weight = /thin|hairline/.test(s) ? 100 : /extralight|ultralight/.test(s) ? 200 : /light/.test(s) ? 300 : /medium/.test(s) ? 500
    : /semibold|demibold/.test(s) ? 600 : /extrabold|ultrabold/.test(s) ? 800 : /black|heavy/.test(s) ? 900 : /bold/.test(s) ? 700 : 400;
  return { family, style: rawStyle, weight, italic: /italic|oblique/.test(s) };
}

function defaultFontInfo(file: string) {
  try {
    const out = execFileSync('fc-scan', ['--format', '%{family[0]}\t%{style[0]}\t%{weight}\t%{slant}\n', file], { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.split('\n').find((l) => l.trim());
    if (line) {
      const [family, style, weight, slant] = line.split('\t');
      if (family) return { family, style: style || 'Regular', weight: cssWeight(Number(weight) || 80), italic: Number(slant) >= 100 };
    }
  } catch { /* fc-scan missing or the file is not a font: fall back to the file name */ }
  return nameFromFile(file);
}

let deps: LibraryDeps = { probeDuration: defaultProbeDuration, fontInfo: defaultFontInfo };
export function setLibraryDeps(next: Partial<LibraryDeps> | null): void {
  deps = { probeDuration: defaultProbeDuration, fontInfo: defaultFontInfo, ...(next ?? {}) };
}
export const probeAudioDuration = (file: string) => deps.probeDuration(file);

// ── New-file listeners (the Asset Hub index queue) ──────────────────────────

export type LibraryAddedListener = (root: string, assets: LibraryAsset[]) => void;
const addedListeners = new Set<LibraryAddedListener>();

/** Called after files are added (upload, add from path, dropped into the folders). Returns the unsubscribe. */
export function onLibraryAdded(fn: LibraryAddedListener): () => void {
  addedListeners.add(fn);
  return () => { addedListeners.delete(fn); };
}

function notifyAdded(root: string, assets: LibraryAsset[]): void {
  if (assets.length === 0) return;
  for (const fn of addedListeners) {
    try { fn(root, assets); } catch { /* a listener never breaks adding a file */ }
  }
}

// ── Manifest I/O ─────────────────────────────────────────────────────────────

const cache = new Map<string, { mtimeMs: number; size: number; data: Manifest }>();

function loadManifest(root: string): Manifest {
  const file = manifestPath(root);
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return { version: 1, entries: {} }; }
  const hit = cache.get(root);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.data;
  let data: Manifest = { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Manifest>;
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') data = { version: 1, entries: parsed.entries };
  } catch { /* corrupt manifest: start empty, the next rescan re-adopts files */ }
  cache.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, data });
  return data;
}

function saveManifest(root: string, data: Manifest): void {
  const dir = libraryDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = manifestPath(root);
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(temp, file);
  const stat = fs.statSync(file);
  cache.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, data });
}

function mutate<T>(root: string, fn: (m: Manifest) => T): T {
  const manifest = loadManifest(root);
  const result = fn(manifest);
  saveManifest(root, manifest);
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export const slugOf = (name: string): string => normalizeText(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const baseName = (file: string) => path.basename(file).replace(/\.[^.]+$/, '');
const extOf = (file: string) => path.extname(file).slice(1).toLowerCase();
const isAudioKind = (k: AssetKind) => k === 'bgm' || k === 'sfx';
const wantsDuration = (k: AssetKind, file?: string) => isAudioKind(k) || k === 'video' || (k === 'overlay' && (!file || /\.(mov|mp4|webm)$/i.test(file)));

let builtinCache: VideoAsset[] | null = null;
const builtins = () => (builtinCache ??= builtinCatalog());

function filesOf(e: StoredEntry): string[] {
  return [...(e.file ? [e.file] : []), ...(e.faces ?? []).map((f) => f.file)];
}

const definedOnly = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return cleaned || 'tep';
}

function uniqueRelPath(root: string, dirRel: string, fileName: string): string {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = path.posix.join(dirRel, n === 1 ? fileName : `${stem}-${n}${ext}`);
    const abs = resolveLibraryFile(root, candidate);
    if (abs && !fs.existsSync(abs)) return candidate;
  }
}

function uniqueId(m: Manifest, wanted: string): string {
  const taken = new Set([...Object.keys(m.entries), ...builtins().map((b) => b.id)]);
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) if (!taken.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
}

function fileSize(root: string, rel: string): number | undefined {
  const abs = resolveLibraryFile(root, rel);
  try { return abs ? fs.statSync(abs).size : undefined; } catch { return undefined; }
}

// ── Discovery of files dropped into the folders ──────────────────────────────

const MAX_DEPTH = 4;
const lastScan = new Map<string, number>();

function walk(dir: string, depth: number, out: string[]): void {
  let items: fs.Dirent[];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) { if (depth < MAX_DEPTH) walk(full, depth + 1, out); }
    else if (it.isFile()) out.push(full);
  }
}

/** Adds manifest entries for files nobody knows about and drops entries whose files are gone. Synchronous, no ffprobe. */
function discover(root: string, force = false): { added: number; removed: number } {
  const now = Date.now();
  if (!force && now - (lastScan.get(root) ?? 0) < 3000) return { added: 0, removed: 0 };
  lastScan.set(root, now);
  const lib = libraryDir(root);
  if (!fs.existsSync(lib)) return { added: 0, removed: 0 };

  const manifest = loadManifest(root);
  const known = new Set<string>();
  for (const e of Object.values(manifest.entries)) for (const f of filesOf(e)) known.add(f);

  const fresh: { kind: AssetKind; rel: string }[] = [];
  for (const { kind } of ASSET_KINDS) {
    const exts = KIND_EXTENSIONS[kind];
    if (exts.length === 0) continue;
    const files: string[] = [];
    walk(path.join(lib, kind), 0, files);
    for (const abs of files) {
      if (!exts.includes(extOf(abs))) continue;
      const rel = path.relative(lib, abs).split(path.sep).join('/');
      if (!known.has(rel)) fresh.push({ kind, rel });
    }
  }

  const gone: string[] = [];
  for (const [id, e] of Object.entries(manifest.entries)) {
    const files = filesOf(e);
    if (files.length === 0) continue;
    if (files.every((f) => fileSize(root, f) === undefined)) gone.push(id);
  }
  if (fresh.length === 0 && gone.length === 0) return { added: 0, removed: 0 };

  const added: StoredEntry[] = [];
  mutate(root, (m) => {
    for (const id of gone) delete m.entries[id];
    const builtinIds = new Set(builtins().map((b) => b.id));
    for (const { kind, rel } of fresh) {
      const abs = resolveLibraryFile(root, rel)!;
      const name = baseName(abs);
      const slug = slugOf(name) || 'tep';
      const builtinId = `${kind}:${slug}`;
      const adopt = builtinIds.has(builtinId) && !m.entries[builtinId]?.file;
      const id = adopt ? builtinId : uniqueId(m, `lib:${kind}:${slug}`);
      const sub = path.posix.dirname(path.posix.relative(kind, rel));
      const entry: StoredEntry = {
        id, kind, name, source: 'library', license: DEFAULT_LICENSE, file: rel,
        tags: sub === '.' ? [] : sub.split('/'),
        sizeBytes: fileSize(root, rel), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ...m.entries[id] ? { description: m.entries[id].description, enabled: m.entries[id].enabled } : {},
      };
      if (kind === 'font') applyFontInfo(entry, abs, rel);
      m.entries[id] = definedOnly(entry) as StoredEntry;
      added.push(m.entries[id]);
    }
  });
  notifyAdded(root, added.map((e) => toAsset(root, e)));
  return { added: fresh.length, removed: gone.length };
}

function applyFontInfo(entry: StoredEntry, abs: string, rel: string): void {
  const info = deps.fontInfo(abs);
  if (!info) return;
  const plain = /^(regular|normal|book)$/i.test(info.style);
  entry.family = info.family;
  entry.name = plain ? info.family : `${info.family} ${info.style}`;
  const variable = path.basename(abs).includes('[');
  entry.faces = [{ file: rel, weight: info.weight, style: info.italic ? 'italic' : 'normal', ...(variable ? { variable: true, weightMin: 100, weightMax: 900 } : {}) }];
}

const enriching = new Set<string>();
/** Files ffprobe could not read, so listing the library does not spawn it for them again. */
const probeFailed = new Set<string>();

/** Fills in durations (ffprobe) for audio/video entries that lack one. */
export async function enrichLibrary(root: string): Promise<void> {
  if (enriching.has(root)) return;
  enriching.add(root);
  try {
    const todo = Object.values(loadManifest(root).entries)
      .filter((e) => e.file && wantsDuration(e.kind, e.file) && e.durationSec === undefined && !probeFailed.has(`${root}\0${e.file}`));
    const found: Record<string, number> = {};
    for (const e of todo) {
      const abs = resolveLibraryFile(root, e.file!);
      if (!abs) continue;
      const d = await deps.probeDuration(abs);
      if (d !== undefined) found[e.id] = d; else probeFailed.add(`${root}\0${e.file}`);
    }
    if (Object.keys(found).length > 0) {
      mutate(root, (m) => { for (const [id, d] of Object.entries(found)) if (m.entries[id]) m.entries[id].durationSec = d; });
    }
  } finally {
    enriching.delete(root);
  }
}

/** Explicit rescan from the UI: discover, prune, then wait for durations. */
export async function rescanLibrary(root: string): Promise<{ added: number; removed: number; total: number }> {
  const r = discover(root, true);
  await enrichLibrary(root);
  return { ...r, total: getLibrary(root).filter((a) => a.file).length };
}

// ── Reading ──────────────────────────────────────────────────────────────────

function toAsset(root: string, e: StoredEntry, base?: VideoAsset): LibraryAsset {
  const merged = { ...(base ?? {}), ...definedOnly(e) } as LibraryAsset;
  merged.tags = e.tags ?? base?.tags ?? [];
  const files = filesOf(e);
  if (files.length > 0) {
    merged.available = files.some((f) => fileSize(root, f) !== undefined);
    if (e.file && e.sizeBytes === undefined) merged.sizeBytes = fileSize(root, e.file);
  } else {
    merged.available = base?.available ?? false;
  }
  return merged;
}

/** Every asset: builtin catalog entries (with their manifest overrides) plus library/seed entries. */
export function getLibrary(root: string): LibraryAsset[] {
  discover(root);
  void enrichLibrary(root);
  const manifest = loadManifest(root);
  const out: LibraryAsset[] = [];
  const builtinIds = new Set<string>();
  for (const b of builtins()) {
    builtinIds.add(b.id);
    const e = manifest.entries[b.id];
    out.push(e ? toAsset(root, e, b) : { ...b });
  }
  for (const [id, e] of Object.entries(manifest.entries)) {
    if (!builtinIds.has(id)) out.push(toAsset(root, e));
  }

  // bgm:<mood> resolves to the first enabled track of that mood.
  for (const mood of BGM_MOODS) {
    const entry = out.find((a) => a.id === `bgm:${mood.slug}`);
    if (!entry || entry.file) continue;
    const track = out
      .filter((a) => a.kind === 'bgm' && a.id !== entry.id && a.mood === mood.label && a.file && a.available && a.enabled !== false)
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'))[0];
    if (!track) continue;
    Object.assign(entry, {
      file: track.file, available: true, durationSec: track.durationSec, sizeBytes: track.sizeBytes,
      license: track.license, attribution: track.attribution, sourceUrl: track.sourceUrl, bpm: track.bpm, aliasOf: track.id,
    });
  }
  return out;
}

export function findAsset(root: string, id: string): LibraryAsset | undefined {
  return getLibrary(root).find((a) => a.id === id);
}

/** Absolute path of the asset's main file when it exists on disk, else null. */
export function assetFilePath(root: string, asset: Pick<VideoAsset, 'file'>): string | null {
  if (!asset.file) return null;
  const abs = resolveLibraryFile(root, asset.file);
  if (!abs) return null;
  try { return fs.statSync(abs).isFile() ? abs : null; } catch { return null; }
}

export interface FontFaceFile {
  /** Absolute path. */
  file: string;
  weight: number;
  style: 'normal' | 'italic';
  variable: boolean;
  weightMin: number;
  weightMax: number;
}
export interface FontFamilyInfo {
  family: string;
  /** The asset to reference in profiles / plans. */
  assetId: string;
  assetIds: string[];
  license?: string;
  faces: FontFaceFile[];
}

/** Enabled fonts with files, grouped by family, ready for @font-face. */
export function listFonts(root: string): FontFamilyInfo[] {
  const families = new Map<string, FontFamilyInfo>();
  for (const a of getLibrary(root)) {
    if (a.kind !== 'font' || !a.available || a.enabled === false) continue;
    const family = a.family ?? a.name;
    const faces: FontFaceFile[] = [];
    const list = a.faces?.length ? a.faces : a.file ? [{ file: a.file, weight: 400, style: 'normal' as const }] : [];
    for (const f of list) {
      const abs = resolveLibraryFile(root, f.file);
      if (!abs || !fs.existsSync(abs)) continue;
      faces.push({
        file: abs, weight: f.weight, style: f.style, variable: Boolean(f.variable),
        weightMin: f.weightMin ?? f.weight, weightMax: f.weightMax ?? f.weight,
      });
    }
    if (faces.length === 0) continue;
    const have = families.get(family);
    if (have) { have.faces.push(...faces); have.assetIds.push(a.id); }
    else families.set(family, { family, assetId: a.id, assetIds: [a.id], license: a.license, faces });
  }
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family, 'vi'));
}

// ── Writing ──────────────────────────────────────────────────────────────────

export class LibraryError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 415 | 422, message: string, readonly code?: string) {
    super(message);
  }
}

export interface AssetMeta {
  name?: string;
  description?: string;
  tags?: string[];
  mood?: string;
  bpm?: number;
  license?: string;
  attribution?: string;
  sourceUrl?: string;
  enabled?: boolean;
  /** Dựng nhanh: footage added for one project. */
  projectId?: string;
}

/** What the Asset Hub index writes: the AI's Vietnamese caption and quality, measured tempo, music labels. */
export interface AssetIndexPatch {
  caption?: string;
  /** 0..1. */
  quality?: number;
  bpm?: number;
  /** Strong-beat times, seconds. */
  beats?: number[];
  vocals?: boolean;
  genre?: string;
  mood?: string;
  indexedAt?: string;
}

/** Stores index results on an entry (a builtin entry gets its own manifest record, as with updateAsset). */
export function recordAssetIndex(root: string, id: string, patch: AssetIndexPatch): LibraryAsset {
  const current = findAsset(root, id);
  if (!current) throw new LibraryError(404, 'Không tìm thấy mục này.', 'not_found');
  return mutate(root, (m) => {
    const entry: StoredEntry = m.entries[id] ?? { id, kind: current.kind, source: 'builtin' };
    Object.assign(entry, definedOnly(patch), { updatedAt: new Date().toISOString() });
    m.entries[id] = entry;
    return toAsset(root, entry, builtins().find((b) => b.id === id));
  });
}

function relocate(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch {
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

/**
 * Moves a validated temp file into <library>/<kind>/ and registers it. Used by uploads and "add from path".
 * The caller has checked the extension; a bad path throws LibraryError.
 */
export async function addFile(root: string, opts: { kind: AssetKind; tempPath: string; fileName: string; meta?: AssetMeta; move?: boolean }): Promise<LibraryAsset> {
  const { kind } = opts;
  const exts = KIND_EXTENSIONS[kind];
  if (!exts || exts.length === 0) throw new LibraryError(400, 'Loại này không có file để thêm.', 'bad_kind');
  const fileName = sanitizeFileName(opts.fileName);
  const ext = extOf(fileName);
  if (!exts.includes(ext)) throw new LibraryError(415, `Loại "${kind}" chỉ nhận: ${exts.join(', ')}.`, 'bad_extension');

  const duration = wantsDuration(kind, fileName) ? await deps.probeDuration(opts.tempPath) : undefined;
  if (wantsDuration(kind, fileName) && kind !== 'overlay' && duration === undefined) throw new LibraryError(422, 'Không đọc được file này. Kiểm tra lại định dạng.', 'probe_failed');

  const rel = uniqueRelPath(root, kind, fileName);
  const abs = resolveLibraryFile(root, rel)!;
  const size = fs.statSync(opts.tempPath).size;
  if (opts.move === false) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.copyFileSync(opts.tempPath, abs); }
  else relocate(opts.tempPath, abs);

  const now = new Date().toISOString();
  const slug = slugOf(baseName(fileName)) || 'tep';
  const asset = mutate(root, (m) => {
    const id = uniqueId(m, `lib:${kind}:${slug}`);
    const entry: StoredEntry = {
      id, kind, name: baseName(fileName), source: 'library', license: DEFAULT_LICENSE, tags: [],
      file: rel, sizeBytes: size, ...(duration !== undefined ? { durationSec: duration } : {}), createdAt: now, updatedAt: now,
    };
    if (kind === 'font') applyFontInfo(entry, abs, rel);
    Object.assign(entry, definedOnly({
      ...(opts.meta?.name ? { name: opts.meta.name } : {}),
      description: opts.meta?.description, tags: opts.meta?.tags ?? entry.tags, mood: opts.meta?.mood, bpm: opts.meta?.bpm,
      license: opts.meta?.license ?? entry.license, attribution: opts.meta?.attribution, sourceUrl: opts.meta?.sourceUrl, enabled: opts.meta?.enabled,
      projectId: opts.meta?.projectId,
    }));
    m.entries[id] = entry;
    return toAsset(root, entry);
  });
  notifyAdded(root, [asset]);
  return asset;
}

export interface SeedFileSpec {
  /** Temp file to move in. */
  tempPath: string;
  /** Path under <library>/<kind>/ (posix), e.g. "be-vietnam-pro/BeVietnamPro-Bold.ttf". */
  relName: string;
  face?: Omit<LibraryFace, 'file'>;
}

/** Installs the file(s) of one starter-pack asset and writes its manifest entry. Idempotent per id. */
export function installSeedAsset(root: string, opts: {
  id: string;
  kind: AssetKind;
  files: SeedFileSpec[];
  /** Main file index (default 0). */
  primary?: number;
  meta: AssetMeta & { name: string; license: string; family?: string };
  durationSec?: number;
}): LibraryAsset {
  if (opts.files.length === 0) throw new LibraryError(400, 'Thiếu file.', 'no_files');
  const placed: { rel: string; spec: SeedFileSpec }[] = [];
  for (const spec of opts.files) {
    const rel = path.posix.join(opts.kind, spec.relName);
    const abs = resolveLibraryFile(root, rel);
    if (!abs) throw new LibraryError(400, 'Đường dẫn file không hợp lệ.', 'bad_path');
    relocate(spec.tempPath, abs);
    placed.push({ rel, spec });
  }
  const now = new Date().toISOString();
  return mutate(root, (m) => {
    const previous = m.entries[opts.id];
    const entry: StoredEntry = {
      id: opts.id, kind: opts.kind, source: 'seed',
      name: opts.meta.name, license: opts.meta.license, tags: opts.meta.tags ?? [],
      file: placed[opts.primary ?? 0].rel,
      sizeBytes: placed.reduce((n, p) => n + (fileSize(root, p.rel) ?? 0), 0),
      createdAt: previous?.createdAt ?? now, updatedAt: now,
      ...(opts.meta.description ? { description: opts.meta.description } : {}),
      ...(opts.meta.mood ? { mood: opts.meta.mood } : {}),
      ...(opts.meta.bpm ? { bpm: opts.meta.bpm } : {}),
      ...(opts.meta.attribution ? { attribution: opts.meta.attribution } : {}),
      ...(opts.meta.sourceUrl ? { sourceUrl: opts.meta.sourceUrl } : {}),
      ...(opts.meta.family ? { family: opts.meta.family } : {}),
      ...(opts.durationSec ? { durationSec: opts.durationSec } : {}),
      ...(previous?.enabled === false ? { enabled: false } : {}),
    };
    const faces = placed.filter((p) => p.spec.face).map((p) => ({ file: p.rel, ...p.spec.face! }));
    if (faces.length) entry.faces = faces;
    m.entries[opts.id] = entry;
    return toAsset(root, entry);
  });
}

/** True when a starter-pack asset is already installed with its file(s) present. */
export function isSeedInstalled(root: string, id: string): boolean {
  const e = loadManifest(root).entries[id];
  return Boolean(e && e.source === 'seed' && filesOf(e).length > 0 && filesOf(e).every((f) => fileSize(root, f) !== undefined));
}

export function updateAsset(root: string, id: string, patch: { [K in keyof AssetMeta]?: AssetMeta[K] | null }): LibraryAsset {
  const current = findAsset(root, id);
  if (!current) throw new LibraryError(404, 'Không tìm thấy mục này.', 'not_found');
  return mutate(root, (m) => {
    const entry: StoredEntry = m.entries[id] ?? { id, kind: current.kind, source: 'builtin' };
    const next = entry as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null || value === '') delete next[key]; else next[key] = value;
    }
    entry.updatedAt = new Date().toISOString();
    m.entries[id] = entry;
    return toAsset(root, entry, builtins().find((b) => b.id === id));
  });
}

function removeEmptyDirs(root: string, from: string): void {
  const stop = path.resolve(libraryDir(root));
  let dir = from;
  while (dir.startsWith(stop + path.sep) && path.dirname(dir) !== stop) {
    try { fs.rmdirSync(dir); } catch { return; }
    dir = path.dirname(dir);
  }
}

/** Removes a library/seed asset with its files; a builtin entry without files is only disabled. */
export function deleteAsset(root: string, id: string): { deleted: boolean; asset: LibraryAsset } {
  const current = findAsset(root, id);
  if (!current) throw new LibraryError(404, 'Không tìm thấy mục này.', 'not_found');
  const entry = loadManifest(root).entries[id];
  if (!entry || filesOf(entry).length === 0) {
    return { deleted: false, asset: updateAsset(root, id, { enabled: false }) };
  }
  for (const rel of filesOf(entry)) {
    const abs = resolveLibraryFile(root, rel);
    if (!abs) continue;
    fs.rmSync(abs, { force: true });
    removeEmptyDirs(root, path.dirname(abs));
  }
  mutate(root, (m) => { delete m.entries[id]; });
  return { deleted: true, asset: findAsset(root, id) ?? { ...current, available: false } };
}

/** Counts of files per kind and the total size, for reports. */
export function libraryStats(root: string): { byKind: Record<string, number>; bytes: number } {
  const byKind: Record<string, number> = {};
  let bytes = 0;
  for (const e of Object.values(loadManifest(root).entries)) {
    if (filesOf(e).length === 0) continue;
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    bytes += e.sizeBytes ?? 0;
  }
  return { byKind, bytes };
}

export function clearLibraryCache(root?: string): void {
  if (root) { cache.delete(root); lastScan.delete(root); } else { cache.clear(); lastScan.clear(); }
  probeFailed.clear();
}
