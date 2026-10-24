// Small display helpers for the Video Studio.
import type { StepActor } from './types';

export const ACTOR_LABEL: Record<StepActor, string> = { machine: 'Máy', ai: 'AI', owner: 'Bạn' };

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 83.4 -> "1:23" */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** 87.04 -> "87.0s" */
export function formatSecs(sec: number): string {
  return `${(Math.round(sec * 10) / 10).toFixed(1)}s`;
}

export function formatDurationMs(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

/** Black or white text for a #rrggbb tile; falls back to white. */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#14141a' : '#ffffff';
}

export function isHex(v: string | undefined): v is string {
  return !!v && /^#[0-9a-f]{6}$/i.test(v);
}

export const PROFILE_COLORS = ['#e5484d', '#f76b15', '#f5a623', '#30a46c', '#12a594', '#3e63dd', '#8e4ec6', '#d6409f'];

/** 83.46 -> "1:23.5" (timeline and marks, one decimal). */
export function formatTimeDec(sec: number): string {
  const t = Math.max(0, Math.round(sec * 10) / 10);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** Clock text for a range: "0:03 – 0:05" or just "0:14". */
export function formatRange(start: number, end?: number): string {
  return end !== undefined && end > start + 0.05 ? `${formatTimeDec(start)} – ${formatTimeDec(end)}` : formatTimeDec(start);
}

/** Composition size for a project aspect (what <hyperframes-player> needs as width/height). */
export function aspectSize(aspect: string): { w: number; h: number } {
  switch (aspect) {
    case '16:9': return { w: 1920, h: 1080 };
    case '1:1': return { w: 1080, h: 1080 };
    case '4:5': return { w: 1080, h: 1350 };
    default: return { w: 1080, h: 1920 };
  }
}
