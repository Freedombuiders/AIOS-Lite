/**
 * Owner approval of a batch of scene generations ('video_generate'): shown inline in the Video Studio
 * chat, in "Cần tôi" and on Telegram. Approving queues exactly the approved scenes, provided none of
 * them changed since the request (fingerprint); rejecting just clears the card.
 */

import {
  createApproval,
  expireApproval,
  getApproval,
  registerApprovalHandler,
  verifyApprovalPayload,
  type ApprovalHandler,
  type OwnerApproval,
} from '../../approvals.js';
import { productionServiceFor } from './runtime.js';
import type { ApprovalPort, ProductionService } from './service.js';

export interface GeneratePayload {
  productionId: string;
  projectId: string;
  sceneIds: string[];
  fingerprint: string;
}

export const approvalPort: ApprovalPort = {
  request(input) {
    const payload: GeneratePayload = { productionId: input.productionId, projectId: input.projectId, sceneIds: input.sceneIds, fingerprint: input.fingerprint };
    const { approval } = createApproval({
      kind: 'video_generate',
      agentId: input.agentId,
      title: input.title,
      summary: input.summary,
      payload,
      dedupeKey: `video_generate:${input.productionId}:${input.fingerprint}`,
      expiresInSec: 24 * 3600,
    });
    return { approvalId: approval.id };
  },
  expire(approvalId) {
    expireApproval(approvalId);
  },
  status(approvalId) {
    return getApproval(approvalId)?.status ?? null;
  },
};

export function parseGeneratePayload(approval: OwnerApproval): GeneratePayload | null {
  const p = approval.payload as Partial<GeneratePayload> | null;
  if (!p || typeof p.productionId !== 'string' || typeof p.projectId !== 'string' || typeof p.fingerprint !== 'string') return null;
  if (!Array.isArray(p.sceneIds) || !p.sceneIds.every((x) => typeof x === 'string')) return null;
  return { productionId: p.productionId, projectId: p.projectId, sceneIds: p.sceneIds, fingerprint: p.fingerprint };
}

export function createGenerateApprovalHandler(serviceFor: () => ProductionService | null = () => productionServiceFor()): ApprovalHandler {
  return {
    actions: () => [
      { id: 'approve', label: 'Duyệt và tạo', kind: 'approve' },
      { id: 'reject', label: 'Không tạo', kind: 'reject' },
    ],
    async onDecision(approval, actionId) {
      if (actionId !== 'approve' && actionId !== 'reject') return { status: 'failed', error: `Hành động không hợp lệ: ${actionId}` };
      if (!verifyApprovalPayload(approval)) return { status: 'failed', error: 'Chữ ký yêu cầu duyệt không hợp lệ, không làm gì.' };
      const payload = parseGeneratePayload(approval);
      if (!payload) return { status: 'failed', error: 'Nội dung yêu cầu duyệt không hợp lệ.' };
      const service = serviceFor();
      if (!service) return { status: 'failed', error: 'Video Studio chưa chạy trong ứng dụng này.' };
      try {
        if (actionId === 'reject') {
          await service.rejectGeneration(payload.productionId, approval.id);
          return { status: 'rejected', result: { note: 'Không tạo các cảnh này.' } };
        }
        const r = await service.approveGeneration({ ...payload, approvalId: approval.id });
        return { status: 'executed', result: { queued: r.queued, note: `Đang tạo ${r.queued} cảnh.` } };
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function registerGenerateApprovalHandler(): void {
  registerApprovalHandler('video_generate', createGenerateApprovalHandler());
}
