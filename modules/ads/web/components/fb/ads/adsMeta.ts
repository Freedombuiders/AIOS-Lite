import { fmtDec, fmtInt, type AdsAction, type AdsResultType } from '@modules/ads/web/lib/fbstudio';
import { BAD, GOOD, WARN } from '@/components/fb/charts/chart-utils';

export const ACTION_META: Record<AdsAction, { label: string; bg: string; fg: string }> = {
  off_now: { label: 'Tắt ngay', bg: 'color-mix(in srgb, #ef4444 24%, transparent)', fg: BAD },
  off: { label: 'Tắt', bg: 'color-mix(in srgb, #ef4444 16%, transparent)', fg: BAD },
  down: { label: 'Giảm 30%', bg: 'color-mix(in srgb, #ec835a 18%, transparent)', fg: 'color-mix(in srgb, #ec835a 60%, var(--color-text))' },
  refresh: { label: 'Làm mới creative', bg: 'color-mix(in srgb, #f59e0b 16%, transparent)', fg: WARN },
  watch: { label: 'Theo dõi', bg: 'var(--color-elevated)', fg: 'var(--color-text-muted)' },
  keep: { label: 'Giữ', bg: 'var(--color-elevated)', fg: 'var(--color-text-muted)' },
  up: { label: 'Tăng 20%', bg: 'color-mix(in srgb, #22c55e 16%, transparent)', fg: GOOD },
  clone: { label: 'Nhân bản', bg: 'color-mix(in srgb, #22c55e 16%, transparent)', fg: GOOD },
};

export const RESULT_META: Record<AdsResultType, { name: string; noun: string; cpa: string }> = {
  lead: { name: 'Lead đăng ký', noun: 'lead', cpa: 'CPL' },
  message: { name: 'Tin nhắn', noun: 'tin nhắn', cpa: 'Giá/tin nhắn' },
  purchase: { name: 'Đơn hàng', noun: 'đơn', cpa: 'CPA' },
  registration: { name: 'Đăng ký', noun: 'đăng ký', cpa: 'CPA' },
};

/** Ad account ids come as 'act_123…' or plain digits; Ads Manager wants the digits. */
export function adsManagerUrl(accountId: string): string {
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(accountId.replace(/^act_/, ''))}`;
}

/** Axis-friendly money: 8 tr, 110k, 12,5 (no currency symbol). */
export function moneyAxis(n: number, currency: string): string {
  if (currency === 'VND') {
    if (Math.abs(n) >= 1_000_000) return `${fmtDec(n / 1_000_000, n % 1_000_000 === 0 ? 0 : 1)} tr`;
    if (Math.abs(n) >= 1000) return `${fmtInt(n / 1000)}k`;
    return fmtInt(n);
  }
  return fmtDec(n, n >= 100 ? 0 : 1);
}

const PLACEMENT: Record<string, string> = {
  reels: 'Reels', facebook_reels: 'Reels', instagram_reels: 'Reels (IG)',
  feed: 'Bảng tin', facebook_feed: 'Bảng tin', instagram_feed: 'Bảng tin (IG)', instagram_stream: 'Bảng tin (IG)',
  stories: 'Stories', facebook_stories: 'Stories', instagram_stories: 'Stories (IG)',
  audience_network: 'Audience Network', an_classic: 'Audience Network', messenger_inbox: 'Hộp thư Messenger',
  right_hand_column: 'Cột phải', marketplace: 'Marketplace', search: 'Tìm kiếm', instream_video: 'Video xen kẽ',
};

export function placementLabel(raw: string): string {
  const key = raw.toLowerCase().trim();
  if (PLACEMENT[key]) return PLACEMENT[key];
  const t = key.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function statusLabel(raw: string): { text: string; warn: boolean } {
  const s = raw.toUpperCase();
  if (s === 'ACTIVE') return { text: 'Đang chạy', warn: false };
  if (s === 'PAUSED' || s === 'CAMPAIGN_PAUSED' || s === 'ADSET_PAUSED') return { text: 'Tạm dừng', warn: true };
  if (s === 'LEARNING') return { text: 'Đang học', warn: true };
  if (s === 'LEARNING_LIMITED') return { text: 'Học bị giới hạn', warn: true };
  if (s === 'ARCHIVED' || s === 'DELETED') return { text: 'Đã lưu trữ', warn: true };
  return { text: raw || '–', warn: false };
}

export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (typeof cur !== 'number' || typeof prev !== 'number' || !(prev > 0)) return null;
  return ((cur - prev) / prev) * 100;
}

/** Ads Manager filtered to one campaign. */
export function adsManagerCampaignUrl(accountId: string, campaignId: string): string {
  return `${adsManagerUrl(accountId)}&selected_campaign_ids=${encodeURIComponent(campaignId)}`;
}

/** Downloads rows as a UTF-8 CSV that Excel opens with Vietnamese intact (BOM, comma, CRLF). */
export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '') : v;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
