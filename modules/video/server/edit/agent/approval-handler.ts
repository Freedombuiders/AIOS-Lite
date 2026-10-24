/**
 * Owner approval of a Video Studio edit plan ('video_plan'), shown in "Cần tôi" and on Telegram.
 *
 * Created when the director submits a plan and the channel profile is not on auto-approve
 * (`requestVideoPlanApproval`). Deciding runs the same logic as `POST /projects/:id/plan/decide`
 * (`decidePlan` in pipeline/jobs.ts): approve queues the render, revise starts a new director turn,
 * reject marks the plan rejected. Runs only in the main process.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  createApproval,
  expireApproval,
  listApprovals,
  registerApprovalHandler,
  verifyApprovalPayload,
  type ApprovalHandler,
  type OwnerApproval,
} from '../../approvals.js';
import { VIDEO_STYLES } from '../catalog/styles.js';
import { registerGenerateApprovalHandler } from '../production/approval.js';
import { createVideoEditStore, type VideoEditStore } from '../store.js';
import type { EditPlan, VideoProject } from '../types.js';

export type PlanDecision = 'approve' | 'revise' | 'reject';

export interface VideoPlanPayload {
  projectId: string;
  planVersion: number;
}

export interface VideoPlanApprovalDeps {
  store?: () => VideoEditStore;
  /** Same logic as POST /projects/:id/plan/decide. Must return promptly (queue the work). */
  decidePlan?: (projectId: string, action: PlanDecision, note?: string) => Promise<unknown>;
}

const REVISE_NOTE = 'Chủ kênh bấm "Chỉnh lại" trên thẻ duyệt, chưa nói cụ thể. Hãy xem lại kế hoạch và đề xuất một phương án khác rõ rệt (hook, nhịp cắt hoặc hiệu ứng), nêu rõ đã đổi gì.';

let defaultStore: VideoEditStore | null = null;
const storeOf = (deps?: VideoPlanApprovalDeps): VideoEditStore =>
  deps?.store ? deps.store() : (defaultStore ??= createVideoEditStore());

async function defaultDecidePlan(projectId: string, action: PlanDecision, note?: string): Promise<unknown> {
  // Lazy: pipeline/jobs.ts imports the director turn, which imports this module's siblings.
  const mod = (await import('../pipeline/jobs.js')) as { decidePlan?: (id: string, action: PlanDecision, note?: string) => Promise<unknown> };
  if (typeof mod.decidePlan !== 'function') throw new Error('decidePlan chưa có trong pipeline/jobs.');
  return mod.decidePlan(projectId, action, note);
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The current plan of a project: inline when the store keeps it on project.json, else plans/plan.v<N>.json. */
export function loadCurrentPlan(store: VideoEditStore, project: VideoProject): EditPlan | null {
  if (project.plan && project.plan.version === project.planVersion) return project.plan;
  try {
    const file = path.join(store.projectDir(project.id), 'plans', `plan.v${project.planVersion}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as EditPlan;
  } catch {
    return project.plan ?? null;
  }
}

const SUMMARY_MAX = 1400;

export function describePlanForApproval(project: VideoProject, plan: EditPlan): { title: string; summary: string } {
  const styleName = VIDEO_STYLES.find((s) => s.id === plan.styleId)?.name ?? plan.styleId;
  const removed = plan.removed?.length ?? 0;
  const lines: string[] = [];
  lines.push(`Video ${project.code} "${project.title}" · phong cách ${styleName} · tỉ lệ ${plan.aspect}`);
  lines.push(`Độ dài: ${fmtDuration(plan.sourceDurationSec)} → ${fmtDuration(plan.outputDurationSec)}${removed ? `, bỏ ${removed} đoạn` : ''}${plan.targetSeconds ? ` (mục tiêu ${plan.targetSeconds}s)` : ''}`);
  const chosen = plan.hook?.options.find((o) => o.id === plan.hook?.chosen);
  if (chosen) lines.push(`Hook: "${chosen.text}"${chosen.mode === 'moved' ? ' (đưa đoạn hay lên đầu)' : ''}`);
  const extras = [
    plan.brolls.filter((b) => b.enabled).length ? `${plan.brolls.filter((b) => b.enabled).length} B-roll` : '',
    plan.overlays.length ? `${plan.overlays.length} hiệu ứng chữ` : '',
    plan.music ? 'có nhạc nền' : '',
    plan.sfx.length ? `${plan.sfx.length} tiếng động` : '',
  ].filter(Boolean);
  if (extras.length) lines.push(`Thêm: ${extras.join(', ')}`);
  if (plan.summary.trim()) lines.push(`Ý tưởng: ${plan.summary.trim()}`);
  if (plan.changes?.length) {
    lines.push('Thay đổi so với bản trước:');
    for (const c of plan.changes.slice(0, 8)) lines.push(`- ${c}`);
    if (plan.changes.length > 8) lines.push(`- … và ${plan.changes.length - 8} thay đổi nữa`);
  }
  let summary = lines.join('\n');
  if (summary.length > SUMMARY_MAX) summary = `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
  const title = `Duyệt kế hoạch dựng ${project.code}: ${fmtDuration(plan.sourceDurationSec)} → ${fmtDuration(plan.outputDurationSec)}`;
  return { title, summary };
}

/**
 * Creates the owner approval for the project's current plan. Returns null when there is nothing to
 * approve, the plan is not waiting for approval, or the channel auto-approves. Idempotent per plan
 * version (dedupeKey), so both the director turn and the submit endpoint may call it.
 */
/** Expire this project's pending plan cards, except the one for `keepVersion`. Returns how many closed. */
export function closeVideoPlanApprovals(projectId: string, keepVersion?: number): number {
  let closed = 0;
  for (const a of listApprovals({ kind: 'video_plan', status: ['pending'], limit: 500 })) {
    const p = parsePayload(a);
    if (!p || p.projectId !== projectId || p.planVersion === keepVersion) continue;
    if (expireApproval(a.id)) closed++;
  }
  return closed;
}

export function requestVideoPlanApproval(projectId: string, deps?: VideoPlanApprovalDeps): { approvalId: string; created: boolean } | null {
  const store = storeOf(deps);
  const project = store.loadProject(projectId);
  if (!project || project.planVersion < 1) return null;
  // Cards for older versions can no longer be approved; take them out of "Cần tôi".
  closeVideoPlanApprovals(projectId, project.planVersion);
  if (project.planStatus !== 'waiting_approval') return null;
  const profile = store.getProfile(project.profileId);
  if (profile?.autoApprovePlan) return null;
  const plan = loadCurrentPlan(store, project);
  if (!plan) return null;
  const { title, summary } = describePlanForApproval(project, plan);
  const payload: VideoPlanPayload = { projectId, planVersion: project.planVersion };
  const { approval, created } = createApproval({
    kind: 'video_plan',
    agentId: project.agentId,
    title,
    summary,
    payload,
    dedupeKey: `video_plan:${projectId}:v${project.planVersion}`,
    expiresInSec: 7 * 24 * 3600,
  });
  return { approvalId: approval.id, created };
}

function parsePayload(approval: OwnerApproval): VideoPlanPayload | null {
  const p = approval.payload as Partial<VideoPlanPayload> | null;
  if (!p || typeof p.projectId !== 'string' || typeof p.planVersion !== 'number') return null;
  return { projectId: p.projectId, planVersion: p.planVersion };
}

export function createVideoPlanApprovalHandler(deps: VideoPlanApprovalDeps = {}): ApprovalHandler {
  const decide = deps.decidePlan ?? defaultDecidePlan;
  return {
    actions: () => [
      { id: 'approve', label: 'Duyệt và dựng', kind: 'approve' },
      { id: 'revise', label: 'Chỉnh lại', kind: 'reject' },
      { id: 'reject', label: 'Bỏ kế hoạch', kind: 'reject' },
    ],
    async onDecision(approval, actionId) {
      if (actionId !== 'approve' && actionId !== 'revise' && actionId !== 'reject') {
        return { status: 'failed', error: `Hành động không hợp lệ: ${actionId}` };
      }
      if (!verifyApprovalPayload(approval)) {
        return { status: 'failed', error: 'Chữ ký yêu cầu duyệt không hợp lệ, không làm gì.' };
      }
      const payload = parsePayload(approval);
      if (!payload) return { status: 'failed', error: 'Nội dung yêu cầu duyệt không hợp lệ.' };

      const project = storeOf(deps).loadProject(payload.projectId);
      if (!project) return { status: 'failed', error: 'Việc dựng này không còn nữa.' };
      if (project.planVersion !== payload.planVersion) {
        return {
          status: 'failed',
          error: `Kế hoạch đã có bản mới (v${project.planVersion}), thẻ này là bản v${payload.planVersion}. Hãy duyệt thẻ của bản mới nhất.`,
        };
      }

      try {
        if (actionId === 'approve') {
          await decide(payload.projectId, 'approve');
          return { status: 'executed', result: { planVersion: payload.planVersion, note: 'Đã duyệt, đang dựng video.' } };
        }
        if (actionId === 'revise') {
          await decide(payload.projectId, 'revise', REVISE_NOTE);
          return { status: 'executed', result: { planVersion: payload.planVersion, note: 'Đã yêu cầu đạo diễn đề xuất lại.' } };
        }
        await decide(payload.projectId, 'reject');
        return { status: 'rejected', result: { planVersion: payload.planVersion, note: 'Đã bỏ kế hoạch, chưa dựng.' } };
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** Registers the 'video_plan' handler. Called once in the main process by the approvals boot (messenger.ts). */
export function registerVideoEditApprovalHandlers(): void {
  registerApprovalHandler('video_plan', createVideoPlanApprovalHandler());
  registerGenerateApprovalHandler();
}
