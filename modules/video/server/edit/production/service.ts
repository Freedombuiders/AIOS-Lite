/**
 * Production service: brief → storyboard → owner-approved scenes → A-roll → HyperFrames editor → publish.
 *
 * Every production is hosted by one VideoProject (mode 'produce'): its chat, the director's turns, the
 * finishing plan, renders and publishing all live on that project, so the existing turn/SSE/approval
 * machinery serves the whole lifecycle. production.json keeps the storyboard.
 *
 * Spend rule (owner decision 2026-10-20, "duyệt theo lô"): nothing is generated without an approved
 * 'video_generate' card. The card carries a fingerprint of the batch; any change to those scenes voids it.
 *
 * One promise chain per production keeps edits, starts, polls and approvals from racing. Slow work
 * (provider calls, downloads, ffmpeg) runs outside the chain: a scene that is queued or running cannot
 * be edited or deleted, so only the read-modify-write steps need the lock.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { AgentRunner } from '../../kol-port.js';
import { emitVideoEvent } from '../events.js';
import type { Pipeline } from '../pipeline/runner.js';
import type { VideoEditStore } from '../store.js';
import type { MediaInfo, Transcript, VideoAspect, VideoMessage, VideoProject } from '../types.js';
import { assembleProduction } from './assemble.js';
import { contactSheet, isRealPerson, pollScene, sceneProblem, sourceFor, startScene, type EngineDeps, type PollResult, type StartResult } from './engines.js';
import { describeEstimate, estimateScenes, sceneFingerprint } from './estimate.js';
import { clampDuration, makeScene, type NewScene } from './store.js';
import type { CostEstimate, Production, ProductionScene, ProductionScript } from './types.js';
import { ENGINES_FOR } from './types.js';
import { pickEngine, writeStoryboard, type EngineAvailability } from './writer.js';

export interface HandoffDeps {
  editStore: VideoEditStore;
  pipeline: Pipeline;
  probe: (file: string) => Promise<MediaInfo>;
  thumbnail: (src: string, dest: string, durationSec: number) => Promise<void>;
  emitProject: (p: VideoProject) => void;
  defaultAgentId: () => string;
}

/** The approvals system as the service sees it (real one in approval.ts; a fake in tests). */
export interface ApprovalPort {
  request(input: { productionId: string; projectId: string; agentId: string; title: string; summary: string; sceneIds: string[]; fingerprint: string }): { approvalId: string };
  expire(approvalId: string): void;
  /** The card's current status ('pending', 'deciding', 'executed', 'rejected', 'expired', …); null when it no longer exists. */
  status?(approvalId: string): string | null;
}

export interface ProductionServiceOptions {
  engines: EngineDeps;
  handoff: HandoffDeps;
  approvals: ApprovalPort;
  writer?: AgentRunner;
  priceOverrides?: () => Record<string, number>;
  /**
   * Wakes the director on the host project. Return false when it could not start (host busy): the
   * service keeps the note and retries on the next background round. Default: a 'produce' turn when idle.
   */
  wake?: (projectId: string, note: string) => boolean | void;
}

export type SceneView = ProductionScene & { problem: string | null };
export type ProductionView = Omit<Production, 'scenes'> & { scenes: SceneView[] };

/** What an edit may change on a scene (owner UI, director tools). */
export type SceneEdit = Partial<Pick<ProductionScene, 'kind' | 'kolId' | 'text' | 'visual' | 'engine' | 'model' | 'sourceAssetId' | 'clipAssetId' | 'durationSec'>>;

const STARTABLE = new Set<ProductionScene['status']>(['draft', 'failed', 'done']);

/** Provider jobs still unresolved after this long are reported as failed (never resubmitted). */
const MAX_POLL_MS: Record<string, number> = { heygen: 45 * 60_000, 'veo-broll': 30 * 60_000, kol: 90 * 60_000 };
/** Consecutive poll errors (≈ 8 s apart) before a scene is reported as failed. */
const MAX_POLL_ERRORS = 15;
const PROVIDER_LABEL: Record<string, string> = { heygen: 'HeyGen', 'veo-broll': 'Veo', kol: 'KOL Studio', rocketflow: 'RocketFlow' };
/** A queued wake older than this is dropped (the owner already saw the system message). */
const WAKE_TTL_MS = 30 * 60_000;
/**
 * Provider overload ("high demand", 429/503): the request was refused, nothing was generated or billed.
 * The approved scene retries by itself with these waits (≈ 27 minutes in all) instead of asking again.
 */
const RETRY_DELAYS_MS = [60_000, 3 * 60_000, 8 * 60_000, 15 * 60_000];
const TRANSIENT = /high demand|overloaded|try again later|temporarily unavailable|\bUNAVAILABLE\b|RESOURCE_EXHAUSTED|\b(?:429|503)\b|rate.?limit|quá tải/i;
const NOT_TRANSIENT = /safety|blocked|guardrail|likeness|policy|celebrity/i;
export const isTransientProviderError = (message: string) => TRANSIENT.test(message) && !NOT_TRANSIENT.test(message);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
const contentKey = (s: ProductionScene) => JSON.stringify([s.kind, s.kolId, s.text, s.visual, s.engine, s.model, s.sourceAssetId, s.clipAssetId]);
const busyScene = (s: ProductionScene) => s.status === 'queued' || s.status === 'running';

export function createProductionService(opts: ProductionServiceOptions) {
  const { engines, handoff: h, approvals } = opts;
  const store = engines.store;
  const chains = new Map<string, Promise<unknown>>();
  const polling = new Set<string>();
  const assembling = new Set<string>();
  const writing = new Set<string>();
  const pollErrors = new Map<string, { n: number; last: string }>();
  const pendingWakes = new Map<string, { note: string; at: number }>();
  const retryNotice = new Map<string, number>();

  function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(id) ?? Promise.resolve();
    const next = prev.then(fn);
    // The chain only waits for settlement; the caller handles the result or the error.
    const settled = next.then(() => undefined, () => undefined);
    chains.set(id, settled);
    void settled.then(() => { if (chains.get(id) === settled) chains.delete(id); });
    return next;
  }

  const voices = () => store.voices();
  const overrides = () => opts.priceOverrides?.() ?? {};

  function view(p: Production): ProductionView {
    const v = voices();
    return { ...p, scenes: p.scenes.map((s) => ({ ...s, problem: s.status === 'done' || busyScene(s) ? null : sceneProblem(s, engines, v) })) };
  }

  function emit(p: Production): ProductionView {
    const out = view(p);
    emitVideoEvent(p.id, { type: 'production', production: out });
    if (p.projectId && p.projectId !== p.id) emitVideoEvent(p.projectId, { type: 'production', production: out });
    return out;
  }

  function availability(): EngineAvailability {
    return {
      heygen: engines.heygen.configured(), veo: engines.kol.ready('gemini'), fal: engines.kol.ready('fal'),
      rocketflow: engines.rocketInstalled(), stock: engines.stock?.configured() ?? false,
    };
  }

  function sceneOf(p: Production, sceneId: string): ProductionScene {
    const s = p.scenes.find((x) => x.id === sceneId);
    if (!s) throw new Error('Không tìm thấy cảnh này.');
    return s;
  }

  function settle(p: Production): void {
    const busy = p.scenes.some(busyScene);
    if (p.state === 'generating' && !busy) p.state = p.scenes.length && p.scenes.every((s) => s.status === 'done') ? 'ready' : 'storyboard';
  }

  /** After an edit: ready when every scene is done, else storyboard (generation/finishing states stay). */
  function restate(p: Production): void {
    if (p.state === 'generating' || p.state === 'assembling' || p.state === 'finishing') return;
    if (p.state === 'failed') p.error = null;
    p.state = p.scenes.length && p.scenes.every((s) => s.status === 'done') ? 'ready' : p.scenes.length ? 'storyboard' : 'brief';
  }

  /** A storyboard change voids the pending spend approval (its fingerprint no longer matches). */
  function voidApproval(p: Production): void {
    if (!p.pendingApproval) return;
    try { approvals.expire(p.pendingApproval.approvalId); } catch { /* already decided */ }
    p.pendingApproval = null;
  }

  /** Keeps a scene's engine valid for its kind, choosing the best connected one when it is not. */
  function fixEngine(p: Production, s: ProductionScene): void {
    if (ENGINES_FOR[s.kind].includes(s.engine)) return;
    s.engine = s.kind === 'clip' ? 'clip' : pickEngine(s.kind, s.text, s.kolId, availability(), voices(), isRealPerson(s.kolId, engines));
    void p;
  }

  /**
   * Clip scenes: an id given as the face (a common slip) is the clip, and a newly chosen clip plays in
   * full unless a length was given (a shorter length trims it when it lands).
   */
  function normalizeClip(s: ProductionScene, input: { clipAssetId?: string | null; sourceAssetId?: string | null; durationSec?: number }, prevClip: string | null): void {
    if (s.kind !== 'clip') return;
    if (!s.clipAssetId && s.sourceAssetId) { s.clipAssetId = s.sourceAssetId; s.sourceAssetId = null; }
    if (s.clipAssetId && s.clipAssetId !== prevClip && input.durationSec === undefined) {
      try { const sec = engines.kol.videoFile(s.clipAssetId).durationSec; if (sec) s.durationSec = clampDuration(sec); } catch { /* reported as a problem */ }
    }
  }

  /**
   * Applies an edit to one scene. A change to what gets generated makes the scene a new draft and voids
   * a pending approval for it. A shorter length on a finished take is a re-trim, not a new take.
   */
  function applySceneEdit(p: Production, s: ProductionScene, input: SceneEdit): void {
    if (busyScene(s)) throw new Error('Cảnh đang được tạo, chưa sửa được.');
    const before = contentKey(s);
    const beforeSec = s.durationSec;
    const beforeClip = s.clipAssetId;
    if (input.kind !== undefined) s.kind = input.kind;
    if (input.kolId !== undefined) s.kolId = input.kolId;
    if (input.text !== undefined) s.text = input.text.trim().slice(0, 2000);
    if (input.visual !== undefined) s.visual = input.visual.trim().slice(0, 1200);
    if (input.engine !== undefined) s.engine = input.engine;
    if (input.model !== undefined) s.model = input.model;
    if (input.sourceAssetId !== undefined) s.sourceAssetId = input.sourceAssetId;
    if (input.clipAssetId !== undefined) s.clipAssetId = input.clipAssetId;
    if (input.durationSec !== undefined) s.durationSec = clampDuration(input.durationSec);
    fixEngine(p, s);
    normalizeClip(s, input, beforeClip);
    let retake = contentKey(s) !== before;
    if (!retake && s.durationSec !== beforeSec && s.output && s.kind !== 'talking') {
      const room = (s.output.sourceSec ?? s.output.durationSec) - (s.trimStart ?? 0);
      if (s.durationSec <= room + 0.05) s.output = { ...s.output, durationSec: round3(Math.min(room, s.durationSec)) };
      else retake = true;
    }
    if (retake && s.status !== 'draft') { s.status = 'draft'; s.output = null; s.error = null; s.job = null; s.trimStart = 0; }
    if ((retake || s.durationSec !== beforeSec) && p.pendingApproval?.sceneIds.includes(s.id)) voidApproval(p);
    s.updatedAt = new Date().toISOString();
  }

  /** Turns a refused-for-overload scene back into "queued" with a due time; false when it should fail. */
  function scheduleRetry(s: ProductionScene, error: string): boolean {
    const n = (s.retry?.n ?? 0) + 1;
    if (!isTransientProviderError(error) || n > RETRY_DELAYS_MS.length) return false;
    const at = new Date(Date.now() + RETRY_DELAYS_MS[n - 1]).toISOString();
    const name = s.engine === 'heygen' ? 'HeyGen' : s.engine === 'fal' ? 'fal' : s.engine === 'rocketflow' ? 'Google Flow' : 'Veo';
    s.status = 'queued'; s.job = null; s.retry = { n, at };
    s.error = `${name} đang quá tải, chưa tạo gì. Tự thử lại lúc ${hhmm(at)} (lần ${n + 1}/${RETRY_DELAYS_MS.length + 1}), không cần duyệt lại.`;
    return true;
  }

  function noticeRetries(p: Production): void {
    const waiting = p.scenes.filter((s) => s.status === 'queued' && s.retry);
    if (!waiting.length || Date.now() - (retryNotice.get(p.id) ?? 0) < 3 * 60_000) return;
    retryNotice.set(p.id, Date.now());
    hostMessage(p.projectId, `Nhà cung cấp đang quá tải nên ${waiting.length} cảnh chưa tạo được (chưa tính phí). Hệ thống tự thử lại sau ít phút, không cần duyệt lại. Bấm "Dừng tự thử lại" nếu muốn dừng.`);
  }

  function hostMessage(projectId: string | null, text: string, card?: VideoMessage['card']): void {
    if (!projectId) return;
    try { h.pipeline.appendMessage(projectId, { role: 'system', text, ...(card ? { card } : {}) }); } catch { /* host removed */ }
  }

  function tryWake(projectId: string, note: string): boolean {
    if (opts.wake) return opts.wake(projectId, note) !== false;
    try {
      const host = h.editStore.loadProject(projectId);
      if (!host) return true;
      if (host.busy) return false;
      h.pipeline.beginTurn(projectId, 'produce' as never, note);
      return true;
    } catch { return false; }
  }

  /** Wakes the director now, or as soon as the host project is free. */
  function wake(projectId: string | null, note: string): void {
    if (!projectId) return;
    if (!tryWake(projectId, note)) pendingWakes.set(projectId, { note, at: Date.now() });
    else pendingWakes.delete(projectId);
  }

  function flushWakes(): void {
    for (const [projectId, w] of [...pendingWakes]) {
      if (Date.now() - w.at > WAKE_TTL_MS) { pendingWakes.delete(projectId); continue; }
      if (tryWake(projectId, w.note)) pendingWakes.delete(projectId);
    }
  }

  // ── Host project ──

  function ensureHostSync(id: string): Production {
    const p = store.require(id);
    if (p.projectId && h.editStore.loadProject(p.projectId)) return p;
    // Legacy productions finished before hosting existed adopt their finishing project.
    const adopt = p.finishProjectId ? h.editStore.loadProject(p.finishProjectId) : null;
    let projectId: string;
    if (adopt) {
      h.editStore.updateProject(adopt.id, (x) => { x.mode = 'produce'; x.productionId = p.id; });
      projectId = adopt.id;
    } else {
      const profile = h.editStore.listProfiles()[0] ?? h.editStore.createProfile({ name: 'Video Studio' });
      const host = h.editStore.createProject({ profileId: profile.id, title: p.title, aspect: p.aspect, agentId: h.defaultAgentId() });
      const next = h.editStore.updateProject(host.id, (x) => { x.mode = 'produce'; x.productionId = p.id; })!;
      h.emitProject(next);
      projectId = host.id;
    }
    return store.update(id, (x) => { x.projectId = projectId; });
  }

  // ── Spend approval ──

  function estimateFor(p: Production, sceneIds?: string[]): { targets: ProductionScene[]; estimate: CostEstimate } {
    const targets = p.scenes.filter((s) => (sceneIds?.length ? sceneIds.includes(s.id) : s.status === 'draft' || s.status === 'failed'));
    return { targets, estimate: estimateScenes(targets, overrides()) };
  }

  const fingerprintOf = (p: Production, targets: ProductionScene[]) => sceneFingerprint(targets, { aspect: p.aspect, voices: voices() });

  function approvalSummary(p: Production, targets: ProductionScene[], estimate: CostEstimate): { title: string; summary: string } {
    const kolName = (id: string | null) => (id ? engines.kol.persona(id)?.name ?? 'KOL' : 'không có KOL');
    const lines = targets.slice(0, 12).map((s) => {
      const i = p.scenes.indexOf(s) + 1;
      const what = s.kind === 'talking' ? `${kolName(s.kolId)} nói "${s.text.slice(0, 70)}${s.text.length > 70 ? '…' : ''}"` : s.visual.slice(0, 80) || 'B-roll';
      return `${i}. ${what} · ${s.engine}`;
    });
    if (targets.length > 12) lines.push(`… và ${targets.length - 12} cảnh nữa`);
    lines.push(`Chi phí: ${describeEstimate(estimate)}`);
    return { title: `Duyệt tạo ${targets.length} cảnh · ${p.title}`.slice(0, 160), summary: lines.join('\n').slice(0, 1400) };
  }

  async function afterSettle(before: Production['state'], p: Production): Promise<void> {
    if (before !== 'generating' || p.state === 'generating') return;
    const total = p.scenes.length;
    const done = p.scenes.filter((s) => s.status === 'done').length;
    const failed = p.scenes.filter((s) => s.status === 'failed');
    const drafts = p.scenes.filter((s) => s.status === 'draft').length;
    const parts = [done === total ? `Đã tạo xong cả ${total} cảnh. Sẵn sàng hoàn thiện với HyperFrames.` : `Lô vừa duyệt đã chạy xong: ${done}/${total} cảnh đã có video.`];
    if (failed.length) parts.push(`${failed.length} cảnh lỗi: ${failed.map((s) => `cảnh ${p.scenes.indexOf(s) + 1} (${s.error ?? 'không rõ'})`).join('; ')}.`);
    if (drafts) parts.push(`Còn ${drafts} cảnh chưa tạo.`);
    const text = parts.join(' ');
    hostMessage(p.projectId, text);
    wake(p.projectId, `[Hệ thống] ${text} Xem từng cảnh vừa tạo bằng produce_inspect_scene (đúng mặt KOL, đúng mô tả, không lỗi hình, độ dài hợp lý), cắt bớt bằng produce_trim_scene nếu cần, rồi báo chủ kênh ngắn gọn và đề xuất bước tiếp theo (tạo lại cảnh chưa đạt phải xin duyệt; nếu đủ cảnh thì đề nghị hoàn thiện).`);
  }

  /** Starts one approved scene: the provider call runs outside the lock (a queued scene is frozen). */
  async function startOne(id: string, sceneId: string): Promise<void> {
    const snap = await locked(id, async () => {
      const p = store.get(id);
      const s = p?.scenes.find((x) => x.id === sceneId);
      return p && s && s.status === 'queued' ? { p, s } : null;
    });
    if (!snap) return;
    let result: StartResult | null = null;
    let error = '';
    try { result = await startScene(snap.p, snap.s, engines, voices()); } catch (err) { error = errText(err); }
    await locked(id, async () => {
      const cur = store.get(id);
      const s0 = cur?.scenes.find((x) => x.id === sceneId);
      if (!cur || !s0 || s0.status !== 'queued') return;
      const before = cur.state;
      const p = store.update(id, (x) => {
        const s = sceneOf(x, sceneId);
        if (result && 'job' in result) { s.status = 'running'; s.job = result.job; s.output = null; s.error = null; }
        else if (result) { s.status = 'done'; s.output = result.output; s.job = null; s.error = null; s.trimStart = 0; s.retry = null; }
        else if (!scheduleRetry(s, error)) { s.status = 'failed'; s.error = error.slice(0, 400); s.job = null; s.retry = null; }
        s.updatedAt = new Date().toISOString();
        settle(x);
      });
      emit(p);
      noticeRetries(p);
      await afterSettle(before, p);
    });
  }

  function timeoutMessage(provider: string, startedAt: string): string {
    const min = Math.round((Date.now() - Date.parse(startedAt)) / 60_000);
    const name = PROVIDER_LABEL[provider] ?? provider;
    return `${name} chưa trả kết quả sau ${min} phút nên đã dừng theo dõi. Kiểm tra trên ${name} trước khi xin tạo lại (lần gửi này có thể đã tính phí).`;
  }

  const service = {
    view,
    get(id: string): ProductionView { return view(store.require(id)); },
    list: () => store.list(),
    availability,

    /** The production's cast as the director sees it: handle, HeyGen voice, images, brand kit, real person. */
    castOf(p: Pick<Production, 'cast'>) {
      const v = voices();
      return p.cast.map((id) => engines.kol.member(id, v)).filter((m): m is NonNullable<typeof m> => Boolean(m)).map((m) => ({
        id: m.id, name: m.name, handle: m.handle, voice: m.voice, images: m.images.length, videos: m.videos.length,
        realPerson: Boolean(m.realPerson), brand: store.brand(m.id),
      }));
    },

    /** Images and gallery videos of one KOL in the production (ids for face / clip picks). */
    media(id: string, kolId: string) {
      const p = store.require(id);
      if (!p.cast.includes(kolId)) throw new Error('KOL này không có trong video.');
      return engines.kol.media(kolId);
    },

    /** Every KOL the owner can call with @. */
    allCast() {
      return engines.kol.listCast(voices()).map((m) => ({ id: m.id, name: m.name, handle: m.handle }));
    },

    engineSummary() {
      const a = availability();
      return [
        { id: 'heygen', ready: a.heygen, use: 'KOL nói, giọng nhân bản, khớp khẩu hình, dài bao nhiêu cũng được. Bắt buộc cho KOL là người thật' },
        { id: 'veo', ready: a.veo, use: 'KOL ảo chuyển động hoặc B-roll AI; nói câu ngắn ≤ 200 ký tự ≤ 8s; khoảng $0,15/giây. Không dựng người thật' },
        { id: 'fal', ready: a.fal, use: 'KOL chuyển động bằng Kling/Seedance (cần KOL trong cảnh)' },
        { id: 'stock', ready: a.stock ?? false, use: 'B-roll quay thật miễn phí từ Pexels (không có KOL), mô tả bằng tiếng Anh; tự cắt đúng độ dài cảnh' },
        { id: 'rocketflow', ready: a.rocketflow, use: 'B-roll qua Google Flow' },
        { id: 'clip', ready: true, use: 'Video có sẵn trong thư viện KOL (miễn phí)' },
      ];
    },

    /** Creates the production and its host project. */
    create(input: { brief: string; cast: string[]; aspect: VideoAspect; targetSec: number; title?: string; series?: Production['series'] }): ProductionView {
      const p = store.create(input);
      return emit(ensureHostSync(p.id));
    },

    ensureHost(id: string): ProductionView { return view(ensureHostSync(id)); },

    estimate(id: string, sceneIds?: string[]): CostEstimate {
      return estimateFor(store.require(id), sceneIds).estimate;
    },

    /** The lead KOL's brain writes script + scenes. The (slow) writer turn runs outside the lock. */
    async write(id: string): Promise<ProductionView> {
      if (writing.has(id)) throw conflict('Bộ não KOL đang viết kịch bản cho video này.');
      writing.add(id);
      try {
        const snap = await locked(id, async () => {
          const p = store.require(id);
          if (p.scenes.some(busyScene)) throw new Error('Đang tạo cảnh: chờ xong rồi mới viết lại kịch bản.');
          return p;
        });
        const cast = snap.cast.map((c) => engines.kol.persona(c)).filter((x): x is NonNullable<typeof x> => Boolean(x));
        const out = await writeStoryboard(snap, cast, availability(), voices(), opts.writer, snap.cast[0] ? store.brand(snap.cast[0]) : null);
        return await locked(id, async () => {
          const next = store.update(id, (x) => {
            if (x.scenes.some(busyScene)) throw new Error('Đang tạo cảnh: chờ xong rồi mới viết lại kịch bản.');
            voidApproval(x);
            x.script = out.script;
            if (!x.titleLocked) x.title = out.script.title || x.title;
            x.scenes = out.scenes;
            x.state = 'storyboard';
            x.error = null;
          });
          syncHostTitle(next);
          return emit(next);
        });
      } finally {
        writing.delete(id);
      }
    },

    isWriting: (id: string) => writing.has(id),

    /** A storyboard write that outlived the director's tool call: report it in the chat and wake the director. */
    backgroundWrite(id: string, job: Promise<ProductionView>): void {
      void job.then(
        (v) => {
          hostMessage(v.projectId, `Bộ não KOL đã viết xong kịch bản: ${v.scenes.length} cảnh.`);
          wake(v.projectId, '[Hệ thống] Kịch bản đã viết xong. Gọi produce_context, tinh chỉnh nếu cần, ước tính chi phí rồi xin duyệt một lần.');
        },
        (err) => {
          const p = store.get(id);
          if (p) hostMessage(p.projectId, `Bộ não KOL không viết được kịch bản: ${errText(err)}`.slice(0, 500));
        },
      );
    },

    /**
     * The director's storyboard: script and the full ordered scene list. A scene passed with its id is
     * merged (fields left out keep their value; an unchanged scene keeps its finished take).
     */
    async setStoryboard(id: string, input: { script?: Partial<ProductionScript>; scenes: (NewScene & { id?: string })[] }): Promise<ProductionView> {
      return locked(id, async () => {
        const next = store.update(id, (p) => {
          if (p.scenes.some(busyScene)) throw new Error('Đang tạo cảnh: chờ xong rồi mới đổi phân cảnh.');
          if (input.script) p.script = { title: input.script.title ?? p.script?.title ?? p.title, hook: input.script.hook ?? p.script?.hook ?? '', caption: input.script.caption ?? p.script?.caption ?? '', hashtags: input.script.hashtags ?? p.script?.hashtags ?? [] };
          if (input.script?.title && !p.titleLocked) p.title = input.script.title.slice(0, 90);
          const kept = new Set<string>();
          const scenes = input.scenes.map((s) => {
            const old = s.id ? p.scenes.find((x) => x.id === s.id) : undefined;
            if (!old || kept.has(old.id)) {
              const fresh = makeScene(s);
              fixEngine(p, fresh);
              normalizeClip(fresh, s, null);
              return fresh;
            }
            kept.add(old.id);
            const { id: _id, ...edit } = s;
            applySceneEdit(p, old, edit);
            return old;
          });
          // Removing or adding scenes changes the batch: a pending card is void unless its scenes all survive unchanged.
          if (p.pendingApproval && !p.pendingApproval.sceneIds.every((sid) => kept.has(sid))) voidApproval(p);
          p.scenes = scenes;
          restate(p);
        });
        syncHostTitle(next);
        return emit(next);
      });
    },

    async patch(id: string, input: { title?: string; brief?: string; cast?: string[]; aspect?: VideoAspect; targetSec?: number }): Promise<ProductionView> {
      return locked(id, async () => {
        const next = store.update(id, (p) => {
          if (input.title !== undefined && input.title.trim()) { p.title = input.title.trim().slice(0, 90); p.titleLocked = true; }
          if (input.brief !== undefined) p.brief = input.brief.trim().slice(0, 6000);
          if (input.cast !== undefined) p.cast = [...new Set(input.cast)].slice(0, 6);
          if (input.aspect !== undefined && input.aspect !== p.aspect) {
            if (p.scenes.some((s) => s.status === 'done' || busyScene(s))) throw conflict('Đã có cảnh được tạo theo khung hiện tại: không đổi khung hình được nữa.');
            p.aspect = input.aspect;
            voidApproval(p);
          }
          if (input.targetSec !== undefined) p.targetSec = Math.min(180, Math.max(5, Math.round(input.targetSec)));
        });
        syncHostTitle(next);
        return emit(next);
      });
    },

    async addScene(id: string, input: NewScene, at?: number): Promise<ProductionView> {
      return locked(id, async () => emit(store.update(id, (p) => {
        const scene = makeScene(input);
        fixEngine(p, scene);
        normalizeClip(scene, input, null);
        const i = at === undefined ? p.scenes.length : Math.max(0, Math.min(p.scenes.length, at));
        p.scenes.splice(i, 0, scene);
        restate(p);
      })));
    },

    async patchScene(id: string, sceneId: string, input: SceneEdit): Promise<ProductionView> {
      return locked(id, async () => emit(store.update(id, (p) => {
        applySceneEdit(p, sceneOf(p, sceneId), input);
        restate(p);
      })));
    },

    /** Re-trims a finished take (start inside the file, length that plays). Never regenerates or spends. */
    async trimScene(id: string, sceneId: string, input: { start?: number; durationSec?: number }): Promise<ProductionView> {
      return locked(id, async () => emit(store.update(id, (p) => {
        const s = sceneOf(p, sceneId);
        if (s.status !== 'done' || !s.output) throw new Error('Chỉ cắt được cảnh đã tạo xong.');
        const total = s.output.sourceSec ?? s.output.durationSec + (s.trimStart ?? 0);
        const start = Math.min(Math.max(0, input.start ?? s.trimStart ?? 0), Math.max(0, total - 0.5));
        const dur = Math.min(Math.max(0.5, input.durationSec ?? s.output.durationSec), total - start);
        s.trimStart = round3(start);
        s.output = { ...s.output, durationSec: round3(dur), sourceSec: round3(total) };
        if (s.kind !== 'talking') s.durationSec = clampDuration(dur);
        s.updatedAt = new Date().toISOString();
      })));
    },

    /** What the director looks at to judge a take: a strip of frames plus the numbers and the captions. */
    async inspectScene(id: string, sceneId: string): Promise<{ info: Record<string, unknown>; image: string | null }> {
      const p = store.require(id);
      const s = sceneOf(p, sceneId);
      if (!s.output) throw new Error(s.status === 'running' || s.status === 'queued' ? 'Cảnh đang được tạo, chưa có video để xem.' : 'Cảnh này chưa có video để xem.');
      const file = path.join(store.scenesDir(id), path.basename(s.output.file));
      const sheet = store.sceneFile(id, sceneId, 'sheet.jpg');
      let image: string | null = null;
      try {
        await (engines.sheet ?? ((f, d, sec, start) => contactSheet(f, d, sec, { start })))(file, sheet, s.output.durationSec, s.trimStart ?? 0);
        image = fs.readFileSync(sheet).toString('base64');
      } catch { /* the numbers still help */ }
      let captions: string | null = null;
      if (s.output.subtitles) {
        try { captions = fs.readFileSync(path.join(store.scenesDir(id), path.basename(s.output.subtitles)), 'utf8').slice(0, 1500); } catch { /* none */ }
      }
      return {
        info: {
          n: p.scenes.indexOf(s) + 1, kind: s.kind, engine: s.engine, take: s.take ?? 0,
          plannedSec: s.durationSec, playsSec: s.output.durationSec, sourceSec: s.output.sourceSec ?? null, trimStart: s.trimStart ?? 0,
          text: s.text, visual: s.visual, credit: s.output.credit ?? null, captions,
          frames: image ? 'Ảnh kèm theo: 4 khung hình cách đều từ trái sang phải.' : 'Không trích được khung hình.',
        },
        image,
      };
    },

    async moveScene(id: string, sceneId: string, to: number): Promise<ProductionView> {
      return locked(id, async () => emit(store.update(id, (p) => {
        const from = p.scenes.findIndex((s) => s.id === sceneId);
        if (from < 0) throw new Error('Không tìm thấy cảnh này.');
        const [s] = p.scenes.splice(from, 1);
        p.scenes.splice(Math.max(0, Math.min(p.scenes.length, to)), 0, s);
      })));
    },

    async removeScene(id: string, sceneId: string): Promise<ProductionView> {
      return locked(id, async () => emit(store.update(id, (p) => {
        const s = sceneOf(p, sceneId);
        if (busyScene(s)) throw new Error('Cảnh đang được tạo, chưa xoá được.');
        if (p.pendingApproval?.sceneIds.includes(sceneId)) voidApproval(p);
        p.scenes = p.scenes.filter((x) => x.id !== sceneId);
        settle(p);
        restate(p);
      })));
    },

    /**
     * Asks the owner to approve generating these scenes (default: every draft or failed scene).
     * Never generates. Scenes with a problem are refused with the reason. The face each scene uses is
     * pinned first, so the approved batch is exactly what will be generated.
     */
    async requestGeneration(id: string, sceneIds?: string[], by: 'owner' | 'agent' = 'owner'): Promise<{ production: ProductionView; approvalId: string; estimate: CostEstimate }> {
      return locked(id, async () => {
        let p = ensureHostSync(id);
        const wanted = estimateFor(p, sceneIds).targets;
        if (!wanted.length) throw new Error('Không có cảnh nào cần tạo.');
        const busy = wanted.filter(busyScene);
        if (busy.length) throw new Error(`Cảnh ${busy.map((s) => p.scenes.indexOf(s) + 1).join(', ')} đang được tạo.`);
        const v = voices();
        const problems = wanted.map((s) => [s, sceneProblem(s, engines, v)] as const).filter(([, pr]) => pr);
        if (problems.length) throw new Error(problems.map(([s, pr]) => `Cảnh ${p.scenes.indexOf(s) + 1}: ${pr}`).join(' · '));
        const ids = new Set(wanted.map((s) => s.id));
        p = store.update(id, (x) => {
          for (const s of x.scenes) {
            if (!ids.has(s.id) || s.sourceAssetId || !s.kolId || !['heygen', 'veo', 'fal', 'rocketflow'].includes(s.engine)) continue;
            try { s.sourceAssetId = sourceFor(s, engines, v); } catch { /* reported when the scene starts */ }
          }
        });
        const { targets, estimate } = estimateFor(p, [...ids]);
        const fingerprint = fingerprintOf(p, targets);
        const host = h.editStore.loadProject(p.projectId!);
        const { title, summary } = approvalSummary(p, targets, estimate);
        if (p.pendingApproval && p.pendingApproval.fingerprint !== fingerprint) voidApproval(p);
        const { approvalId } = approvals.request({
          productionId: p.id, projectId: p.projectId!, agentId: host?.agentId ?? h.defaultAgentId(),
          title, summary, sceneIds: targets.map((s) => s.id), fingerprint,
        });
        const fresh = p.pendingApproval?.approvalId !== approvalId;
        p = store.update(id, (x) => {
          x.pendingApproval = { approvalId, sceneIds: targets.map((s) => s.id), fingerprint, estimate, createdAt: new Date().toISOString() };
        });
        if (fresh) {
          hostMessage(p.projectId, `${by === 'agent' ? 'Đạo diễn AI' : 'Bạn'} đề xuất tạo ${targets.length} cảnh. ${describeEstimate(estimate)}. Chờ bạn duyệt (cũng có trong "Cần tôi" và Telegram).`, { type: 'generate_approval', approvalId });
        }
        return { production: emit(p), approvalId, estimate };
      });
    },

    /** Called by the approval handler when the owner approves. Queues the batch and starts it in the background. */
    async approveGeneration(payload: { productionId: string; approvalId: string; sceneIds: string[]; fingerprint: string }): Promise<{ queued: number }> {
      const queued = await locked(payload.productionId, async () => {
        const p = store.require(payload.productionId);
        if (p.pendingApproval?.approvalId !== payload.approvalId) {
          throw new Error('Thẻ duyệt này không còn hiệu lực (đã có thẻ mới hoặc phân cảnh đã đổi). Không tạo gì; hãy xin duyệt lại.');
        }
        const targets = p.scenes.filter((s) => payload.sceneIds.includes(s.id));
        if (targets.length !== payload.sceneIds.length || fingerprintOf(p, targets) !== payload.fingerprint) {
          throw new Error('Phân cảnh đã thay đổi sau khi xin duyệt. Hãy xin duyệt lại cho bản mới nhất.');
        }
        const startable = targets.filter((s) => STARTABLE.has(s.status));
        const next = store.update(p.id, (x) => {
          for (const s of x.scenes) {
            if (!startable.some((t) => t.id === s.id)) continue;
            s.status = 'queued'; s.error = null; s.job = null; s.retry = null; s.take = (s.take ?? 0) + 1; s.updatedAt = new Date().toISOString();
          }
          x.pendingApproval = null;
          x.state = 'generating';
          x.error = null;
        });
        emit(next);
        hostMessage(next.projectId, `Bạn đã duyệt. Đang tạo ${startable.length} cảnh…`);
        return startable.map((s) => s.id);
      });
      // Background: a failure is recorded on the scene; a deleted production simply stops the loop.
      void (async () => {
        for (const sceneId of queued) {
          try { await startOne(payload.productionId, sceneId); } catch { /* recorded on the scene, or the production is gone */ }
        }
      })().catch(() => undefined);
      return { queued: queued.length };
    },

    async rejectGeneration(productionId: string, approvalId: string): Promise<void> {
      await locked(productionId, async () => {
        const next = store.update(productionId, (x) => { if (x.pendingApproval?.approvalId === approvalId) x.pendingApproval = null; });
        emit(next);
        hostMessage(next.projectId, 'Bạn chưa duyệt tạo các cảnh này. Có thể sửa phân cảnh hoặc nhờ Đạo diễn AI đổi phương án rẻ hơn.');
      });
    },

    /**
     * One poll round for a production's running scenes. Provider calls and downloads run outside the
     * lock; results are applied only to scenes still running the same job. Saves and emits only on change.
     */
    async poll(id: string): Promise<ProductionView | null> {
      const p0 = store.get(id);
      if (!p0) return null;
      const running = p0.scenes.filter((s) => s.status === 'running' && s.job);
      if (!running.length || polling.has(id)) return view(p0);
      polling.add(id);
      try {
        const results: { sceneId: string; ref: string; r: PollResult | { transient: string } }[] = [];
        for (const scene of running) {
          try { results.push({ sceneId: scene.id, ref: scene.job!.ref, r: await pollScene(p0, scene, engines) }); }
          catch (err) { results.push({ sceneId: scene.id, ref: scene.job!.ref, r: { transient: errText(err) } }); }
        }
        return await locked(id, async () => {
          const cur = store.get(id);
          if (!cur) return null;
          const before = cur.state;
          // final: the job may still be alive at the provider (lost track / too slow): report, never resubmit.
          const changes = new Map<string, { output: NonNullable<ProductionScene['output']> } | { error: string; final?: true }>();
          for (const { sceneId, ref, r } of results) {
            const s = cur.scenes.find((x) => x.id === sceneId);
            if (!s || s.status !== 'running' || !s.job || s.job.ref !== ref) continue;
            if (r !== 'pending' && !('transient' in r)) { pollErrors.delete(sceneId); changes.set(sceneId, r); continue; }
            if (r !== 'pending') {
              const e = pollErrors.get(sceneId) ?? { n: 0, last: '' };
              e.n++; e.last = r.transient;
              pollErrors.set(sceneId, e);
              if (e.n >= MAX_POLL_ERRORS) { pollErrors.delete(sceneId); changes.set(sceneId, { error: `Không theo dõi được ${PROVIDER_LABEL[s.job.provider] ?? s.job.provider}: ${e.last}`.slice(0, 400), final: true }); continue; }
            } else {
              pollErrors.delete(sceneId);
            }
            const limit = MAX_POLL_MS[s.job.provider];
            if (limit && Date.now() - Date.parse(s.job.startedAt) > limit) changes.set(sceneId, { error: timeoutMessage(s.job.provider, s.job.startedAt), final: true });
          }
          if (!changes.size) return view(cur);
          const p = store.update(id, (x) => {
            for (const [sceneId, c] of changes) {
              const s = sceneOf(x, sceneId);
              if ('output' in c) { s.status = 'done'; s.output = c.output; s.error = null; s.trimStart = 0; s.retry = null; s.job = null; }
              else if (('final' in c && c.final) || !scheduleRetry(s, c.error)) { s.status = 'failed'; s.error = c.error.slice(0, 400); s.job = null; s.retry = null; }
              s.updatedAt = new Date().toISOString();
            }
            settle(x);
          });
          const out = emit(p);
          noticeRetries(p);
          await afterSettle(before, p);
          return out;
        });
      } finally {
        polling.delete(id);
      }
    },

    /** Background round: running scenes, approval cards resolved elsewhere, queued director wakes. */
    async pollAll(): Promise<void> {
      for (const id of store.pendingIds()) {
        try { await service.poll(id); } catch { /* next round */ }
        const due = store.get(id)?.scenes.filter((s) => s.status === 'queued' && s.retry && Date.parse(s.retry.at) <= Date.now()) ?? [];
        for (const s of due) {
          try { await startOne(id, s.id); } catch { /* recorded on the scene, or the production is gone */ }
        }
      }
      try { service.sweepApprovals(); } catch { /* next round */ }
      flushWakes();
    },

    /** Clears approval cards that expired, failed or vanished, so the video never stays "waiting" forever. */
    sweepApprovals(): number {
      if (!approvals.status) return 0;
      let n = 0;
      for (const id of store.awaitingApproval()) {
        const p = store.get(id);
        const pending = p?.pendingApproval;
        if (!p || !pending) continue;
        let status: string | null;
        try { status = approvals.status(pending.approvalId); } catch { continue; }
        if (status === 'pending' || status === 'deciding') continue;
        const next = store.update(id, (x) => { if (x.pendingApproval?.approvalId === pending.approvalId) x.pendingApproval = null; });
        emit(next);
        n++;
        if (status === 'expired' || status === null) hostMessage(p.projectId, 'Thẻ duyệt chi phí đã hết hạn nên không tạo gì. Phân cảnh vẫn giữ nguyên; xin duyệt lại khi bạn sẵn sàng.');
        else if (status === 'failed' || status === 'uncertain') hostMessage(p.projectId, 'Thẻ duyệt chi phí không thực hiện được. Xem lại phân cảnh rồi xin duyệt lại.');
      }
      return n;
    },

    /** After a restart: queued scenes never reached a provider (owner approves again); an interrupted assembly can be retried. */
    recover(): number {
      let n = 0;
      for (const sum of store.list()) {
        const p = store.get(sum.id);
        if (!p) continue;
        const queued = p.scenes.some((s) => s.status === 'queued' && !s.retry);
        if (!queued && p.state !== 'assembling') continue;
        const next = store.update(p.id, (x) => {
          // Waiting retries never reached the provider either; they simply run when due.
          for (const s of x.scenes) if (s.status === 'queued' && !s.retry) { s.status = 'failed'; s.error = 'Máy khởi động lại trước khi gửi cảnh này. Xin duyệt lại để tạo.'; n++; }
          if (x.state === 'assembling') {
            x.state = x.scenes.length && x.scenes.every((s) => s.status === 'done') ? 'ready' : 'storyboard';
            x.error = 'Máy khởi động lại khi đang ghép video. Bấm "Hoàn thiện" để ghép lại.';
            n++;
          }
          settle(x);
        });
        emit(next);
      }
      return n;
    },

    /** Assemble the finished scenes into the host project and start the HyperFrames finishing chain (also a retry after a failure). */
    async finish(id: string): Promise<ProductionView> {
      if (assembling.has(id)) throw conflict('Đang ghép video, chờ một chút.');
      const snap = await locked(id, async () => {
        let p = ensureHostSync(id);
        if (p.scenes.some(busyScene)) throw new Error('Đang tạo cảnh: chờ xong rồi mới hoàn thiện.');
        const done = p.scenes.filter((s) => s.status === 'done' && s.output);
        if (!done.length || done.length !== p.scenes.length) throw new Error('Còn cảnh chưa tạo xong. Tạo đủ các cảnh rồi hoàn thiện.');
        if (!done.some((s) => s.kind === 'talking' && s.text.trim())) throw new Error('Cần ít nhất một cảnh KOL nói để hoàn thiện với phụ đề và hiệu ứng.');
        p = store.update(id, (x) => { x.state = 'assembling'; x.error = null; });
        emit(p);
        return p;
      });
      assembling.add(id);
      try {
        const dir = store.scenesDir(id);
        const assembled = await assembleProduction({
          aspect: snap.aspect,
          workDir: store.workDir(id),
          out: path.join(store.workDir(id), 'production.mp4'),
          scenes: snap.scenes.map((s) => {
            const srtFile = s.output!.subtitles ? path.join(dir, s.output!.subtitles) : null;
            return {
              file: path.join(dir, s.output!.file), durationSec: s.output!.durationSec, start: s.trimStart ?? 0,
              srt: srtFile && fs.existsSync(srtFile) ? fs.readFileSync(srtFile, 'utf8') : null, scene: s,
            };
          }),
        });
        return await locked(id, async () => {
          let p = store.require(id);
          await adoptSource(p, assembled.file, assembled.transcript);
          p = store.update(id, (x) => { x.state = 'finishing'; x.finishProjectId = x.projectId; x.error = null; });
          return emit(p);
        });
      } catch (err) {
        const message = errText(err).slice(0, 400);
        const cur = store.get(id);
        if (cur) {
          const next = store.update(id, (x) => { x.state = 'failed'; x.error = message; });
          emit(next);
          hostMessage(next.projectId, `Ghép video không thành công: ${message} Bấm "Hoàn thiện" để thử lại.`);
        }
        throw err;
      } finally {
        assembling.delete(id);
      }
    },

    isAssembling: (id: string) => assembling.has(id),

    /** The owner stops automatic retries: waiting scenes become failed (nothing was generated for them). */
    async stopRetries(id: string): Promise<ProductionView> {
      return locked(id, async () => {
        const cur = store.require(id);
        const before = cur.state;
        const p = store.update(id, (x) => {
          for (const s of x.scenes) {
            if (s.status !== 'queued' || !s.retry) continue;
            s.status = 'failed'; s.retry = null; s.job = null; s.updatedAt = new Date().toISOString();
            s.error = 'Đã dừng tự thử lại (nhà cung cấp quá tải, chưa tạo gì). Xin duyệt lại khi muốn tạo.';
          }
          settle(x);
        });
        const out = emit(p);
        await afterSettle(before, p);
        return out;
      });
    },

    /** Deletes the production and its host project. Refused while scenes are generating (the spend is already running). */
    async remove(id: string): Promise<void> {
      await locked(id, async () => {
        const p = store.get(id);
        if (!p) return;
        const busy = p.scenes.filter(busyScene).length;
        if (busy) throw conflict(`Đang tạo ${busy} cảnh (đã gửi đi và có thể đã tính phí). Chờ các cảnh xong rồi mới xoá video.`);
        if (assembling.has(id)) throw conflict('Đang ghép video, chờ xong rồi mới xoá.');
        if (p.pendingApproval) { try { approvals.expire(p.pendingApproval.approvalId); } catch { /* decided */ } }
        if (p.projectId) { try { h.editStore.deleteProject(p.projectId); } catch { /* gone */ } }
        store.remove(id);
        pendingWakes.delete(p.projectId ?? '');
      });
    },
  };

  function syncHostTitle(p: Production): void {
    if (!p.projectId) return;
    try {
      const next = h.editStore.updateProject(p.projectId, (x) => { if (x.title !== p.title) x.title = p.title; });
      if (next) h.emitProject(next);
    } catch { /* host removed */ }
  }

  async function adoptSource(p: Production, file: string, transcript: Transcript): Promise<void> {
    const projectId = p.projectId!;
    const sourceDir = h.editStore.sourceDir(projectId);
    h.editStore.ensureDir(sourceDir);
    for (const name of fs.readdirSync(sourceDir)) if (/^raw\.[a-z0-9]+$/i.test(name)) fs.rmSync(path.join(sourceDir, name), { force: true });
    const raw = path.join(sourceDir, 'raw.mp4');
    fs.copyFileSync(file, raw);
    const host = h.editStore.loadProject(projectId);
    if (host?.source || (host?.planVersion ?? 0) > 0) h.pipeline.resetForNewSource(projectId);
    const info = await h.probe(raw);
    try { await h.thumbnail(raw, h.editStore.thumbFile(projectId), info.durationSec); } catch { /* no thumb */ }
    h.editStore.writeTranscript(projectId, transcript);
    const brand = p.cast[0] ? store.brand(p.cast[0]) : null;
    const next = h.editStore.updateProject(projectId, (x) => {
      x.source = { ...info, fileName: 'san-xuat.mp4', sizeBytes: fs.statSync(raw).size };
      if (brand?.styleId) x.styleId = brand.styleId;
      // New tool set from here (video-cli): never resume the produce-mode engine session.
      delete x.engineSessionId;
      x.steps = x.steps.map((s) => (s.key === 'ingest' ? { key: 'ingest', status: 'running', startedAt: new Date().toISOString(), progress: 0 } : s));
    })!;
    h.emitProject(next);
    const script = p.script;
    h.pipeline.appendMessage(projectId, {
      role: 'user',
      text: [
        `Video này được sản xuất từ kịch bản trong Video Studio ("${p.title}", ${p.scenes.length} cảnh).`,
        'Lời thoại đã có sẵn từ kịch bản (không cần chép lời). Giữ nguyên nội dung nói, chỉ cắt khoảng lặng thừa.',
        script?.hook ? `Hook: ${script.hook}` : '',
        script?.caption ? `Chú thích đăng bài: ${script.caption}` : '',
        script?.hashtags.length ? `Hashtag: ${script.hashtags.map((x) => `#${x}`).join(' ')}` : '',
        brand?.captionNote ? `Phụ đề theo bộ nhận diện KOL: ${brand.captionNote}` : '',
        brand?.music === 'none' ? 'Không dùng nhạc nền (theo bộ nhận diện KOL).' : '',
        'Hãy lên kế hoạch hoàn thiện: phụ đề tô từ khoá, hook 3 giây đầu, hiệu ứng theo lời (danh sách, số lớn, nút kêu gọi) và zoom nhấn ở ý chính.',
      ].filter(Boolean).join('\n'),
    });
    h.pipeline.startChain(projectId);
  }

  return service;
}

export type ProductionService = ReturnType<typeof createProductionService>;
