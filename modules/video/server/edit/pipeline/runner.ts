import { renderCreation } from '../../create/render.js';
// The Video Studio pipeline: the automatic chain
//   upload → ingest → transcribe → analyze → auto plan v1 → direct (agent) → approve → render → covers → deliver
// plus the plan state machine (draft → waiting_approval → approved / rejected) and agent turns.
// Heavy tools are injectable so tests run the whole chain with fakes.
//
// Dựng nhanh (project.flow 'quick', settings in project.quick from POST /ai-edit): the chain stops after analyze
// until the owner presses AI edit; then a machine plan from the settings (cut level, template captions, music)
// and, in mode ai, the director with the template. The plan never stops for approval: the owner edits it and
// only "Xuất" (decide approve) renders.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveBrolls } from '../assets/resolve.js';
import { buildShortlist } from '../assets/shortlist.js';
import { VIDEO_STYLES } from '../catalog/styles.js';
import { emitVideoEvent } from '../events.js';
import { formatSize, ingestSummary } from '../media.js';
import { DEFAULT_AUDIO, StoreError, type VideoEditStore } from '../store.js';
import { getTemplate, templateForPrompt } from '../templates/registry.js';
import type { TemplateManifest } from '../templates/types.js';
import type {
  EditPlan, ProjectStep, QuickSettings, StepKey, Transcript, VideoJob, VideoMark, VideoMessage, VideoProject,
} from '../types.js';
import type { DirectorTurnInput, DirectorTurnResult } from '../agent/director.js';
import { analyzeSource, isFiller } from './analyze.js';
import { makeCovers } from './covers.js';
import { deliverProject } from './deliver.js';
import { createJobQueue, setActivePipeline, type JobHandler, type JobQueue } from './jobs.js';
import { createAssetResolver, type AssetResolver } from './library-resolve.js';
import { normalizeSource } from './normalize.js';
import {
  autoPlan, derivePlan, ELEMENT_LISTS, mintId, planElements, preserveOwnerElements, validateAgentPlan, type PlanContext,
} from './plan.js';
import { renderExport } from './render.js';
import { r1, fmtDur } from './tools.js';
import { transcribeAudio } from './transcribe.js';

export type TurnReason = DirectorTurnInput['reason'];
export type PlanDecisionAction = 'approve' | 'revise' | 'reject';

export interface PipelineTools {
  normalize: typeof normalizeSource;
  transcribe: typeof transcribeAudio;
  analyze: typeof analyzeSource;
  render: typeof renderExport;
  covers: typeof makeCovers;
  deliver: typeof deliverProject;
  runDirector: (input: DirectorTurnInput) => Promise<DirectorTurnResult>;
  /** Create the owner's "Cần tôi" card for the current plan (idempotent per plan version). */
  requestApproval: (projectId: string) => void | Promise<void>;
  /** Dựng nhanh: the Asset Hub shortlist (music of a manual plan, the director prompt). */
  shortlist: typeof buildShortlist;
  /** Dựng nhanh: fill B-roll slots the director left as a `query` (after every plan turn). */
  resolveBrolls: typeof resolveBrolls;
}

/** The template registry as the pipeline reads it (templates/registry.ts). */
export interface PipelineTemplates {
  get: (id: string) => TemplateManifest | null;
  forPrompt: (id: string) => string;
}

export interface PipelineOptions {
  store: VideoEditStore;
  root: string;
  resolver?: AssetResolver;
  tools?: Partial<PipelineTools>;
  /** Run queued work right away. Default true. */
  autoStart?: boolean;
  /** Lessons for the director prompt (module brain + bundled lessons). */
  lessons?: (query: string) => string[];
  /** Template registry: plan checks (components, props, animIn) and the director prompt. Default: the module registry. */
  templates?: PipelineTemplates;
}

// ── Dựng nhanh settings → plan ──

/** Mức cắt → longest pause kept (ms): nhẹ keeps breathing room, sát drops almost every pause. */
export const QUICK_GAP_MS: Record<QuickSettings['cutLevel'], number> = { nhe: 800, vua: 400, sat: 250 };
/** Auto-cut off keeps the video as it is: no word cut and pauses up to the plan maximum (5 s) kept. */
export const NO_CUT_GAP_MS = 5000;
export const CUT_LEVEL_LABEL: Record<QuickSettings['cutLevel'], string> = { nhe: 'nhẹ', vua: 'vừa', sat: 'sát' };

/** What a quick plan reads of a template (templates/types.ts TemplateManifest fits it). */
export type QuickTemplate = Pick<TemplateManifest, 'name' | 'captions'> & Partial<Pick<TemplateManifest, 'legacy' | 'styleId'>>;

/** Title from the first spoken words: fillers and synthetic sounds are not words of the title. */
export function spokenTitle(transcript: Pick<Transcript, 'words'>): string {
  const text = transcript.words.filter((w) => !isFiller(w)).slice(0, 9).map((w) => w.text).join(' ').replace(/[,.;:!?…]+$/u, '');
  return text || 'Video mới';
}

export interface QuickPlanExtras {
  /** Title for meta and covers (the project title, or the first spoken words). */
  title?: string;
  /** Music the owner picked (or the machine chose from the shortlist). */
  music?: { assetId: string; gainDb: number };
  /** mode manual: the owner edits by hand next; otherwise the director refines this plan. */
  manual?: boolean;
}

/** Dựng nhanh settings on a machine plan: template, auto-cut on/off and its level, the template's captions, music. */
export function applyQuickSettings(
  plan: EditPlan,
  quick: Pick<QuickSettings, 'autoCut' | 'cutLevel' | 'templateId' | 'music'>,
  template: QuickTemplate | null,
  ctx: PlanContext,
  extras: QuickPlanExtras = {},
): EditPlan {
  const next: EditPlan = {
    ...structuredClone(plan),
    planFormat: 2,
    templateId: quick.templateId,
    autoCut: quick.autoCut,
    cutWords: quick.autoCut ? plan.cutWords : [],
    gapMs: quick.autoCut ? QUICK_GAP_MS[quick.cutLevel] : NO_CUT_GAP_MS,
  };
  if (template) {
    next.captions = { ...next.captions, maxWordsPerChunk: template.captions.maxWordsPerChunk, position: template.captions.pos < 0.6 ? 'middle' : 'bottom' };
  }
  delete next.music;
  if (quick.music.mode !== 'none' && extras.music) next.music = { assetId: extras.music.assetId, mood: '', gainDb: r1(extras.music.gainDb), duck: quick.music.duck };
  if (extras.title) {
    next.meta = { ...next.meta, title: extras.title };
    next.covers = next.covers.map((c) => ({ ...c, title: extras.title! }));
  }
  const derived = derivePlan(next, ctx);
  const name = template?.name ?? quick.templateId;
  const cut = quick.autoCut
    ? `Tự cắt mức ${CUT_LEVEL_LABEL[quick.cutLevel]}: bỏ ${derived.cutWords.length} từ đệm và câu nói lại, cắt chỗ lặng dài hơn ${derived.gapMs}ms`
    : 'Tắt tự cắt: giữ nguyên video';
  const length = `${r1(derived.sourceDurationSec)}s → ${r1(derived.outputDurationSec)}s`;
  derived.summary = `Bản máy dựng theo mẫu «${name}». ${cut}. Video ${fmtDur(derived.sourceDurationSec)} → ${fmtDur(derived.outputDurationSec)}. `
    + (extras.manual ? 'Mở editor để thêm chữ, cảnh minh hoạ và cảnh trám.' : 'Chờ đạo diễn thêm chữ theo nhịp, cảnh minh hoạ và cảnh trám.');
  derived.changes = [`Mẫu edit: ${name}`, cut, length, ...(derived.music ? ['Có nhạc nền'] : [])];
  return derived;
}

/**
 * Owner elements are read-only for the AI. In a plan the director hands in, an element carrying an owner
 * element's id is dropped (validateAgentPlan puts the owner's own copy back), and a new element never takes an
 * owner's id: without this, a freshly minted "b1" would hide the owner's "b1" and the owner's element were lost.
 */
export function protectOwnerElements(input: unknown, previous: EditPlan | null | undefined): unknown {
  if (!previous || !input || typeof input !== 'object' || Array.isArray(input)) return input;
  const owner = new Map(planElements(previous).filter((e) => e.el.origin === 'owner').map((e) => [e.el.id!, e.key]));
  if (!owner.size) return input;
  const p: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const idOf = (x: unknown) => (x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string' ? (x as { id: string }).id.trim() : '');
  const taken = new Set<string>(owner.keys());
  for (const { key } of ELEMENT_LISTS) if (Array.isArray(p[key])) for (const x of p[key] as unknown[]) if (idOf(x)) taken.add(idOf(x));
  for (const { key, prefix } of ELEMENT_LISTS) {
    if (!Array.isArray(p[key])) continue;
    p[key] = (p[key] as unknown[]).flatMap((x) => {
      if (!x || typeof x !== 'object') return [x];
      const id = idOf(x);
      const ownerKey = id ? owner.get(id) : undefined;
      if (ownerKey === key) return [];
      // B-roll without an id gets a random one from the schema; the other kinds are minted b1, s1 … like the validator.
      if (ownerKey || (!id && key !== 'brolls')) {
        const fresh = mintId(prefix, taken);
        taken.add(fresh);
        return [{ ...(x as Record<string, unknown>), id: fresh }];
      }
      return [x];
    });
  }
  return p;
}

/**
 * The owner's Dựng nhanh choices win over a plan the director hands in: the template, auto-cut off (no cut at
 * all), no music, or the song the owner picked. Anything that is not a plan object passes through untouched.
 */
export function enforceQuickSettings(input: unknown, quick: QuickSettings): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const p: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  p.planFormat = 2;
  p.templateId = quick.templateId;
  p.autoCut = quick.autoCut;
  if (!quick.autoCut) { p.cutWords = []; p.gapMs = NO_CUT_GAP_MS; }
  const music = p.music && typeof p.music === 'object' && !Array.isArray(p.music) ? p.music as Record<string, unknown> : null;
  if (quick.music.mode === 'none') delete p.music;
  else if (quick.music.mode === 'pick' && quick.music.assetId) p.music = { mood: '', gainDb: 0, ...music, assetId: quick.music.assetId, duck: quick.music.duck };
  else if (music) p.music = { ...music, duck: quick.music.duck };
  return p;
}

const LOG_LINES_MAX = 60;
const STEP_PROGRESS_EVERY_MS = 600;
const SUB_STEPS: StepKey[] = ['cut', 'captions', 'effects', 'audio'];
const MARK_REF = /\[mark:([A-Za-z0-9_-]+)\]/g;

export function createPipeline(opts: PipelineOptions) {
  const { store, root } = opts;
  const resolver = opts.resolver ?? createAssetResolver(root);
  const templates: PipelineTemplates = opts.templates ?? { get: getTemplate, forPrompt: templateForPrompt };
  const controllers = new Map<string, AbortController>();
  const stepProgressAt = new Map<string, { at: number; value: number }>();

  const tools: PipelineTools = {
    normalize: normalizeSource,
    transcribe: transcribeAudio,
    analyze: analyzeSource,
    render: renderExport,
    covers: makeCovers,
    deliver: deliverProject,
    runDirector: async (input) => {
      // Lazy: the director pulls in the whole agent engine, which tests and CLI tools do not need.
      const mod = await import('../agent/director.js');
      return mod.runDirectorTurn(input, {
        store,
        templatePrompt: templates.forPrompt,
        shortlist: (id) => tools.shortlist(id),
        submitPlan: (id, plan, note) => {
          try {
            const r = submitAgentPlan(id, plan, note);
            return r.ok ? { ok: true, plan: r.plan } : { ok: false, errors: r.errors };
          } catch (err) { return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }; }
        },
        ...(opts.lessons ? { lessons: opts.lessons } : {}),
      });
    },
    requestApproval: async (projectId) => {
      const mod = await import('../agent/approval-handler.js');
      mod.requestVideoPlanApproval(projectId, { store: () => store });
    },
    shortlist: buildShortlist,
    resolveBrolls,
    ...(opts.tools ?? {}),
  };

  // ── Project / step helpers ──

  const emitProject = (p: VideoProject) => emitVideoEvent(p.id, { type: 'project', project: p });

  const requireProject = (id: string): VideoProject => {
    const p = store.loadProject(id);
    if (!p) throw new StoreError(404, 'Không tìm thấy việc dựng này.');
    return p;
  };

  type StepPatch = {
    status?: ProjectStep['status'];
    summary?: string | null;
    error?: string | null;
    progress?: number | null;
  };

  function setStep(projectId: string, key: StepKey, patch: StepPatch, projectPatch?: (p: VideoProject) => void): VideoProject | null {
    const now = new Date().toISOString();
    const project = store.updateProject(projectId, (p) => {
      p.steps = p.steps.map((s) => {
        if (s.key !== key) return s;
        const next: ProjectStep = { ...s };
        if (patch.status) {
          if (patch.status === 'running' && s.status !== 'running') { next.startedAt = now; delete next.finishedAt; }
          if (patch.status === 'done' || patch.status === 'failed' || patch.status === 'skipped') next.finishedAt = now;
          if (patch.status === 'pending') { delete next.startedAt; delete next.finishedAt; }
          next.status = patch.status;
          if (patch.status !== 'running') delete next.progress;
          if (patch.status !== 'failed' && patch.error === undefined) delete next.error;
        }
        for (const field of ['summary', 'error', 'progress'] as const) {
          const v = patch[field];
          if (v === null) delete next[field];
          else if (v !== undefined) (next as unknown as Record<string, unknown>)[field] = v;
        }
        return next;
      });
      projectPatch?.(p);
    });
    if (!project) return null;
    emitVideoEvent(projectId, { type: 'step', step: project.steps.find((s) => s.key === key)! });
    emitProject(project);
    return project;
  }

  /** Progress ticks are throttled: a step event per tick would rewrite project.json hundreds of times. */
  function stepProgress(projectId: string, key: StepKey, fraction: number) {
    const id = `${projectId}:${key}`;
    const value = Math.max(0, Math.min(1, fraction));
    const last = stepProgressAt.get(id);
    const now = Date.now();
    if (last && (now - last.at < STEP_PROGRESS_EVERY_MS || value <= last.value)) return;
    stepProgressAt.set(id, { at: now, value });
    const project = store.updateProject(projectId, (p) => {
      p.steps = p.steps.map((s) => (s.key === key && s.status === 'running' ? { ...s, progress: value } : s));
    });
    const step = project?.steps.find((s) => s.key === key);
    if (step) emitVideoEvent(projectId, { type: 'step', step });
  }

  function logStep(projectId: string, key: StepKey, text: string) {
    const line = { at: new Date().toISOString(), text: text.trim().slice(0, 400) };
    if (!line.text) return;
    const project = store.updateProject(projectId, (p) => {
      p.steps = p.steps.map((s) => (s.key === key ? { ...s, log: [...(s.log ?? []), line].slice(-LOG_LINES_MAX) } : s));
    });
    const step = project?.steps.find((s) => s.key === key);
    if (step) emitVideoEvent(projectId, { type: 'step', step });
  }

  function setProjectStatus(projectId: string, status: VideoProject['status']) {
    const project = store.updateProject(projectId, (p) => { p.status = status; });
    if (project) emitProject(project);
    return project;
  }

  const stepFail = (projectId: string, key: StepKey, message: string, status?: VideoProject['status']) => {
    setStep(projectId, key, { status: 'failed', error: message, summary: null }, status ? (p) => { p.status = status; } : undefined);
  };

  function appendMessage(projectId: string, message: Omit<VideoMessage, 'id' | 'projectId' | 'createdAt'> & { id?: string }): VideoMessage {
    const full: VideoMessage = { id: message.id ?? randomUUID(), projectId, createdAt: new Date().toISOString(), ...message };
    store.appendMessage(full);
    emitVideoEvent(projectId, { type: 'message', message: full });
    return full;
  }

  function planContext(projectId: string): PlanContext | null {
    const transcript = store.readTranscript(projectId);
    if (!transcript) return null;
    return { transcript, analysis: store.readAnalysis(projectId) };
  }

  // ── Plans ──

  /** Save a plan as the current version and move the plan state machine. */
  function commitPlan(projectId: string, plan: EditPlan, status: NonNullable<VideoProject['planStatus']>): VideoProject {
    store.savePlan(projectId, plan);
    const project = store.updateProject(projectId, (p) => {
      p.plan = plan;
      p.planVersion = plan.version;
      p.planStatus = status;
      // A new version needs a new look from the owner.
      p.steps = p.steps.map((s) => (s.key === 'approve' && s.status !== 'unavailable'
        ? { key: 'approve', status: 'pending' as const }
        : s));
      if (p.status === 'done' || p.status === 'rendering') p.status = 'waiting_approval';
    });
    if (!project) throw new StoreError(404, 'Không tìm thấy việc dựng này.');
    emitVideoEvent(projectId, { type: 'plan', plan, planVersion: plan.version });
    emitProject(project);
    return project;
  }

  const nextVersion = (projectId: string) => Math.max(0, ...store.listPlanVersions(projectId), requireProject(projectId).planVersion) + 1;

  function resolveMarksFrom(projectId: string, changes: string[]): number {
    const ids = new Set<string>();
    for (const line of changes) for (const m of line.matchAll(MARK_REF)) ids.add(m[1]);
    if (!ids.size) return 0;
    const marks = store.readMarks(projectId);
    let n = 0;
    for (const m of marks) if (ids.has(m.id) && m.status !== 'resolved') { m.status = 'resolved'; n++; }
    if (n) store.writeMarks(projectId, marks);
    return n;
  }

  /**
   * An agent submitted a plan (video-cli plan submit). Validated, derived fields recomputed, saved as
   * the next version and parked "waiting for approval".
   */
  function submitAgentPlan(projectId: string, input: unknown, note?: string, validateOnly = false) {
    const project = requireProject(projectId);
    const ctx = planContext(projectId);
    if (!ctx) throw new StoreError(409, 'Chưa có bản chép lời để lập kế hoạch.', 'no_transcript');
    const previous = project.planVersion > 0 ? store.loadPlan(projectId, project.planVersion) : null;
    const own = protectOwnerElements(input, previous);
    const plan = project.quick ? enforceQuickSettings(own, project.quick) : own;
    const result = validateAgentPlan(plan, ctx, {
      previous, version: nextVersion(projectId), aspect: project.aspect, styleId: project.styleId, note, templates: templates.get,
    });
    if (!result.plan) return { ok: false as const, errors: result.errors };
    if (validateOnly) return { ok: true as const, validateOnly: true as const, plan: result.plan, errors: [] as string[] };
    const saved = commitPlan(projectId, result.plan, 'waiting_approval');
    resolveMarksFrom(projectId, result.plan.changes ?? []);
    return { ok: true as const, validateOnly: false as const, plan: result.plan, project: saved, errors: [] as string[] };
  }

  // ── Dựng nhanh ──

  /** Music level against the voice from the profile's mix targets (the composition's default). */

  /**
   * After analyze, with project.quick: the machine plan from the owner's settings. mode ai: it is the fallback
   * the director refines next (returns true: run the turn); mode manual: it is the plan, straight to the editor.
   */
  async function quickStart(projectId: string): Promise<boolean> {
    const project = requireProject(projectId);
    const quick = project.quick;
    if (!quick) throw new Error('Chưa có cài đặt Dựng nhanh. Bấm AI edit lại.');
    const ctx = planContext(projectId);
    if (!ctx) throw new Error('Chưa có bản chép lời. Chạy bước Chép lời trước.');
    const profile = store.getProfile(project.profileId);
    const template = templates.get(quick.templateId);
    const style = VIDEO_STYLES.find((s) => s.id === (template?.styleId ?? project.styleId)) ?? null;
    let musicId = quick.music.mode === 'pick' ? quick.music.assetId : undefined;
    if (quick.mode === 'manual' && quick.music.mode === 'ai') {
      // No director to choose: the best song of the shortlist for the template's mood.
      try { musicId = (await tools.shortlist(projectId)).music.find((m) => m.source !== 'pexels' && m.source !== 'pexels-photo')?.ref; }
      catch { /* no music then; the owner can add one in the editor */ }
    }
    const base = autoPlan({
      transcript: ctx.transcript, analysis: ctx.analysis, project, profile: { keepWords: profile?.keepWords ?? [] }, style, version: nextVersion(projectId),
    });
    const title = project.title && project.title !== 'Việc mới' ? project.title : spokenTitle(ctx.transcript);
    const machine = applyQuickSettings(base, quick, template, ctx, {
      title, manual: quick.mode === 'manual', ...(musicId ? { music: { assetId: musicId, gainDb: 0 } } : {}),
    });
    // Elements the owner added to an earlier version stay.
    const previous = project.planVersion > 0 ? store.loadPlan(projectId, project.planVersion) : null;
    const plan = preserveOwnerElements(previous, machine, ctx);
    logStep(projectId, 'direct', `bản máy dựng v${plan.version} theo mẫu ${quick.templateId}: ${r1(plan.sourceDurationSec)}s → ${r1(plan.outputDurationSec)}s, bỏ ${plan.cutWords.length} từ`);
    if (quick.mode === 'ai') {
      commitPlan(projectId, plan, 'draft');
      setProjectStatus(projectId, 'working');
      return true;
    }
    commitPlan(projectId, plan, 'waiting_approval');
    setStep(projectId, 'direct', {
      status: 'done', error: null,
      summary: `v${plan.version} · ${fmtDur(plan.sourceDurationSec)} → ${fmtDur(plan.outputDurationSec)} · bạn tự chỉnh tay`,
    });
    await parkForApproval(projectId);
    return false;
  }

  /**
   * Dựng nhanh, after a plan turn handed in a new version: owner elements it dropped go back in, then the Asset
   * Hub fills the B-roll slots that only carry a `query`. The result replaces that version in place.
   */
  async function finishQuickPlan(projectId: string, versionBefore: number, signal: AbortSignal): Promise<void> {
    const project = store.loadProject(projectId);
    if (!project?.quick || project.planVersion === versionBefore || signal.aborted) return;
    const ctx = planContext(projectId);
    const current = store.loadPlan(projectId, project.planVersion);
    if (!ctx || !current) return;
    const previous = versionBefore > 0 ? store.loadPlan(projectId, versionBefore) : null;
    let plan = preserveOwnerElements(previous, current, ctx);
    const open = plan.brolls.filter((b) => b.enabled && b.query && !b.assetId).length;
    if (open) {
      logStep(projectId, 'direct', `tìm cảnh trám cho ${open} chỗ`);
      try {
        const res = await tools.resolveBrolls(projectId, plan);
        plan = res.plan;
        for (const note of res.notes) logStep(projectId, 'direct', note);
      } catch (err) {
        logStep(projectId, 'direct', `chưa tìm được cảnh trám: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
    }
    if (plan !== current && !signal.aborted) commitPlan(projectId, plan, project.planStatus ?? 'waiting_approval');
  }

  // ── Director turns ──

  /**
   * Start an agent turn. Busy flips synchronously (a second request cannot slip in); the turn
   * itself runs in the background and its reply arrives as a chat message over SSE.
   */
  function beginTurn(projectId: string, reason: TurnReason, note?: string, attachments?: DirectorTurnInput['attachments']): { agentMessageId: string; done: Promise<void> } {
    const project = requireProject(projectId);
    if (project.busy) throw new StoreError(409, 'Agent đang trả lời. Chờ xong hoặc bấm dừng.', 'busy');
    const busy = store.updateProject(projectId, (p) => { p.busy = true; })!;
    emitProject(busy);
    const agentMessageId = randomUUID();
    const done = runTurn(projectId, reason, note, agentMessageId, controllers.get(projectId), attachments);
    return { agentMessageId, done };
  }

  async function runTurn(projectId: string, reason: TurnReason, note: string | undefined, agentMessageId: string, outer?: AbortController, attachments?: DirectorTurnInput['attachments']): Promise<void> {
    const abort = outer ?? new AbortController();
    controllers.set(projectId, abort);
    const started = Date.now();
    const before = requireProject(projectId);
    const versionBefore = before.planVersion;
    // Sản xuất before the A-roll: storyboard turns, not edit-plan turns (no ticket step).
    const producing = before.mode === 'produce' && !before.source;
    const planTurn = reason !== 'chat' && reason !== 'produce' && !producing;
    if (planTurn) setStep(projectId, 'direct', { status: 'running', summary: null, error: null });

    let result: DirectorTurnResult;
    try {
      result = await tools.runDirector({
        projectId, reason, ...(note ? { note } : {}), ...(attachments?.length ? { attachments } : {}), abortController: abort,
        onDelta: (text) => emitVideoEvent(projectId, { type: 'message_delta', messageId: agentMessageId, text }),
        onActivity: (label, detail) => emitVideoEvent(projectId, { type: 'activity', messageId: agentMessageId, label, ...(detail ? { detail } : {}) }),
      });
    } catch (err) {
      result = { text: '', durationMs: Date.now() - started, activity: [], error: String((err as Error)?.message ?? err) };
    }
    // Still busy here, so the owner's plan ops cannot interleave with the B-roll search.
    if (planTurn) {
      try { await finishQuickPlan(projectId, versionBefore, abort.signal); }
      catch { /* project removed while the turn ran */ }
    }

    try {
      const failed = Boolean(result.error);
      appendMessage(projectId, {
        id: agentMessageId,
        role: 'agent',
        text: failed ? [result.text, `Lượt này gặp lỗi: ${result.error}`].filter(Boolean).join('\n\n') : result.text,
        durationMs: result.durationMs,
        ...(result.activity.length ? { activity: result.activity } : {}),
        ...(failed ? { error: true } : {}),
      });
    } catch { /* project removed while the turn ran */ }
    finally {
      controllers.delete(projectId);
      const project = store.updateProject(projectId, (p) => {
        p.busy = false;
        if (p.status === 'draft') p.status = 'working';
      });
      if (project) emitProject(project);
    }

    try { await afterTurn(projectId, reason, versionBefore, result); }
    catch { /* project removed */ }
  }

  /** After any turn: if a plan is waiting for the owner, park the ticket there (or auto-approve). */
  async function afterTurn(projectId: string, reason: TurnReason, versionBefore: number, result: DirectorTurnResult) {
    let project = store.loadProject(projectId);
    if (!project) return;
    if (project.mode === 'produce' && !project.source) return;
    if (reason === 'produce') return;
    if (project.mode === 'create') {
      const next = store.updateProject(projectId, p => {
        if (!p.creation || ['done', 'rendering'].includes(p.creation.state)) return;
        if (result.error) { p.creation.state = 'blocked'; p.creation.error = result.error; }
        else if (['planning', 'generating', 'brief'].includes(p.creation.state)) p.creation.state = 'waiting';
      });
      if (next) emitProject(next);
      return;
    }
    const changed = project.planVersion !== versionBefore;

    if (reason === 'plan' && !changed && project.planVersion > 0) {
      // The agent never submitted: the automatic plan stands, and the owner can still approve it.
      logStep(projectId, 'direct', result.error ? `Agent lỗi (${result.error.slice(0, 120)}) — dùng bản tự động v${project.planVersion}` : `Agent chưa gửi kế hoạch — dùng bản tự động v${project.planVersion}`);
      const plan = store.loadPlan(projectId, project.planVersion);
      if (plan) commitPlan(projectId, plan, 'waiting_approval');
      project = requireProject(projectId);
    }

    if (reason !== 'chat') {
      if (result.error && !changed) {
        setStep(projectId, 'direct', { status: 'failed', error: result.error, summary: null });
      } else if (changed || reason === 'plan') {
        const plan = project.plan ?? (project.planVersion ? store.loadPlan(projectId, project.planVersion) : null);
        setStep(projectId, 'direct', {
          status: 'done',
          summary: plan ? `v${plan.version} · ${fmtDur(plan.sourceDurationSec)} → ${fmtDur(plan.outputDurationSec)} · ${plan.author === 'agent' ? 'agent' : 'tự động'}` : 'Xong',
          error: null,
        });
      }
    }
    project = requireProject(projectId);
    if (reason !== 'chat' && !changed && project.planVersion > 0 && project.planStatus === 'draft') {
      // A revise/marks turn that ended without a new plan: the plan the owner last saw is waiting again.
      const plan = store.loadPlan(projectId, project.planVersion);
      if (plan) commitPlan(projectId, plan, 'waiting_approval');
      project = requireProject(projectId);
    }
    if (project.planStatus === 'waiting_approval') await parkForApproval(projectId);
  }

  async function parkForApproval(projectId: string) {
    const project = requireProject(projectId);
    if (project.quick) {
      // Dựng nhanh: no approval stop and no card (the profile's auto-approve does not apply); "Xuất" renders.
      setStep(projectId, 'approve', { status: 'waiting', summary: 'Mở editor để chỉnh, bấm Xuất khi xong' }, (p) => { p.status = 'waiting_approval'; });
      return;
    }
    const profile = store.getProfile(project.profileId);
    setStep(projectId, 'approve', { status: 'waiting', summary: profile?.autoApprovePlan ? 'Tự duyệt theo hồ sơ kênh' : 'Chờ bạn duyệt kế hoạch' },
      (p) => { p.status = 'waiting_approval'; });
    if (profile?.autoApprovePlan) {
      logStep(projectId, 'approve', 'hồ sơ kênh bật tự duyệt — duyệt luôn kế hoạch');
      await decide(projectId, 'approve');
      return;
    }
    try { await tools.requestApproval(projectId); }
    catch { /* the in-ticket button still works without the card */ }
  }

  // ── Decide ──

  async function decide(projectId: string, action: PlanDecisionAction, note?: string): Promise<{ project: VideoProject; job?: VideoJob }> {
    // Decided here (editor or card): no plan card for this project stays open.
    void import('../agent/approval-handler.js').then((m) => m.closeVideoPlanApprovals(projectId)).catch(() => {});
    const project = requireProject(projectId);
    if (project.planVersion < 1) throw new StoreError(409, 'Chưa có kế hoạch để duyệt.', 'no_plan');

    if (action === 'approve') {
      if (project.planStatus === 'rejected') throw new StoreError(409, 'Kế hoạch này đã bị bỏ. Nhờ agent lên kế hoạch mới.', 'rejected');
      const version = project.planVersion;
      const next = store.updateProject(projectId, (p) => {
        p.planStatus = 'approved';
        p.status = 'rendering';
        p.steps = p.steps.map((s) => {
          if (s.key === 'approve') return { key: 'approve' as const, status: 'done' as const, startedAt: s.startedAt, finishedAt: new Date().toISOString(), summary: `Đã duyệt v${version}`, ...(s.log ? { log: s.log } : {}) };
          if (SUB_STEPS.includes(s.key) || s.key === 'render' || s.key === 'cover' || s.key === 'deliver') return { key: s.key, status: 'pending' as const };
          return s;
        });
      })!;
      emitProject(next);
      for (const s of next.steps) emitVideoEvent(projectId, { type: 'step', step: s });
      const job = queue.enqueue('render', projectId, { version });
      return { project: next, job };
    }

    if (action === 'revise') {
      if (project.busy) throw new StoreError(409, 'Agent đang trả lời. Chờ xong hoặc bấm dừng.', 'busy');
      const text = note?.trim() || 'Chủ kênh bấm "Chỉnh lại", chưa nói cụ thể.';
      appendMessage(projectId, { role: 'user', text: `Chỉnh kế hoạch: ${text}` });
      const next = store.updateProject(projectId, (p) => {
        p.planStatus = 'draft';
        p.status = 'working';
        p.steps = p.steps.map((s) => (s.key === 'approve' ? { key: 'approve' as const, status: 'pending' as const } : s));
      })!;
      emitProject(next);
      const job = queue.enqueue('direct', projectId, { reason: 'revise', note: text });
      return { project: next, job };
    }

    const next = store.updateProject(projectId, (p) => {
      p.planStatus = 'rejected';
      p.status = 'working';
      p.steps = p.steps.map((s) => (s.key === 'approve' ? { key: 'approve' as const, status: 'skipped' as const, finishedAt: new Date().toISOString(), summary: 'Bạn đã bỏ kế hoạch này' } : s));
    })!;
    emitProject(next);
    emitVideoEvent(projectId, { type: 'step', step: next.steps.find((s) => s.key === 'approve')! });
    return { project: next };
  }

  // ── Job handlers ──

  const onProgress = (_job: unknown, ctx: Parameters<JobHandler>[1], projectId: string, key: StepKey) =>
    (f: number, message?: string) => {
      ctx.progress(f, message);
      stepProgress(projectId, key, f);
    };

  const handlers: Record<string, JobHandler> = {
    async 'create-render'(job, ctx) {
      const id = job.projectId;
      setStep(id, 'render', { status: 'running', progress: 0 });
      try {
        const record = await renderCreation(store, id, { signal: ctx.signal, progress: onProgress(job, ctx, id, 'render') });
        ctx.signal.throwIfAborted();
        const next = store.updateProject(id, p => {
          p.renders = [record]; p.outputs.final = true; p.status = 'done';
          p.creation!.state = 'done'; delete p.creation!.error;
        })!;
        emitProject(next);
        setStep(id, 'render', { status: 'done', progress: 1, summary: `MP4 · ${record.durationSec.toFixed(1)}s` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const next = store.updateProject(id, p => { p.status = 'failed'; p.creation!.state = 'blocked'; p.creation!.error = message; });
        if (next) emitProject(next);
        setStep(id, 'render', { status: 'failed', error: message }); throw error;
      }
    },
    async ingest(job, ctx) {
      const id = job.projectId;
      const project = requireProject(id);
      const raw = store.sourceFile(id);
      if (!raw || !project.source) throw new Error('Chưa có video để nhận. Tải video lên trước.');
      setStep(id, 'ingest', { status: 'running', summary: ingestSummary(project.source), error: null, progress: 0 });
      try {
        const out = await tools.normalize({
          raw, outDir: store.sourceDir(id), durationSec: project.source.durationSec, hasAudio: project.source.hasAudio,
          signal: ctx.signal, onProgress: onProgress(job, ctx, id, 'ingest'),
        });
        const size = (f: string) => formatSize(fs.statSync(f).size);
        logStep(id, 'ingest', `đã chuẩn hoá: master ${size(out.master)}, bản xem nhẹ ${size(out.proxy)}, âm thanh 16kHz mono`);
        if (out.hdr === 'tonemapped') logStep(id, 'ingest', 'video HDR: đã chuyển sang màu thường (SDR)');
        if (out.hdr === 'untouched') logStep(id, 'ingest', 'video HDR nhưng ffmpeg thiếu zimg: giữ nguyên màu, có thể bị gắt. Xem mục Kiểm tra máy.');
        setStep(id, 'ingest', { status: 'done', summary: `${ingestSummary(project.source)} · đã chuẩn hoá` });
      } catch (err) {
        if (!ctx.signal.aborted) stepFail(id, 'ingest', String((err as Error)?.message ?? err).slice(0, 300), 'failed');
        throw err;
      }
      if (job.args?.chain !== false) queue.enqueue('transcribe', id, { chain: true });
    },

    async transcribe(job, ctx) {
      const id = job.projectId;
      const project = requireProject(id);
      const profile = store.getProfile(project.profileId);
      const audio = store.audioFile(id);
      if (!fs.existsSync(audio) || !project.source) throw new Error('Chưa có âm thanh đã chuẩn hoá. Chạy lại bước Nhận video.');
      // Videos produced from a script (Video Studio › Sản xuất) already know every word and its time.
      const scripted = store.readTranscript(id);
      if (scripted?.model === 'script' && scripted.words.length) {
        logStep(id, 'transcribe', `${scripted.words.length} từ lấy từ kịch bản (không cần chép lời)`);
        setStep(id, 'transcribe', { status: 'done', summary: `${scripted.words.length} từ · từ kịch bản` });
        if (job.args?.chain !== false) queue.enqueue('analyze', id, { chain: true });
        return;
      }
      setStep(id, 'transcribe', { status: 'running', summary: null, error: null, progress: 0 });
      const started = Date.now();
      try {
        const transcript = await tools.transcribe({
          audio, durationSec: project.source.durationSec, keepWords: profile?.keepWords ?? [],
          signal: ctx.signal, onProgress: onProgress(job, ctx, id, 'transcribe'),
        });
        if (transcript.words.length === 0) throw new Error('Không nghe thấy lời nói trong video này.');
        store.writeTranscript(id, transcript);
        const kept = profile?.keepWords?.length ? ` · giữ nguyên ${profile.keepWords.length} từ khoá` : '';
        logStep(id, 'transcribe', `${transcript.words.length} từ trong ${r1((Date.now() - started) / 1000)}s (${transcript.model})${kept}`);
        setStep(id, 'transcribe', { status: 'done', summary: `${transcript.words.length} từ · ${transcript.language}` });
      } catch (err) {
        if (!ctx.signal.aborted) stepFail(id, 'transcribe', String((err as Error)?.message ?? err).slice(0, 300), 'failed');
        throw err;
      }
      if (job.args?.chain !== false) queue.enqueue('analyze', id, { chain: true });
    },

    async analyze(job, ctx) {
      const id = job.projectId;
      const project = requireProject(id);
      const transcript = store.readTranscript(id);
      if (!transcript) throw new Error('Chưa có bản chép lời. Chạy bước Chép lời trước.');
      setStep(id, 'analyze', { status: 'running', summary: null, error: null, progress: 0 });
      try {
        const analysis = await tools.analyze({
          transcript, audio: store.audioFile(id),
          video: fs.existsSync(store.proxyFile(id)) ? store.proxyFile(id) : store.masterFile(id),
          projectDir: store.projectDir(id), signal: ctx.signal, onProgress: onProgress(job, ctx, id, 'analyze'),
        });
        store.writeAnalysis(id, analysis);
        logStep(id, 'analyze', `${analysis.silences.length} chỗ lặng, ${analysis.fillers.length} từ đệm, ${analysis.retakes.length} câu nói lại, ${analysis.scenes.length} lần đổi cảnh`);
        const sounds = transcript.words.filter((w) => w.synthetic).length;
        if (sounds) logStep(id, 'analyze', `${sounds} tiếng không thành lời (máy đoán là từ đệm)`);
        logStep(id, 'analyze', `đã trích ${analysis.frames.length} khung hình${analysis.loudnessLufs !== undefined ? `, âm lượng gốc ${r1(analysis.loudnessLufs)} LUFS` : ''}`);
        setStep(id, 'analyze', {
          status: 'done',
          summary: `${analysis.silences.length} lặng · ${analysis.fillers.length} từ đệm · ${analysis.retakes.length} nói lại · ${analysis.frames.length} khung`,
        });
      } catch (err) {
        if (!ctx.signal.aborted) stepFail(id, 'analyze', String((err as Error)?.message ?? err).slice(0, 300), 'failed');
        throw err;
      }
      if (job.args?.chain === false) return;

      const fresh = requireProject(id);
      if (fresh.quick) {
        // Dựng nhanh: the owner already pressed AI edit while the video was being read.
        queue.enqueue('direct', id, { reason: 'plan', quick: true });
        return;
      }
      if (fresh.flow === 'quick') {
        // Dựng nhanh uploads while the owner is still setting up: the director starts on POST /ai-edit.
        setStep(id, 'direct', { status: 'waiting', summary: 'Chờ bạn bấm AI edit', error: null }, (p) => { if (p.status === 'draft') p.status = 'working'; });
        return;
      }

      // Automatic plan v1 (cut words + gaps from the analysis); the agent refines it next.
      const analysisNow = store.readAnalysis(id);
      const profile = store.getProfile(project.profileId);
      const style = VIDEO_STYLES.find((s) => s.id === project.styleId) ?? null;
      const plan = autoPlan({
        transcript, analysis: analysisNow,
        project: fresh, profile: { keepWords: profile?.keepWords ?? [] }, style, version: nextVersion(id),
      });
      commitPlan(id, plan, 'draft');
      logStep(id, 'direct', `bản tự động v${plan.version}: ${r1(plan.sourceDurationSec)}s → ${r1(plan.outputDurationSec)}s, bỏ ${plan.cutWords.length} từ`);
      setProjectStatus(id, 'working');
      queue.enqueue('direct', id, { reason: 'plan' });
    },

    async direct(job) {
      const id = job.projectId;
      requireProject(id);
      const reason = (job.args?.reason as TurnReason | undefined) ?? 'plan';
      const note = typeof job.args?.note === 'string' ? job.args.note : undefined;
      // Dựng nhanh: the machine plan first; mode manual stops there.
      if (job.args?.quick) {
        try {
          if (!(await quickStart(id))) return;
        } catch (err) {
          stepFail(id, 'direct', String((err as Error)?.message ?? err).slice(0, 300));
          throw err;
        }
      }
      const { done } = beginTurn(id, reason, note);
      await done;
    },

    async render(job, ctx) {
      const id = job.projectId;
      const project = requireProject(id);
      const version = Number(job.args?.version) || project.planVersion;
      const plan = store.loadPlan(id, version);
      const profile = store.getProfile(project.profileId);
      const transcript = store.readTranscript(id);
      if (!plan || !profile || !transcript) throw new Error('Thiếu kế hoạch hoặc bản chép lời để xuất.');
      const style = VIDEO_STYLES.find((s) => s.id === project.styleId) ?? null;
      for (const key of SUB_STEPS) setStep(id, key, { status: 'running', summary: null, error: null });
      setStep(id, 'render', { status: 'running', summary: null, error: null, progress: 0 }, (p) => { p.status = 'rendering'; });
      try {
        const rec = await tools.render({
          store, project, profile, style, plan, transcript, resolver, signal: ctx.signal,
          onProgress: (f, message) => { ctx.progress(f, message); stepProgress(id, 'render', f); },
          log: (step, text) => logStep(id, step, text),
        });
        const enabledBrolls = plan.brolls.filter((b) => b.enabled).length;
        setStep(id, 'cut', { status: 'done', summary: `${r1(plan.sourceDurationSec)}s → ${r1(plan.outputDurationSec)}s · ${plan.keep.length} đoạn` });
        setStep(id, 'captions', { status: 'done', summary: `kiểu ${plan.captions.styleId} · ${plan.captions.maxWordsPerChunk} từ/cụm` });
        setStep(id, 'effects', { status: 'done', summary: `${plan.hook ? 'hook · ' : ''}${plan.overlays.length} hiệu ứng · ${enabledBrolls} B-roll` });
        setStep(id, 'audio', { status: 'done', summary: `${plan.music ? 'có nhạc' : 'không nhạc'} · ${plan.sfx.length} tiếng động · ${profile.audio.finalLufs} LUFS` });
        const { warnings: _w, qaFiles: _q, ...record } = rec;
        void _w; void _q;
        const next = store.updateProject(id, (p) => {
          p.renders = [...(p.renders ?? []).filter((r) => r.version !== record.version), record].sort((a, b) => a.version - b.version);
          p.outputs = { ...p.outputs, final: true };
        })!;
        emitProject(next);
        setStep(id, 'render', { status: 'done', summary: `v${record.version} · ${fmtDur(record.durationSec)} · ${formatSize(record.sizeBytes)}` });
      } catch (err) {
        const message = String((err as Error)?.message ?? err).slice(0, 400);
        for (const key of SUB_STEPS) setStep(id, key, { status: 'pending', summary: null });
        if (ctx.signal.aborted) setStep(id, 'render', { status: 'pending', summary: 'Đã dừng', error: null }, (p) => { p.status = 'waiting_approval'; });
        else stepFail(id, 'render', message, 'failed');
        throw err;
      }
      queue.enqueue('cover', id, { version });
    },

    async cover(job, ctx) {
      const id = job.projectId;
      const project = requireProject(id);
      const version = Number(job.args?.version) || project.planVersion;
      const plan = store.loadPlan(id, version);
      const profile = store.getProfile(project.profileId);
      if (!plan || !profile) throw new Error('Thiếu kế hoạch để làm ảnh bìa.');
      const style = VIDEO_STYLES.find((s) => s.id === project.styleId) ?? null;
      setStep(id, 'cover', { status: 'running', summary: null, error: null, progress: 0 });
      try {
        await tools.covers({
          store, project, profile, style, plan, resolver, signal: ctx.signal,
          onProgress: (f) => { ctx.progress(f); stepProgress(id, 'cover', f); },
        });
        logStep(id, 'cover', `3 ảnh bìa từ các khung ${plan.covers.slice(0, 3).map((c) => `${r1(c.frameAt)}s`).join(', ')}`);
        const next = store.updateProject(id, (p) => { p.outputs = { ...p.outputs, covers: 3 }; })!;
        emitProject(next);
        setStep(id, 'cover', { status: 'done', summary: '3 phương án' });
      } catch (err) {
        if (!ctx.signal.aborted) stepFail(id, 'cover', String((err as Error)?.message ?? err).slice(0, 300));
      }

      // Deliver: copy to the channel's folder when set, otherwise it waits for the owner to download.
      try {
        const out = tools.deliver(store, project, profile, plan, version);
        if (out) {
          logStep(id, 'deliver', `đã chép ${out.files.length} tệp vào ${out.dir}`);
          setStep(id, 'deliver', { status: 'done', summary: `Đã chép vào ${out.dir}` });
        } else {
          setStep(id, 'deliver', { status: 'waiting', summary: 'Tải video về hoặc đăng từ Content Studio' });
        }
      } catch (err) {
        stepFail(id, 'deliver', String((err as Error)?.message ?? err).slice(0, 300));
      }
      setProjectStatus(id, 'done');
    },
  };

  const queue: JobQueue = createJobQueue({
    file: path.join(root, 'jobs.json'),
    handlers: handlers as never,
    autoStart: opts.autoStart,
    onChange: (job) => emitVideoEvent(job.projectId, { type: 'job', job }),
    onInterrupted: (job) => {
      const key: StepKey | null = ({ ingest: 'ingest', transcribe: 'transcribe', analyze: 'analyze', direct: 'direct', render: 'render', cover: 'cover' } as Record<string, StepKey>)[job.kind] ?? null;
      try {
        if (!store.loadProject(job.projectId)) return;
        if (key) setStep(job.projectId, key, { status: 'failed', error: 'Bị gián đoạn do ứng dụng khởi động lại. Bấm chạy lại.' });
        if (job.kind === 'create-render') { const p = store.updateProject(job.projectId, p => { p.creation!.state = 'blocked'; p.creation!.error = 'Render bị gián đoạn. Tiếp tục agent để xuất lại từ file đã nhập.'; p.status = 'failed'; }); if (p) emitProject(p); }
        if (job.kind === 'render') setProjectStatus(job.projectId, 'failed');
      } catch { /* project gone */ }
    },
  });

  // ── Public API ──

  const pipeline = {
    queue,
    tools,
    resolver,
    decide,
    beginTurn,
    submitAgentPlan,
    commitPlan,
    nextVersion,
    setStep,
    logStep,
    setProjectStatus,
    appendMessage,
    planContext,
    /** Start the automatic chain for a freshly ingested source. */
    startChain(projectId: string): VideoJob {
      return queue.enqueue('ingest', projectId, { chain: true });
    },
    /**
     * Dựng nhanh (POST /ai-edit; project.quick already saved). Analyze done: the quick direct job now. Otherwise
     * the running chain goes the quick way after analyze, or it restarts from the first step not done.
     */
    startQuick(projectId: string): VideoJob {
      const project = requireProject(projectId);
      const status = (key: StepKey) => project.steps.find((s) => s.key === key)?.status;
      if (status('analyze') === 'done' && store.readTranscript(projectId) && store.readAnalysis(projectId)) {
        if (status('direct') === 'waiting') setStep(projectId, 'direct', { status: 'pending', summary: null });
        return queue.enqueue('direct', projectId, { reason: 'plan', quick: true });
      }
      const live = queue.list(projectId).find((j) => (j.status === 'queued' || j.status === 'running') && (j.kind === 'ingest' || j.kind === 'transcribe' || j.kind === 'analyze'));
      if (live) return live;
      if (status('ingest') !== 'done') return queue.enqueue('ingest', projectId, { chain: true });
      if (status('transcribe') !== 'done') return queue.enqueue('transcribe', projectId, { chain: true });
      return queue.enqueue('analyze', projectId, { chain: true });
    },
    /** Re-run one step. ingest and transcribe continue down the chain; analyze runs alone. */
    runStep(projectId: string, step: 'ingest' | 'transcribe' | 'analyze' | 'direct' | 'render' | 'cover', note?: string): VideoJob {
      const project = requireProject(projectId);
      switch (step) {
        case 'ingest': return queue.enqueue('ingest', projectId, { chain: true });
        case 'transcribe': return queue.enqueue('transcribe', projectId, { chain: true });
        case 'analyze': return queue.enqueue('analyze', projectId, { chain: false });
        case 'direct': return queue.enqueue('direct', projectId, { reason: 'plan', ...(note ? { note } : {}) });
        case 'render': return queue.enqueue('render', projectId, { version: project.planVersion });
        case 'cover': return queue.enqueue('cover', projectId, { version: project.planVersion });
      }
    },
    /** Marks → one agent turn; the marks flip to "sent". */
    sendMarks(projectId: string, extraNote?: string): { sent: VideoMark[]; job: VideoJob } {
      const project = requireProject(projectId);
      if (project.busy) throw new StoreError(409, 'Agent đang trả lời. Chờ xong hoặc bấm dừng.', 'busy');
      const marks = store.readMarks(projectId);
      const drafts = marks.filter((m) => m.status === 'draft');
      if (!drafts.length) throw new StoreError(409, 'Chưa có góp ý nào để gửi.', 'no_marks');
      for (const m of drafts) m.status = 'sent';
      store.writeMarks(projectId, marks);
      appendMessage(projectId, { role: 'user', text: `Gửi ${drafts.length} góp ý trên bản xem thử${extraNote?.trim() ? `: ${extraNote.trim()}` : ''}` });
      const job = queue.enqueue('direct', projectId, { reason: 'marks', ...(extraNote?.trim() ? { note: extraNote.trim() } : {}) });
      return { sent: drafts, job };
    },
    /** Stop the running agent turn and any job of the project. */
    abort(projectId: string): void {
      controllers.get(projectId)?.abort();
      queue.cancelProject(projectId);
    },
    /** New source uploaded: forget everything derived from the old one. */
    resetForNewSource(projectId: string): VideoProject | null {
      queue.cancelProject(projectId);
      store.clearDerived(projectId);
      const project = store.updateProject(projectId, (p) => {
        p.steps = p.steps.map((s) => (s.key === 'ingest' ? s : { key: s.key, status: s.status === 'unavailable' ? 'unavailable' : 'pending' }));
        p.planVersion = 0;
        delete p.plan;
        delete p.planStatus;
        delete p.renders;
        delete p.engineSessionId;
        p.outputs = {};
        p.status = 'working';
      });
      if (project) emitProject(project);
      return project;
    },
  };

  setActivePipeline(pipeline as never);
  if (opts.autoStart !== false) queue.start();
  return pipeline;
}

export type Pipeline = ReturnType<typeof createPipeline>;
