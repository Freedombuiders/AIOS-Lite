// Owner approvals for gated calls: a row + a "Cần bạn" item; on decision run the command, comment on the task and requeue it.
import type { AuditService } from '../access/contracts.js';
import type { Logger } from '../core/log.js';
import { redactString, redactValue } from '../core/redact.js';
import type { EventBus } from '../core/events.js';
import type { AttentionService, CommentService } from '../work/contracts.js';
import type { ApprovalRow, IntegrationDb } from './db.js';
import { getIntegration } from './registry.js';
import { toFailure, type ApprovalRequest, type Runner } from './runner.js';
import type { IntegrationRisk } from './types.js';

export interface IntegrationApproval {
  id: string;
  integrationId: string;
  agentId: string;
  taskId: number | null;
  command: string;
  /** the command line as the agent wrote it, secrets masked */
  args: string;
  risk: IntegrationRisk;
  status: ApprovalRow['status'];
  result?: unknown;
  error?: string;
  createdAt: string;
  decidedAt?: string;
}

const RISK_VI: Record<IntegrationRisk, string> = {
  read: 'chỉ đọc (chủ đã đặt lệnh này phải hỏi trước)',
  write: 'ghi dữ liệu thật, thường không hoàn tác được',
  destructive: 'có thể xóa hoặc hủy dữ liệu',
};

const RESULT_COMMENT_MAX = 4000;
const STORED_RESULT_MAX = 20_000;

export const attentionKey = (id: string): string => `integration:approval:${id}`;

const preview = (text: string): string => redactString(text.length > 300 ? text.slice(0, 300) + '…' : text).slice(0, 900);

function storedResult(value: unknown): string {
  const text = JSON.stringify(redactValue(value)) ?? 'null';
  return text.length > STORED_RESULT_MAX ? JSON.stringify({ truncated: true, excerpt: text.slice(0, STORED_RESULT_MAX) }) : text;
}

export function createApprovals(deps: {
  idb: IntegrationDb;
  runner: Pick<Runner, 'executeApproved'>;
  attention: AttentionService;
  comments: CommentService;
  bus: EventBus;
  audit: Pick<AuditService, 'log'>;
  log: Logger;
}) {
  const { idb } = deps;

  const toApproval = (r: ApprovalRow): IntegrationApproval => {
    let args = '';
    try { args = String(JSON.parse(r.argsJson)); } catch { /* keep empty */ }
    let result: unknown;
    if (r.resultJson) try { result = JSON.parse(r.resultJson); } catch { /* ignore */ }
    return {
      id: r.id,
      integrationId: r.integrationId,
      agentId: r.agentId,
      taskId: r.taskId,
      command: r.command,
      args: redactString(args),
      risk: r.risk as IntegrationRisk,
      status: r.status,
      ...(result !== undefined ? { result } : {}),
      ...(r.error ? { error: r.error } : {}),
      createdAt: r.createdAt,
      ...(r.decidedAt ? { decidedAt: r.decidedAt } : {}),
    };
  };

  const emit = (row: ApprovalRow) => deps.bus.emit({ type: 'custom', name: 'integrations:approval', payload: toApproval(row) });

  function comment(taskId: number | null, body: string): void {
    if (taskId === null) return;
    try {
      // author 'user': CommentService only requeues finished tasks for user comments, and this is the owner's decision
      deps.comments.add(taskId, 'user', body, { requeue: true });
    } catch (err) {
      deps.log.warn({ err, taskId }, 'integration approval: comment failed');
    }
  }

  /** Files a request (or reuses the identical pending one) and raises the attention item. */
  function request(req: ApprovalRequest): { id: string; created: boolean } {
    const existing = idb.findPendingApproval(req.agentId, req.definition.id, req.command.name, req.argsHash);
    if (existing) return { id: existing.id, created: false };
    const row = idb.insertApproval({
      agentId: req.agentId,
      integrationId: req.definition.id,
      taskId: req.taskId,
      command: req.command.name,
      argsJson: JSON.stringify(req.argsText),
      argsHash: req.argsHash,
      risk: req.risk,
    });
    deps.attention.raise({
      key: attentionKey(row.id),
      kind: 'module',
      title: `Agent ${req.agentId} xin chạy "${req.command.name}" trên ${req.definition.name}`,
      detail: `${req.definition.id} ${preview(req.argsText)}\nMức độ: ${RISK_VI[req.risk]}.`,
      ...(req.taskId !== null ? { taskId: req.taskId } : {}),
      link: '/connections?tab=approvals',
      severity: 'warn',
    });
    emit(row);
    return { id: row.id, created: true };
  }

  function get(id: string): IntegrationApproval | undefined {
    const r = idb.getApproval(id);
    return r && toApproval(r);
  }

  async function approve(id: string, opts: { always?: boolean } = {}): Promise<IntegrationApproval> {
    const row = idb.getApproval(id);
    if (!row) throw new ApprovalError('not_found', 'Không tìm thấy yêu cầu duyệt này.');
    if (!idb.claimApproval(id)) throw new ApprovalError('conflict', 'Yêu cầu này đã được xử lý.');
    const name = getIntegration(row.integrationId)?.name ?? row.integrationId;
    const what = `"${row.integrationId} ${row.command}"`;
    if (opts.always) idb.addTrustRule(row.agentId, row.integrationId, row.command, row.argsHash);
    let argsText = '';
    try { argsText = String(JSON.parse(row.argsJson)); } catch { /* handled by the run failing */ }
    try {
      const result = await deps.runner.executeApproved({
        integrationId: row.integrationId, command: row.command, argsText, agentId: row.agentId, taskId: row.taskId, approvalId: row.id,
      });
      idb.finishApproval(id, 'approved', storedResult(result), null);
      const json = JSON.stringify(redactValue(result)) ?? 'null';
      comment(row.taskId, `Chủ đã duyệt lệnh ${what} trên ${name} (mã ${id}) và lệnh đã chạy MỘT lần, đừng chạy lại.\nKết quả: ${json.length > RESULT_COMMENT_MAX ? json.slice(0, RESULT_COMMENT_MAX) + '… [đã cắt]' : json}\nHãy tiếp tục việc từ đây và báo người dùng kết quả.`);
    } catch (err) {
      const error = toFailure(err).message;
      idb.finishApproval(id, 'failed', null, error);
      comment(row.taskId, `Chủ đã duyệt lệnh ${what} (mã ${id}) nhưng lệnh KHÔNG hoàn tất: ${error}\nCó thể lệnh đã hoặc chưa có hiệu lực. Đừng thử lại ngay; hãy kiểm tra trạng thái bằng lệnh đọc trước rồi báo người dùng.`);
    }
    deps.attention.resolve(attentionKey(id));
    deps.audit.log({ actor: 'user', action: 'integration.approve', target: `${row.integrationId}:${row.command}`, detail: { approvalId: id, always: !!opts.always } });
    const done = idb.getApproval(id)!;
    emit(done);
    return toApproval(done);
  }

  function reject(id: string): IntegrationApproval {
    const row = idb.getApproval(id);
    if (!row) throw new ApprovalError('not_found', 'Không tìm thấy yêu cầu duyệt này.');
    if (!idb.rejectApproval(id)) throw new ApprovalError('conflict', 'Yêu cầu này đã được xử lý.');
    deps.attention.resolve(attentionKey(id));
    comment(row.taskId, `Chủ đã TỪ CHỐI lệnh "${row.integrationId} ${row.command}" (mã ${id}); lệnh không chạy. Đừng chạy lệnh này hay cách tương đương; báo người dùng là chưa làm được và tiếp tục phần việc không cần lệnh đó.`);
    deps.audit.log({ actor: 'user', action: 'integration.reject', target: `${row.integrationId}:${row.command}`, detail: { approvalId: id } });
    const done = idb.getApproval(id)!;
    emit(done);
    return toApproval(done);
  }

  return {
    request,
    get,
    list: (status?: string): IntegrationApproval[] => idb.listApprovals(status).map(toApproval),
    approve,
    reject,
  };
}

export class ApprovalError extends Error {
  constructor(readonly code: 'not_found' | 'conflict', message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export type Approvals = ReturnType<typeof createApprovals>;
