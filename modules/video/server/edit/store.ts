import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STORE_DIR } from '../paths.js';
import {
  STEP_DEFS,
  type AnalysisResult,
  type EditPlan,
  type OverridesDoc,
  type Transcript,
  type VideoAspect,
  type VideoMark,
  type VideoMessage,
  type VideoPlatform,
  type VideoProfile,
  type VideoProject,
  type VideoProjectSummary,
} from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PALETTE = ['#E4572E', '#F3A712', '#29A19C', '#4C78FF', '#8E5BD9', '#D6457E', '#2E9E5B', '#0F8FB8', '#C2692B', '#5C6BC0'];

export class StoreError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string, public code?: string) {
    super(message);
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function stripDiacritics(text: string): string {
  return text.replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function slugify(name: string): string {
  return stripDiacritics(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'kenh';
}

export function initialsOf(name: string): string {
  const words = stripDiacritics(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return 'VS';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Engine steps up to phase 1 are live; later phases stay muted on the ticket. */
export function newSteps(): VideoProject['steps'] {
  return STEP_DEFS.map((d) =>
    d.phase <= 1
      ? { key: d.key, status: 'pending' as const }
      : { key: d.key, status: 'unavailable' as const, summary: `Chờ engine — giai đoạn ${d.phase}` },
  );
}

export const DEFAULT_AUDIO: VideoProfile['audio'] = { speechRate: 1, voiceLufs: -16, musicLufs: -34, finalLufs: -15.5 };

/** Fill the contract fields phase-0 profile files do not have. */
export function normalizeProfile(raw: VideoProfile): VideoProfile {
  const p = { ...raw } as VideoProfile;
  p.audio = { ...DEFAULT_AUDIO, ...(raw.audio ?? {}) };
  if (!Array.isArray(p.keepWords)) p.keepWords = [];
  if (!p.brand || typeof p.brand !== 'object') p.brand = {};
  if (typeof p.taste !== 'string') p.taste = '';
  if (!p.onboarding || typeof p.onboarding !== 'object') p.onboarding = {};
  if (!Array.isArray(p.referenceChannels)) p.referenceChannels = [];
  return p;
}

/** Fill the contract fields phase-0 project files do not have and wake steps the engine now covers. */
export function normalizeProject(raw: VideoProject): VideoProject {
  const p = { ...raw } as VideoProject;
  if (typeof p.planVersion !== 'number') p.planVersion = 0;
  if (!p.outputs || typeof p.outputs !== 'object') p.outputs = {};
  const byKey = new Map((raw.steps ?? []).map((s) => [s.key, s]));
  p.steps = STEP_DEFS.map((d) => {
    const s = byKey.get(d.key);
    if (!s) return d.phase <= 1 ? { key: d.key, status: 'pending' as const } : { key: d.key, status: 'unavailable' as const };
    if (s.status === 'unavailable' && d.phase <= 1) return { key: d.key, status: 'pending' as const };
    return s;
  });
  return p;
}

export interface ProfileInput {
  name: string;
  handle?: string;
  platform?: VideoPlatform;
  defaultAspect?: VideoAspect;
  defaultStyleId?: string;
  color?: string;
}

export interface ProjectInput {
  profileId: string;
  title?: string;
  styleId?: string;
  aspect?: VideoAspect;
  agentId: string;
}

export function createVideoEditStore(rootDir?: string) {
  const root = rootDir ?? path.join(STORE_DIR, 'video-edit');
  const profilesDir = path.join(root, 'profiles');
  const projectsDir = path.join(root, 'projects');
  const checked = new Set<string>();

  const ensureDir = (dir: string) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  function writeJson(file: string, data: unknown) {
    ensureDir(path.dirname(file));
    const temp = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  const requireId = (id: string, what: string) => {
    if (!isUuid(id)) throw new StoreError(404, `Không tìm thấy ${what}.`);
    return id;
  };

  const profileFile = (id: string) => path.join(profilesDir, `${requireId(id, 'hồ sơ kênh')}.json`);
  const projectDir = (id: string) => path.join(projectsDir, requireId(id, 'việc'));

  // ── Profiles ──
  function getProfile(id: string): VideoProfile | null {
    if (!isUuid(id)) return null;
    const raw = readJson<VideoProfile>(profileFile(id));
    return raw ? normalizeProfile(raw) : null;
  }

  function rawProfiles(): VideoProfile[] {
    if (!fs.existsSync(profilesDir)) return [];
    const out: VideoProfile[] = [];
    for (const name of fs.readdirSync(profilesDir)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const p = readJson<VideoProfile>(path.join(profilesDir, name));
      if (p?.id) out.push(normalizeProfile(p));
    }
    return out;
  }

  function listProfiles(): VideoProfile[] {
    const counts = new Map<string, number>();
    for (const p of rawProjects()) counts.set(p.profileId, (counts.get(p.profileId) ?? 0) + 1);
    return rawProfiles()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((p) => ({ ...p, projectCount: counts.get(p.id) ?? 0 }));
  }

  function createProfile(input: ProfileInput): VideoProfile {
    const base = slugify(input.name);
    const taken = new Set(rawProfiles().map((p) => p.slug));
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    const now = new Date().toISOString();
    const profile: VideoProfile = {
      id: randomUUID(),
      slug,
      name: input.name,
      ...(input.handle ? { handle: input.handle } : {}),
      platform: input.platform ?? 'other',
      initials: initialsOf(input.name),
      color: input.color ?? colorFor(input.name),
      ...(input.defaultStyleId ? { defaultStyleId: input.defaultStyleId } : {}),
      defaultAspect: input.defaultAspect ?? '9:16',
      brand: {},
      audio: { ...DEFAULT_AUDIO },
      keepWords: [],
      taste: '',
      onboarding: {},
      referenceChannels: [],
      autoApprovePlan: false,
      createdAt: now,
      updatedAt: now,
    };
    writeJson(profileFile(profile.id), profile);
    return { ...profile, projectCount: 0 };
  }

  function saveProfile(profile: VideoProfile): VideoProfile {
    const next = { ...profile, updatedAt: new Date().toISOString() };
    delete next.projectCount;
    writeJson(profileFile(next.id), next);
    return next;
  }


  function deleteProfile(id: string) {
    if (!getProfile(id)) throw new StoreError(404, 'Không tìm thấy hồ sơ kênh.');
    if (rawProjects().some((p) => p.profileId === id)) {
      throw new StoreError(409, 'Hồ sơ còn việc dựng. Xoá các việc trước rồi mới xoá hồ sơ.');
    }
    fs.rmSync(profileFile(id), { force: true });
  }

  // ── Projects ──
  function loadProject(id: string): VideoProject | null {
    if (!isUuid(id)) return null;
    const stored = readJson<VideoProject>(path.join(projectDir(id), 'project.json'));
    if (!stored) return null;
    const project = normalizeProject(stored);
    // A turn cannot survive a restart: clear busy left behind by a previous process.
    if (!checked.has(id)) {
      checked.add(id);
      if (project.busy) {
        project.busy = false;
        writeJson(path.join(projectDir(id), 'project.json'), project);
      }
    }
    return project;
  }

  function rawProjects(): VideoProject[] {
    if (!fs.existsSync(projectsDir)) return [];
    const out: VideoProject[] = [];
    for (const name of fs.readdirSync(projectsDir)) {
      if (!isUuid(name)) continue;
      const p = loadProject(name);
      if (p) out.push(p);
    }
    return out;
  }

  function summarize(p: VideoProject): VideoProjectSummary {
    return {
      mode: p.mode ?? 'edit', id: p.id, code: p.code, profileId: p.profileId, title: p.title, status: p.status,
      ...(p.styleId ? { styleId: p.styleId } : {}),
      aspect: p.aspect, busy: p.busy, createdAt: p.createdAt, updatedAt: p.updatedAt,
      hasSource: Boolean(p.source),
      ...(p.source ? { durationSec: p.source.durationSec } : {}),
    };
  }

  function listProjects(profileId?: string): VideoProjectSummary[] {
    return rawProjects()
      .filter((p) => !profileId || p.profileId === profileId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summarize);
  }

  function nextCode(): string {
    const file = path.join(root, 'counter.json');
    const n = (readJson<{ next: number }>(file)?.next ?? 1);
    writeJson(file, { next: n + 1 });
    return `VID-${String(n).padStart(4, '0')}`;
  }

  function createProject(input: ProjectInput): VideoProject {
    const profile = getProfile(input.profileId);
    if (!profile) throw new StoreError(404, 'Không tìm thấy hồ sơ kênh.');
    const now = new Date().toISOString();
    const styleId = input.styleId ?? profile.defaultStyleId;
    const project: VideoProject = {
      id: randomUUID(),
      code: nextCode(),
      profileId: profile.id,
      title: input.title?.trim() || 'Việc mới',
      status: 'draft',
      ...(styleId ? { styleId } : {}),
      aspect: input.aspect ?? profile.defaultAspect,
      agentId: input.agentId,
      steps: newSteps(),
      planVersion: 0,
      outputs: {},
      busy: false,
      createdAt: now,
      updatedAt: now,
    };
    checked.add(project.id);
    writeJson(path.join(projectDir(project.id), 'project.json'), project);
    return project;
  }

  function saveProject(project: VideoProject): VideoProject {
    const next = { ...project, updatedAt: new Date().toISOString() };
    writeJson(path.join(projectDir(next.id), 'project.json'), next);
    return next;
  }

  /** Read-modify-write in one tick; returns null when the project is gone. */
  function updateProject(id: string, fn: (p: VideoProject) => void): VideoProject | null {
    const p = loadProject(id);
    if (!p) return null;
    fn(p);
    return saveProject(p);
  }

  function deleteProject(id: string) {
    const dir = projectDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    checked.delete(id);
  }

  // ── Messages ──
  const messagesFile = (id: string) => path.join(projectDir(id), 'messages.jsonl');

  function readMessages(id: string): VideoMessage[] {
    let raw: string;
    try {
      raw = fs.readFileSync(messagesFile(id), 'utf8');
    } catch {
      return [];
    }
    const out: VideoMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as VideoMessage); } catch { /* skip a torn line */ }
    }
    return out;
  }

  function appendMessage(message: VideoMessage) {
    const file = messagesFile(message.projectId);
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `${JSON.stringify(message)}\n`, { mode: 0o600 });
  }

  // ── Files ──
  const sourceDir = (id: string) => path.join(projectDir(id), 'source');
  const thumbFile = (id: string) => path.join(projectDir(id), 'thumb.jpg');

  function sourceFile(id: string): string | null {
    try {
      const name = fs.readdirSync(sourceDir(id)).find((n) => /^raw\.[a-z0-9]+$/i.test(n));
      return name ? path.join(sourceDir(id), name) : null;
    } catch {
      return null;
    }
  }

  /** Newest finished render: the recorded one, else the latest file by version number. */
  function finalFile(id: string, version?: number): string | null {
    const dir = path.join(projectDir(id), 'renders');
    try {
      if (version !== undefined) {
        const f = path.join(dir, `final.v${version}.mp4`);
        return fs.existsSync(f) ? f : null;
      }
      const best = fs.readdirSync(dir)
        .map((n) => ({ n, v: /^final\.v(\d+)\.mp4$/.exec(n)?.[1] }))
        .filter((x): x is { n: string; v: string } => Boolean(x.v))
        .sort((a, b) => Number(b.v) - Number(a.v))[0];
      if (best) return path.join(dir, best.n);
      // Legacy: any non-hidden file, newest first.
      const files = fs.readdirSync(dir)
        .filter((n) => !n.startsWith('.'))
        .map((n) => ({ file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      return files[0]?.file ?? null;
    } catch {
      return null;
    }
  }

  const coverFile = (id: string, n: 1 | 2 | 3) => path.join(projectDir(id), 'covers', `cover-${n}.jpg`);
  const proxyFile = (id: string) => path.join(sourceDir(id), 'proxy.mp4');
  const masterFile = (id: string) => path.join(sourceDir(id), 'master.mp4');
  const audioFile = (id: string) => path.join(sourceDir(id), 'audio.wav');
  const framesDir = (id: string) => path.join(projectDir(id), 'frames');
  const qaDir = (id: string) => path.join(projectDir(id), 'qa');
  const rendersDir = (id: string) => path.join(projectDir(id), 'renders');
  const coversDir = (id: string) => path.join(projectDir(id), 'covers');
  const compositionDir = (id: string) => path.join(projectDir(id), 'composition');

  // ── Transcript, analysis, plans ──
  const jsonIn = (id: string, name: string) => path.join(projectDir(id), name);

  const readTranscript = (id: string) => readJson<Transcript>(jsonIn(id, 'transcript.json'));
  const writeTranscript = (id: string, t: Transcript) => writeJson(jsonIn(id, 'transcript.json'), t);
  const readAnalysis = (id: string) => readJson<AnalysisResult>(jsonIn(id, 'analysis.json'));
  const writeAnalysis = (id: string, a: AnalysisResult) => writeJson(jsonIn(id, 'analysis.json'), a);

  const planFile = (id: string, version: number) => path.join(projectDir(id), 'plans', `plan.v${Math.max(0, Math.floor(version))}.json`);

  function savePlan(id: string, plan: EditPlan) {
    writeJson(planFile(id, plan.version), plan);
  }

  function loadPlan(id: string, version: number): EditPlan | null {
    if (!isUuid(id) || !Number.isFinite(version)) return null;
    return readJson<EditPlan>(planFile(id, version));
  }

  function listPlanVersions(id: string): number[] {
    try {
      return fs.readdirSync(path.join(projectDir(id), 'plans'))
        .map((n) => /^plan\.v(\d+)\.json$/.exec(n)?.[1])
        .filter((v): v is string => Boolean(v))
        .map(Number)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  // ── Owner overrides (Dựng nhanh): hand edits by element id, never written by the AI ──
  const readOverrides = (id: string): OverridesDoc | null => {
    const raw = readJson<OverridesDoc>(jsonIn(id, 'overrides.json'));
    return raw?.version === 1 && raw.elements && typeof raw.elements === 'object' ? raw : null;
  };
  const writeOverrides = (id: string, doc: OverridesDoc) => writeJson(jsonIn(id, 'overrides.json'), doc);

  // ── Marks, brief, feedback ──
  const readMarks = (id: string): VideoMark[] => {
    const raw = readJson<VideoMark[]>(jsonIn(id, 'marks.json'));
    return Array.isArray(raw) ? raw : [];
  };
  const writeMarks = (id: string, marks: VideoMark[]) => writeJson(jsonIn(id, 'marks.json'), marks);
  const readBrief = (id: string): Record<string, string | string[]> =>
    readJson<Record<string, string | string[]>>(jsonIn(id, 'brief.json')) ?? {};
  const writeBrief = (id: string, brief: Record<string, string | string[]>) => writeJson(jsonIn(id, 'brief.json'), brief);

  function appendFeedback(id: string, entry: Record<string, unknown>) {
    const file = jsonIn(id, 'feedback.jsonl');
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** Remove everything derived from the source video (new upload): keeps chat, marks and the raw file. */
  function clearDerived(id: string) {
    const dir = projectDir(id);
    for (const name of ['transcript.json', 'analysis.json', 'brief.json', 'marks.json', 'overrides.json']) fs.rmSync(path.join(dir, name), { force: true });
    for (const name of ['plans', 'frames', 'composition', 'renders', 'qa', 'covers']) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    for (const name of ['master.mp4', 'proxy.mp4', 'audio.wav']) fs.rmSync(path.join(sourceDir(id), name), { force: true });
  }

  return {
    root,
    getProfile, listProfiles, createProfile, saveProfile, deleteProfile,
    loadProject, listProjects, createProject, saveProject, updateProject, deleteProject,
    readMessages, appendMessage,
    projectDir, sourceDir, thumbFile, sourceFile, finalFile, coverFile, ensureDir,
    proxyFile, masterFile, audioFile, framesDir, qaDir, rendersDir, coversDir, compositionDir,
    readTranscript, writeTranscript, readAnalysis, writeAnalysis,
    savePlan, loadPlan, listPlanVersions,
    readOverrides, writeOverrides,
    readMarks, writeMarks, readBrief, writeBrief, appendFeedback, clearDerived,
    writeJson, readJson,
  };
}

export type VideoEditStore = ReturnType<typeof createVideoEditStore>;
