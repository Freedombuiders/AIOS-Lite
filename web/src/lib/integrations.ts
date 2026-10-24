// Integrations API client + shared types (contract: docs/dev/INTEGRATIONS-PLAN.md).
import type { IntegrationGrant, IntegrationGrantSetting } from '@core/types';
import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api';

export type { IntegrationGrant, IntegrationGrantSetting };
export type IntegrationStatus = 'not_configured' | 'unchecked' | 'ok' | 'error';
export type IntegrationRisk = 'read' | 'write' | 'destructive';

export interface IntegrationField {
  key: string;
  label: string;
  kind: 'secret' | 'text';
  required: boolean;
  placeholder?: string;
  help?: string;
  /** secret: '••••abcd' or ''; text: the stored value */
  value: string;
}

export interface IntegrationCommand {
  name: string;
  access: 'read' | 'write';
  risk: IntegrationRisk;
  usage: string;
  description: string;
}

export interface IntegrationSummary {
  id: string;
  name: string;
  category: string;
  description: string;
  docsUrl?: string;
  authKind: 'api-key' | 'oauth';
  group?: string;
  setupSteps: string[];
  fields: IntegrationField[];
  status: IntegrationStatus;
  statusDetail: string;
  accountLabel: string;
  checkedAt: string | null;
  commands: IntegrationCommand[];
  grantedTo: { agentId: string; grant: IntegrationGrant }[];
  calls24h: number;
}

export interface IntegrationApproval {
  id: number | string;
  integrationId: string;
  agentId: string;
  taskId: number | null;
  command: string;
  args: string;
  risk: IntegrationRisk;
  status: 'pending' | 'approved' | 'rejected';
  result?: unknown;
  error?: string;
  createdAt: string;
  decidedAt?: string;
}

export const GRANT_LEVELS: { value: IntegrationGrant; label: string; hint: string }[] = [
  { value: 'off', label: 'Tắt', hint: 'Agent không thấy integration này.' },
  { value: 'read', label: 'Chỉ đọc', hint: 'Chỉ chạy lệnh đọc; lệnh ghi bị chặn.' },
  { value: 'ask', label: 'Hỏi trước', hint: 'Đọc chạy ngay; lệnh ghi chờ bạn duyệt.' },
  { value: 'write', label: 'Đọc & ghi', hint: 'Được ghi trực tiếp; lệnh xoá/huỷ vẫn phải chờ duyệt.' },
];

export const grantLevel = (s: IntegrationGrantSetting | undefined): IntegrationGrant => (s === undefined ? 'off' : typeof s === 'string' ? s : s.grant);

/** Change the level but keep the per-command ask/allow lists when the setting is an object. */
export function withGrant(prev: IntegrationGrantSetting | undefined, level: IntegrationGrant): IntegrationGrantSetting {
  return prev && typeof prev === 'object' ? { ...prev, grant: level } : level;
}

export const RISK_LABEL: Record<IntegrationRisk, string> = { read: 'Đọc', write: 'Ghi', destructive: 'Nguy hiểm' };

const base = (id: string) => `/integrations/${encodeURIComponent(id)}`;

export const listIntegrations = () => apiGet<{ items: IntegrationSummary[] }>('/integrations');
export const saveIntegration = (id: string, values: Record<string, string>) => apiPut<IntegrationSummary>(base(id), { values });
export const testIntegration = (id: string) => apiPost<{ ok: boolean; detail: string; accountLabel?: string }>(`${base(id)}/test`);
export const disconnectIntegration = (id: string) => apiDelete<{ ok: true }>(base(id));

export const getAgentGrants = (agentId: string) => apiGet<{ grants: Record<string, IntegrationGrantSetting> }>(`/agents/${encodeURIComponent(agentId)}/integrations`);
export const saveAgentGrants = (agentId: string, grants: Record<string, IntegrationGrantSetting>) =>
  apiPut<{ grants: Record<string, IntegrationGrantSetting> }>(`/agents/${encodeURIComponent(agentId)}/integrations`, { grants });

export const listApprovals = (status?: 'pending') => apiGet<{ items: IntegrationApproval[] }>(`/integrations/approvals${status ? `?status=${status}` : ''}`);
export const approveApproval = (id: number | string, always = false) => apiPost<IntegrationApproval>(`/integrations/approvals/${id}/approve`, always ? { always: true } : {});
export const rejectApproval = (id: number | string) => apiPost<IntegrationApproval>(`/integrations/approvals/${id}/reject`);

export const APPROVAL_KEY_PREFIX = 'integration:approval:';
export const approvalIdFromKey = (key: string): string | null => (key.startsWith(APPROVAL_KEY_PREFIX) ? key.slice(APPROVAL_KEY_PREFIX.length) : null);

export function excerpt(v: unknown, max = 160): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
