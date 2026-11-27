// Đội AI · Bot screen: types and calls of /api/genbot (src/api/routes/genbot.ts). No response ever carries a key.
import { apiDelete, apiGet, apiPost, apiPut } from './api';
import type { DoctorCheck } from './api-types';

export interface GenbotKeyView {
  hasKey: boolean;
  last4: string;
  /** store: pasted in the app (encrypted); env: older setup with GENBOT_KEY_* in .env */
  source: 'store' | 'env' | null;
  keyEnv?: string;
  updatedAt: string | null;
}

export interface GenbotCheck {
  ok: boolean;
  message: string;
  at: string;
}

export interface GenbotBot {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
  botId: string;
  baseUrl: string;
  connected: boolean;
  key: GenbotKeyView;
  lastCheck: GenbotCheck | null;
  runsToday: number;
  maxRunsDay: number;
  context: 'lean' | 'standard';
  usedBy: string[];
  brain: { folder: string; read: string[]; write: string[] }[];
  modules: Record<string, string[]>;
}

export type GenbotTemplateId = 'cskh' | 'noi-dung' | 'tro-ly';

export interface GenbotTemplate {
  id: GenbotTemplateId;
  label: string;
  hint: string;
  context: 'lean' | 'standard';
  brain: { read: string[]; write: string[] };
  memory: { team: boolean; private: boolean };
  modules: Record<string, string[]>;
}

export interface GenbotOverview {
  baseUrl: string;
  defaultBaseUrl: string;
  bots: GenbotBot[];
  /** agents on an engine of an earlier version; runtimeLabel is its display name (from the server) */
  legacy: { id: string; name: string; runtime: string; runtimeLabel?: string; enabled: boolean }[];
  templates: GenbotTemplate[];
  brainFolders: { id: string; name: string }[];
}

export interface GenbotProbeResult {
  status: string;
  checks: DoctorCheck[];
  summary: GenbotCheck;
}

export interface NewBotInput {
  name: string;
  role: string;
  botId: string;
  key?: string;
  baseUrl?: string;
  template: GenbotTemplateId;
  brainFolder?: string;
}

export const GENBOT_PATH = '/genbot';

export const genbotApi = {
  overview: () => apiGet<GenbotOverview>(GENBOT_PATH),
  guide: () => apiGet<{ markdown: string }>(`${GENBOT_PATH}/guide`),
  saveConnection: (baseUrl: string, applyToAll: boolean) => apiPut<GenbotOverview & { updated: number }>(`${GENBOT_PATH}/connection`, { baseUrl, applyToAll }),
  checkConnection: (baseUrl: string) => apiPost<{ ok: boolean; baseUrl: string; checks: DoctorCheck[] }>(`${GENBOT_PATH}/connection/check`, { baseUrl }),
  probe: (input: { botId: string; key?: string; baseUrl?: string; agentId?: string }) => apiPost<GenbotProbeResult>(`${GENBOT_PATH}/probe`, input),
  create: (input: NewBotInput) => apiPost<GenbotBot>(`${GENBOT_PATH}/bots`, input),
  update: (id: string, patch: { name?: string; role?: string; botId?: string; baseUrl?: string; maxRunsDay?: number }) => apiPut<GenbotBot>(`${GENBOT_PATH}/bots/${encodeURIComponent(id)}`, patch),
  setKey: (id: string, key: string) => apiPut<GenbotBot>(`${GENBOT_PATH}/bots/${encodeURIComponent(id)}/key`, { key }),
  check: (id: string) => apiPost<GenbotProbeResult & { bot: GenbotBot }>(`${GENBOT_PATH}/bots/${encodeURIComponent(id)}/check`, {}),
  pause: (id: string, paused: boolean) => apiPost<GenbotBot>(`${GENBOT_PATH}/bots/${encodeURIComponent(id)}/pause`, { paused }),
  remove: (id: string) => apiDelete<{ ok: true }>(`${GENBOT_PATH}/bots/${encodeURIComponent(id)}`),
  convert: (id: string) => apiPost<GenbotBot>(`${GENBOT_PATH}/bots/${encodeURIComponent(id)}/convert`, {}),
};

/** "Đã có khoá ••••WXYZ" / "Khoá trong .env" / "Chưa có khoá". */
export function keyLabel(k: GenbotKeyView): string {
  if (!k.hasKey) return 'Chưa có khoá';
  if (k.source === 'env') return `Khoá trong .env${k.keyEnv ? ` (${k.keyEnv})` : ''}`;
  return `Đã có khoá${k.last4 ? ` ••••${k.last4}` : ''}`;
}

export function botState(b: GenbotBot): { label: string; tone: 'success' | 'warn' | 'neutral' | 'error' } {
  if (!b.connected) return { label: 'Chưa nối GenBot', tone: 'warn' };
  if (!b.enabled) return { label: 'Tạm dừng', tone: 'neutral' };
  if (b.lastCheck && !b.lastCheck.ok) return { label: 'Lỗi kết nối', tone: 'error' };
  return { label: 'Đang trực', tone: 'success' };
}

export function initials(name: string): string {
  const words = name.replace(/^Bot\s+/i, '').trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || 'B';
}
