// Editor + pipeline endpoints of the Video Studio (phase 1): transcript, analysis, plan versions,
// decisions, render, live composition, marks, brief, feedback, and the internal /agent/* routes the
// video-cli talks to. Registered by routes.ts, which passes the shared helpers in `kit`.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { VIDEO_STYLES } from './catalog/styles.js';
import { StoreError, type VideoEditStore } from './store.js';
import { serveFile } from './serve.js';
import { buildComposition, materializeAssets } from './pipeline/composition.js';
import { extractFrame } from './pipeline/analyze.js';
import { applyPatch, diffPlans, type PlanPatch } from './pipeline/plan.js';
import type { Pipeline } from './pipeline/runner.js';
import {
  STEP_DEFS, type MarkKind, type QuickFeedback, type StepKey, type VideoMark, type VideoProfile, type VideoProject,
} from './types.js';

type Status = 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 501;

export interface EditorKit {
  P: string;
  root: string;
  store: VideoEditStore;
  pipeline: Pipeline;
  fail: (c: Context, status: Status, error: string, code?: string) => Response;
  small: (c: Context, next: () => Promise<void>) => Promise<Response | void>;
  guard: (fn: (c: Context) => Response | Promise<Response>) => (c: Context) => Promise<Response>;
  parse: <T extends z.ZodTypeAny>(c: Context, schema: T) => Promise<z.infer<T>>;
  idOf: (c: Context) => string;
  requireProject: (id: string) => VideoProject;
  emitProject: (p: VideoProject) => void;
  /** Test seam: replaces the loopback check of the /agent routes. */
  isLocal?: (c: Context) => boolean;
}

const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'];

/** The TCP peer is loopback (never a header) and no reverse proxy sits in between. */
export function isLoopbackRequest(c: Context): boolean {
  const remote: string | undefined = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  if (!remote) return false;
  const loopback = remote === '::1' || remote.startsWith('127.') || remote.startsWith('::ffff:127.');
  return loopback && !PROXY_HEADERS.some((h) => c.req.header(h));
}

const patchSchema = z.object({
  toggleWords: z.array(z.number().int().min(0)).max(5000),
  cutWords: z.array(z.number().int().min(0)).max(20000),
  gapMs: z.number().int().min(0).max(5000),
  hookChosen: z.string().min(1).max(60),
  brolls: z.array(z.object({ id: z.string().min(1).max(60), enabled: z.boolean() }).strict()).max(60),
  captions: z.object({
    styleId: z.string().max(60),
    position: z.enum(['bottom', 'middle', 'behind']),
    highlight: z.array(z.string().max(80)).max(60),
    maxWordsPerChunk: z.number().int().min(1).max(8),
  }).partial().strict(),
  meta: z.object({
    title: z.string().trim().max(200),
    caption: z.string().max(4000),
    hashtags: z.array(z.string().max(80)).max(40),
    hook: z.string().max(300),
  }).partial().strict(),
}).partial().strict();

const decideSchema = z.object({
  action: z.enum(['approve', 'revise', 'reject']),
  note: z.string().trim().max(4000).optional(),
}).strict();

const markKind = z.enum(['remove', 'keep', 'text', 'broll', 'effect', 'other']);
const markCreate = z.object({
  start: z.number().finite().min(0).max(36_000),
  end: z.number().finite().min(0).max(36_000).optional(),
  kind: markKind,
  note: z.string().trim().max(1000).default(''),
  planVersion: z.number().int().min(0).optional(),
}).strict();
const markPatch = z.object({
  start: z.number().finite().min(0).max(36_000),
  end: z.number().finite().min(0).max(36_000).nullable(),
  kind: markKind,
  note: z.string().trim().max(1000),
}).partial().strict();
const sendSchema = z.object({ note: z.string().trim().max(2000).optional() }).strict();

const briefValue = z.union([z.string().max(2000), z.array(z.string().max(500)).max(40)]);
const briefSchema = z.record(z.string().min(1).max(40), briefValue).refine((o) => Object.keys(o).length <= 40);

const feedbackSchema = z.object({
  quick: z.enum(['ok', 'fix', 'less-effects']),
  note: z.string().trim().max(1000).optional(),
  chosenCover: z.number().int().min(1).max(3).optional(),
}).strict();

const stepKey = z.enum(STEP_DEFS.map((d) => d.key) as [StepKey, ...StepKey[]]);
const agentPlanSchema = z.object({
  plan: z.record(z.string(), z.unknown()),
  note: z.string().trim().max(600).optional(),
  validateOnly: z.boolean().optional(),
}).passthrough();
const agentLogSchema = z.object({ step: stepKey, text: z.string().trim().min(1).max(400) }).strict();
const agentFramesSchema = z.object({ at: z.array(z.number().finite().min(0).max(36_000)).min(1).max(12) }).strict();
const agentRuleSchema = z.object({ text: z.string().trim().min(1).max(400) }).strict();

const TASTE_HEADING = '## Luật đã ghi nhớ';

/** Append one rule line to the profile's taste under a fixed heading; the same rule is never added twice. */
export function appendTasteRule(taste: string, rule: string, today = new Date().toISOString().slice(0, 10)): { taste: string; added: boolean } {
  const line = `- ${rule.replace(/\s+/g, ' ').trim()}`;
  if (taste.split('\n').some((l) => l.replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '').trim() === line)) return { taste, added: false };
  const stamped = `${line} (${today})`;
  const base = taste.trimEnd();
  const next = base.includes(TASTE_HEADING)
    ? `${base}\n${stamped}\n`
    : `${base}${base ? '\n\n' : ''}${TASTE_HEADING}\n${stamped}\n`;
  return { taste: next.slice(-20000), added: true };
}

export function registerEditorRoutes(app: Hono, kit: EditorKit) {
  const { P, store, pipeline, fail, small, guard, parse, idOf, requireProject, emitProject } = kit;
  const local = kit.isLocal ?? isLoopbackRequest;

  const needTranscript = (id: string) => {
    const t = store.readTranscript(id);
    if (!t) throw new StoreError(404, 'Chưa có bản chép lời cho việc này.', 'no_transcript');
    return t;
  };

  // ── Transcript, analysis ──
  app.get(`${P}/projects/:id/transcript`, guard((c) => {
    const project = requireProject(idOf(c));
    return c.json(needTranscript(project.id));
  }));

  app.get(`${P}/projects/:id/analysis`, guard((c) => {
    const project = requireProject(idOf(c));
    const analysis = store.readAnalysis(project.id);
    if (!analysis) return fail(c, 404, 'Chưa soi xong video này.', 'no_analysis');
    return c.json(analysis);
  }));

  // ── Plan ──
  app.get(`${P}/projects/:id/plan`, guard((c) => {
    const project = requireProject(idOf(c));
    if (project.planVersion < 1) return fail(c, 404, 'Chưa có kế hoạch dựng.', 'no_plan');
    const raw = c.req.query('version');
    const version = raw === undefined || raw === '' ? project.planVersion : Number(raw);
    if (!Number.isInteger(version) || version < 1) return fail(c, 400, 'Phiên bản kế hoạch không hợp lệ.');
    const plan = version === project.planVersion && project.plan?.version === version ? project.plan : store.loadPlan(project.id, version);
    if (!plan) return fail(c, 404, `Không có kế hoạch phiên bản ${version}.`, 'no_plan');
    return c.json({
      plan, planVersion: version,
      ...(version === project.planVersion && project.planStatus ? { planStatus: project.planStatus } : {}),
      versions: store.listPlanVersions(project.id),
    });
  }));

  app.patch(`${P}/projects/:id/plan`, small, guard(async (c) => {
    const body = await parse(c, patchSchema) as PlanPatch;
    const project = requireProject(idOf(c));
    if (project.planVersion < 1) return fail(c, 404, 'Chưa có kế hoạch dựng.', 'no_plan');
    if (project.busy) return fail(c, 409, 'Agent đang sửa kế hoạch. Chờ xong rồi chỉnh.', 'busy');
    const ctx = pipeline.planContext(project.id);
    if (!ctx) return fail(c, 409, 'Chưa có bản chép lời để chỉnh.', 'no_transcript');
    const current = store.loadPlan(project.id, project.planVersion);
    if (!current) return fail(c, 404, 'Không đọc được kế hoạch hiện tại.', 'no_plan');
    const next = applyPatch(current, body, ctx);
    next.version = pipeline.nextVersion(project.id);
    const saved = pipeline.commitPlan(project.id, next, 'draft');
    return c.json({ plan: next, project: saved });
  }));

  app.get(`${P}/projects/:id/plan/diff`, guard((c) => {
    const project = requireProject(idOf(c));
    const to = Number(c.req.query('to') ?? project.planVersion);
    const from = c.req.query('from') === undefined ? to - 1 : Number(c.req.query('from'));
    if (![from, to].every((n) => Number.isInteger(n) && n >= 1)) return fail(c, 400, 'Cần hai phiên bản kế hoạch hợp lệ (from, to).');
    const a = store.loadPlan(project.id, from);
    const b = store.loadPlan(project.id, to);
    if (!a || !b) return fail(c, 404, 'Không có phiên bản kế hoạch này.', 'no_plan');
    return c.json({ changes: diffPlans(a, b, store.readTranscript(project.id) ?? undefined), from, to });
  }));

  app.post(`${P}/projects/:id/plan/decide`, small, guard(async (c) => {
    const body = await parse(c, decideSchema);
    const project = requireProject(idOf(c));
    const result = await pipeline.decide(project.id, body.action, body.note);
    return c.json(result);
  }));

  // ── Render ──
  app.post(`${P}/projects/:id/render`, small, guard(async (c) => {
    const project = requireProject(idOf(c));
    if (project.planVersion < 1) return fail(c, 409, 'Chưa có kế hoạch để xuất.', 'no_plan');
    if (!fs.existsSync(store.masterFile(project.id))) return fail(c, 409, 'Video chưa được chuẩn hoá xong.', 'not_ingested');
    return c.json(await pipeline.decide(project.id, 'approve'));
  }));

  app.get(`${P}/projects/:id/renders`, guard((c) => {
    const project = requireProject(idOf(c));
    return c.json({ renders: project.renders ?? [], jobs: pipeline.queue.list(project.id).slice(-20) });
  }));

  // ── Live composition (preview) ──
  app.get(`${P}/projects/:id/composition/preview.html`, guard((c) => {
    const project = requireProject(idOf(c));
    if (project.planVersion < 1) return fail(c, 404, 'Chưa có kế hoạch để xem trước.', 'no_plan');
    const wanted = Number(c.req.query('v'));
    const version = Number.isInteger(wanted) && wanted >= 1 ? wanted : project.planVersion;
    const plan = store.loadPlan(project.id, version);
    const transcript = store.readTranscript(project.id);
    const profile = store.getProfile(project.profileId);
    if (!plan || !transcript || !profile) return fail(c, 404, 'Thiếu dữ liệu để dựng bản xem trước.', 'no_plan');
    if (!fs.existsSync(store.proxyFile(project.id))) return fail(c, 409, 'Bản xem nhẹ chưa sẵn sàng.', 'not_ingested');
    const style = VIDEO_STYLES.find((s) => s.id === project.styleId) ?? null;
    // Cheap to build, so it is rebuilt per request (always with the latest overrides.json); the file on disk is the
    // per-version cache others can open.
    const built = buildComposition({
      plan, transcript, project, profile, style, mode: 'preview', resolver: pipeline.resolver, overrides: store.readOverrides(project.id),
    });
    const dir = store.compositionDir(project.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'preview.html');
    fs.writeFileSync(file, built.html);
    materializeAssets(dir, built.assets, store.masterFile(project.id));
    // The editor frames this page in <hyperframes-player>; the dashboard default is DENY for every page.
    // Same-origin framing only, so the clickjacking protection still holds for other sites.
    c.header('X-Frame-Options', 'SAMEORIGIN');
    c.header('Content-Security-Policy', "frame-ancestors 'self'");
    return serveFile(c, file);
  }));

  app.get(`${P}/projects/:id/composition/assets/:name`, guard((c) => {
    const project = requireProject(idOf(c));
    const name = c.req.param('name') ?? '';
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return fail(c, 404, 'Không có tệp này.');
    const link = path.join(store.compositionDir(project.id), 'assets', name);
    let real: string;
    try { real = fs.realpathSync(link); } catch { return fail(c, 404, 'Không có tệp này.'); }
    // Links only ever point into the library or this project; anything else is refused.
    const allowed = [path.join(kit.root, 'library'), store.projectDir(project.id)].map((d) => { try { return fs.realpathSync(d); } catch { return d; } });
    if (!allowed.some((d) => real.startsWith(d + path.sep))) return fail(c, 404, 'Không có tệp này.');
    if (!fs.statSync(real).isFile()) return fail(c, 404, 'Không có tệp này.');
    return serveFile(c, real);
  }));

  // The preview composition references ../source/proxy.mp4.
  app.get(`${P}/projects/:id/source/:file`, guard((c) => {
    const project = requireProject(idOf(c));
    const name = c.req.param('file');
    if (name !== 'proxy.mp4' && name !== 'master.mp4') return fail(c, 404, 'Không có tệp này.');
    const file = path.join(store.sourceDir(project.id), name);
    if (!fs.existsSync(file)) return fail(c, 404, 'Chưa có tệp này.');
    return serveFile(c, file);
  }));

  // ── Marks ──
  const findMark = (projectId: string, markId: string) => {
    const marks = store.readMarks(projectId);
    const mark = marks.find((m) => m.id === markId);
    if (!mark) throw new StoreError(404, 'Không tìm thấy góp ý này.');
    return { marks, mark };
  };

  app.get(`${P}/projects/:id/marks`, guard((c) => {
    const project = requireProject(idOf(c));
    return c.json({ marks: store.readMarks(project.id) });
  }));

  app.post(`${P}/projects/:id/marks`, small, guard(async (c) => {
    const body = await parse(c, markCreate);
    const project = requireProject(idOf(c));
    if (body.end !== undefined && body.end < body.start) return fail(c, 400, 'Điểm cuối phải sau điểm đầu.');
    const mark: VideoMark = {
      id: randomUUID().slice(0, 8),
      projectId: project.id,
      planVersion: body.planVersion ?? project.planVersion,
      start: body.start,
      ...(body.end !== undefined ? { end: body.end } : {}),
      kind: body.kind as MarkKind,
      note: body.note,
      status: 'draft',
      createdAt: new Date().toISOString(),
    };
    store.writeMarks(project.id, [...store.readMarks(project.id), mark]);
    return c.json({ mark });
  }));

  app.patch(`${P}/projects/:id/marks/:markId`, small, guard(async (c) => {
    const body = await parse(c, markPatch);
    const project = requireProject(idOf(c));
    const { marks, mark } = findMark(project.id, c.req.param('markId') ?? '');
    if (mark.status !== 'draft') return fail(c, 409, 'Góp ý đã gửi, không sửa được nữa.', 'sent');
    if (body.start !== undefined) mark.start = body.start;
    if (body.end !== undefined) { if (body.end === null) delete mark.end; else mark.end = body.end; }
    if (body.kind !== undefined) mark.kind = body.kind as MarkKind;
    if (body.note !== undefined) mark.note = body.note;
    if (mark.end !== undefined && mark.end < mark.start) return fail(c, 400, 'Điểm cuối phải sau điểm đầu.');
    store.writeMarks(project.id, marks);
    return c.json({ mark });
  }));

  app.delete(`${P}/projects/:id/marks/:markId`, guard((c) => {
    const project = requireProject(idOf(c));
    const { marks, mark } = findMark(project.id, c.req.param('markId') ?? '');
    store.writeMarks(project.id, marks.filter((m) => m.id !== mark.id));
    return c.json({ ok: true });
  }));

  app.post(`${P}/projects/:id/marks/send`, small, guard(async (c) => {
    const raw = await c.req.text();
    const body = raw.trim() ? sendSchema.parse(JSON.parse(raw)) : {};
    const project = requireProject(idOf(c));
    if (project.planVersion < 1) return fail(c, 409, 'Chưa có kế hoạch để góp ý.', 'no_plan');
    const { sent, job } = pipeline.sendMarks(project.id, body.note);
    return c.json({ ok: true, sent: sent.length, marks: store.readMarks(project.id), job, project: requireProject(project.id) });
  }));

  // ── Brief ──
  app.get(`${P}/projects/:id/brief`, guard((c) => {
    const project = requireProject(idOf(c));
    return c.json({ brief: project.brief ?? store.readBrief(project.id) });
  }));

  app.put(`${P}/projects/:id/brief`, small, guard(async (c) => {
    const raw = await c.req.json().catch(() => null) as unknown;
    const candidate = raw && typeof raw === 'object' && 'brief' in (raw as object) ? (raw as { brief: unknown }).brief : raw;
    const brief = briefSchema.parse(candidate);
    const project = requireProject(idOf(c));
    store.writeBrief(project.id, brief);
    const next = store.updateProject(project.id, (p) => { p.brief = brief; })!;
    emitProject(next);
    return c.json({ brief, project: next });
  }));

  // ── Feedback after delivery ──
  app.post(`${P}/projects/:id/feedback`, small, guard(async (c) => {
    const body = await parse(c, feedbackSchema);
    const project = requireProject(idOf(c));
    const quick = body.quick as QuickFeedback;
    const style = VIDEO_STYLES.find((s) => s.id === project.styleId);
    const label = `${project.code} "${project.title}"${style ? ` (${style.name})` : ''}`;
    let rule: string | null = null;
    if (quick === 'ok') rule = `Ổn: ${label} được duyệt, giữ hướng dựng này${body.note ? ` — ${body.note}` : ''}`;
    else if (quick === 'less-effects') rule = `Bớt hiệu ứng: dùng ít hiệu ứng chữ, zoom và tiếng động hơn${body.note ? ` — ${body.note}` : ''} (từ ${label})`;
    else if (body.note) rule = `Cần sửa: ${body.note} (từ ${label})`;

    store.appendFeedback(project.id, { at: new Date().toISOString(), quick, ...(body.note ? { note: body.note } : {}), planVersion: project.planVersion });
    let profile = store.getProfile(project.profileId);
    let added = false;
    if (profile && rule) {
      const res = appendTasteRule(profile.taste, rule);
      added = res.added;
      if (added) profile = store.saveProfile({ ...profile, taste: res.taste });
    }
    const next = store.updateProject(project.id, (p) => {
      if (body.chosenCover) p.chosenCover = body.chosenCover;
      if (quick === 'ok' && p.outputs.final) p.status = 'done';
    })!;
    emitProject(next);
    return c.json({ ok: true, quick, ...(rule && added ? { rule } : {}), project: next, ...(profile ? { profile: { id: profile.id, taste: profile.taste } } : {}) });
  }));

  // ── Internal routes for video-cli (local requests only) ──
  const agentOnly = (fn: (c: Context) => Response | Promise<Response>) => guard(async (c) => {
    if (!local(c)) return fail(c, 403, 'Đường dẫn này chỉ nhận yêu cầu từ máy chủ nội bộ.', 'local_only');
    return fn(c);
  });

  app.get(`${P}/agent/projects/:id/context`, agentOnly((c) => {
    const project = requireProject(idOf(c));
    const profile = store.getProfile(project.profileId);
    const transcript = store.readTranscript(project.id);
    const analysis = store.readAnalysis(project.id);
    const style = VIDEO_STYLES.find((s) => s.id === project.styleId) ?? null;
    const plan = project.planVersion > 0 ? store.loadPlan(project.id, project.planVersion) : null;
    return c.json({
      project: { ...project, plan: undefined },
      profile,
      style,
      brief: project.brief ?? store.readBrief(project.id),
      plan,
      planVersion: project.planVersion,
      planStatus: project.planStatus ?? null,
      marks: store.readMarks(project.id).filter((m) => m.status !== 'resolved'),
      transcript: transcript ? { words: transcript.words.length, durationSec: transcript.durationSec, language: transcript.language } : null,
      analysis: analysis
        ? { silences: analysis.silences.length, fillers: analysis.fillers.length, retakes: analysis.retakes.length, scenes: analysis.scenes.length, frames: analysis.frames.length, loudnessLufs: analysis.loudnessLufs ?? null }
        : null,
      paths: { projectDir: store.projectDir(project.id), frames: store.framesDir(project.id) },
    });
  }));

  app.post(`${P}/agent/projects/:id/plan`, small, agentOnly(async (c) => {
    const raw = await c.req.json().catch(() => null) as unknown;
    // Accept {plan, note?, validateOnly?} (video-cli) or a bare plan object.
    const wrapped = agentPlanSchema.safeParse(raw);
    const input = wrapped.success ? wrapped.data.plan : raw;
    const note = wrapped.success ? wrapped.data.note : undefined;
    const validateOnly = wrapped.success ? Boolean(wrapped.data.validateOnly) : false;
    const project = requireProject(idOf(c));
    const result = pipeline.submitAgentPlan(project.id, input, note, validateOnly);
    if (!result.ok) {
      return c.json({ error: `Kế hoạch chưa hợp lệ: ${result.errors.slice(0, 5).join('; ')}`, code: 'invalid_plan', errors: result.errors }, 422);
    }
    return c.json({
      ok: true,
      ...(result.validateOnly ? { validateOnly: true } : { saved: true, planStatus: 'waiting_approval' }),
      version: result.plan.version,
      planVersion: result.plan.version,
      outputDurationSec: result.plan.outputDurationSec,
      sourceDurationSec: result.plan.sourceDurationSec,
      changes: result.plan.changes ?? [],
    });
  }));

  app.post(`${P}/agent/projects/:id/log`, small, agentOnly(async (c) => {
    const body = await parse(c, agentLogSchema);
    const project = requireProject(idOf(c));
    pipeline.logStep(project.id, body.step, body.text);
    return c.json({ ok: true, step: body.step });
  }));

  app.post(`${P}/agent/projects/:id/frames`, small, agentOnly(async (c) => {
    const body = await parse(c, agentFramesSchema);
    const project = requireProject(idOf(c));
    const src = fs.existsSync(store.masterFile(project.id)) ? store.masterFile(project.id) : store.sourceFile(project.id);
    if (!src) return fail(c, 409, 'Chưa có video để trích khung hình.', 'no_source');
    const duration = project.source?.durationSec ?? Infinity;
    const frames: { at: number; file: string; relative: string }[] = [];
    for (const at of [...new Set(body.at)].sort((a, b) => a - b)) {
      const t = Math.min(at, Math.max(0, duration - 0.1));
      const relative = path.join('frames', `at-${String(Math.round(t * 1000)).padStart(6, '0')}.jpg`);
      const file = path.join(store.projectDir(project.id), relative);
      if (!fs.existsSync(file)) await extractFrame(src, t, file, 720);
      frames.push({ at: t, file, relative: relative.split(path.sep).join('/') });
    }
    return c.json({ frames });
  }));

  app.post(`${P}/agent/profiles/:id/rule`, small, agentOnly(async (c) => {
    const body = await parse(c, agentRuleSchema);
    const profile = store.getProfile(idOf(c));
    if (!profile) return fail(c, 404, 'Không tìm thấy hồ sơ kênh.');
    const res = appendTasteRule(profile.taste, body.text);
    let next: VideoProfile = profile;
    if (res.added) next = store.saveProfile({ ...profile, taste: res.taste });
    return c.json({ ok: true, added: res.added, profile: { id: next.id, taste: next.taste } });
  }));

}
