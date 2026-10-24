// Shared types and helpers for the Marketing pages (templates and the
// broadcasts that use them). Shapes mirror src/zalo/routes-templates.ts.

import { tokenizedSseUrl } from '@/lib/api';
import type { ZaloStyle } from '@/lib/richText';

export type { ZaloStyle } from '@/lib/richText';

export type MediaKind = 'image' | 'file' | 'video';

export interface MarketingAttachment {
  mediaId: number;
  name: string;
  kind: MediaKind;
}

export interface MarketingTemplate {
  id: number;
  name: string;
  text: string;
  styles: ZaloStyle[];
  attachments: MarketingAttachment[];
  createdAt: number;
  updatedAt: number;
}

export interface TemplateVariable {
  name: string;
  description: string;
  example: string;
}

export const MAX_TEMPLATE_IMAGES = 12;
export const MAX_TEMPLATE_FILES = 5;
export const MAX_TEMPLATE_TEXT = 4000;

/** Same-origin URL that serves an uploaded file (carries the dashboard token). */
export function mediaUrl(mediaId: number): string {
  return tokenizedSseUrl(`/api/zalo/media/${mediaId}/raw`);
}

/** "3 ảnh · 1 tệp", or '' when there is nothing attached. */
export function attachmentSummary(attachments: MarketingAttachment[]): string {
  const images = attachments.filter((a) => a.kind === 'image').length;
  const files = attachments.length - images;
  return [images ? `${images} ảnh` : '', files ? `${files} tệp` : ''].filter(Boolean).join(' · ');
}

/** Vietnamese relative time from unix seconds ("5 phút trước"). */
export function formatVnRelative(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} ngày trước`;
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)} tháng trước`;
  return `${Math.floor(diff / 86400 / 365)} năm trước`;
}

/** "dd/MM/yyyy HH:mm" in Asia/Ho_Chi_Minh from unix seconds. */
export function formatVnDateTime(unixSeconds: number): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(unixSeconds * 1000)).map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** "HH:mm · dd/MM/yyyy" from a 'YYYY-MM-DD' wall date and an 'HH:mm' time. */
export function formatSchedule(date: string, time: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return `${time} · ${m ? `${m[3]}/${m[2]}/${m[1]}` : date}`;
}

export function errorMessage(err: unknown): string {
  const body = (err as { body?: { error?: string } })?.body;
  return body?.error || (err instanceof Error ? err.message : String(err));
}
