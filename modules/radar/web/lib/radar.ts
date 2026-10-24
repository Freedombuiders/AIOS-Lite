/** Radar thị trường — client side of the /api/m/radar/* contract. */
import type {
  IndexPayload, LayerConfig, LayerKey, RadarConfig,
} from '../../server/types';
import { apiGet, apiPost, apiPut } from '@/lib/api';

export type { IndexPayload, LayerConfig, LayerKey, RadarConfig };
export const LAYER_ORDER: LayerKey[] = ['vn', 'world', 'nganh'];

export interface RunInfo {
  id: number; layer: LayerKey; day: string; sessionKey: string | null;
  status: 'queued' | 'running' | 'ok' | 'error'; trigger: 'schedule' | 'manual';
  startedAt: string; finishedAt: string | null; phase: string | null; error: string | null;
  itemCount: number; costUsd: number;
}

export interface RadarStatus {
  enabled: boolean; timezone: string;
  running: RunInfo | null; queue: LayerKey[];
  schedule: { layer: LayerKey; label: string; time: string; enabled: boolean; lastDay: string | null; nextRunAt: string | null }[];
  tools: {
    apify: { configured: boolean; keys?: number };
    grok: { installed: boolean; path: string | null; loggedIn: boolean | null; detail: string };
    browser: { available: boolean; profileDir: string; detail: string };
    /** Local RSSHub (free Facebook, Threads, TikTok, Instagram feeds); absent on older servers. */
    rsshub?: { url: string; reachable: boolean; detail: string };
  };
  runs: RunInfo[];
}

export interface ReportSummary {
  date: string; layer: LayerKey; layerLabel: string; sessions: number;
  newPosts: number; newPains: number; items: number; updatedAt: string;
}

export const LAYER_LABEL: Record<LayerKey, string> = { vn: 'AI trong nước', world: 'Thế giới', nganh: 'Ngành nghề' };

const PHASE_LABEL: Record<string, string> = {
  collect: 'Thu thập', comments: 'Đọc bình luận', analyze: 'Phân tích AI', 'render-data': 'Dựng báo cáo', done: 'Xong',
};

/** Vietnamese label of a run phase (unknown phases pass through). */
export function phaseLabel(phase: string | null | undefined): string {
  return phase ? PHASE_LABEL[phase] ?? phase : '—';
}

export const radarApi = {
  index: () => apiGet<{ html: string; payload: IndexPayload }>('/api/m/radar/index'),
  reportHtml: (date: string, layer: string) =>
    apiGet<{ html: string }>(`/api/m/radar/reports/${encodeURIComponent(date)}/${encodeURIComponent(layer)}/html`),
  config: () => apiGet<{ config: RadarConfig; defaults: RadarConfig }>('/api/m/radar/config'),
  saveConfig: (config: RadarConfig) => apiPut<{ config: RadarConfig }>('/api/m/radar/config', config),
  resetConfig: () => apiPost<{ config: RadarConfig }>('/api/m/radar/config/reset'),
  setEnabled: (enabled: boolean) => apiPost<{ enabled: boolean }>('/api/m/radar/enabled', { enabled }),
  status: () => apiGet<RadarStatus>('/api/m/radar/status'),
  run: (layer: LayerKey) => apiPost<{ run: RunInfo }>('/api/m/radar/run', { layer }),
  runDetail: (id: number) => apiGet<{ run: RunInfo; log: string[] }>(`/api/m/radar/runs/${id}`),
  browserLogin: () => apiPost<{ ok: boolean; detail: string }>('/api/m/radar/browser/login'),
};

/** "2026-10-17" → "17/10/2026". */
export function fmtDate(day: string): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : day;
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}
