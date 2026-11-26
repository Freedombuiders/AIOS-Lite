// Shared pieces of the two "Mạng xã hội" screens (Tổng quan, Facebook). They read
// marketing's own analytics API; nothing here computes a metric.

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { RefreshCw } from 'lucide-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { deltaLabel, finite, toneColor, type Tone } from '@/components/fb/charts/chart-utils';
import { fmtCompact, fmtDec, fmtInt, fmtPct, type ChannelKpi } from '@modules/marketing/web/lib/fbstudio';
import { KpiTile, PageTabs } from '@modules/marketing/web/components/fb/common';
import { BTN, SELECT, type DashGate } from '@modules/marketing/web/components/fb/DashStates';

export const RANGES = [7, 28, 90] as const;
export const SOCIAL_PATH = '/m/marketing/social';
export const SOCIAL_FB_PATH = '/m/marketing/social/facebook';

const TABS = [
  { id: 'overview', label: 'Tổng quan', path: SOCIAL_PATH },
  { id: 'facebook', label: 'Facebook', path: SOCIAL_FB_PATH },
] as const;
export type SocialTab = (typeof TABS)[number]['id'];

const DAYS_KEY = 'aios.social.days';

/** The chosen range is shared by both screens for the length of the browser session. */
export function useSocialDays(): [number, (d: number) => void] {
  const [days, setDays] = useState<number>(() => {
    try {
      const v = Number(sessionStorage.getItem(DAYS_KEY));
      return (RANGES as readonly number[]).includes(v) ? v : 28;
    } catch { return 28; }
  });
  const set = (d: number) => {
    setDays(d);
    try { sessionStorage.setItem(DAYS_KEY, String(d)); } catch { /* private mode */ }
  };
  return [days, set];
}

/** Header (title, channel tabs, range, refresh) + Page picker + the gate's notice when Facebook is not ready. */
export function SocialShell({ active, gate, days, onDays, onRefresh, refreshing, children }: {
  active: SocialTab;
  gate: DashGate;
  days: number;
  onDays: (d: number) => void;
  onRefresh: () => void;
  refreshing: boolean;
  children: ComponentChildren;
}) {
  const [, navigate] = useLocation();
  const tabs = (
    <nav aria-label="Kênh" class="flex flex-wrap gap-1">
      {TABS.map((t) => <Tab key={t.id} label={t.label} active={active === t.id} onClick={() => navigate(t.path)} />)}
    </nav>
  );
  return (
    <div class="flex flex-col h-full">
      <PageHeader
        breadcrumb="Marketing"
        title="Mạng xã hội"
        tabs={tabs}
        actions={!gate.blocker && (
          <>
            <label class="flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
              Khoảng
              <select class={SELECT} value={days} aria-label="Khoảng thời gian" onChange={(e) => onDays(Number((e.target as HTMLSelectElement).value))}>
                {RANGES.map((d) => <option key={d} value={d}>{d} ngày qua</option>)}
              </select>
            </label>
            <button type="button" class={`${BTN} inline-flex items-center gap-1.5`} onClick={onRefresh} disabled={refreshing || !gate.pageId}>
              <RefreshCw size={13} class={refreshing ? 'animate-spin' : ''} /> Lấy số liệu mới
            </button>
          </>
        )}
      />
      <div class="flex-1 overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-4">
        {gate.blocker}
        {!gate.blocker && (
          <>
            {gate.pages.length > 1 && <PageTabs pages={gate.pages} value={gate.pageId} onChange={gate.setPageId} />}
            {children}
          </>
        )}
      </div>
    </div>
  );
}

/** Why a number is missing, per KPI. Shown instead of a 0. */
const ABSENT: Record<ChannelKpi['key'], string> = {
  followers: 'Chưa lấy được số người theo dõi.',
  reach: 'Facebook chưa trả reach theo ngày cho khoảng này.',
  er: 'Chưa có bài nào có số đo trong khoảng này.',
  interactions: 'Chưa có số đo bài hoặc lượt bấm link.',
  shareRate: 'Cần cả số lượt chia sẻ và reach.',
  commentsPerPost: 'Chưa có bài nào có số đo trong khoảng này.',
};

/** 4.280 · 38.400 as in the drawings; only millions are shortened. */
export function fmtCount(n: number | null | undefined): string {
  return finite(n) && Math.abs(n) >= 1_000_000 ? fmtCompact(n) : fmtInt(n);
}

export function kpiValueText(k: ChannelKpi): string {
  if (!finite(k.value)) return '–';
  if (k.unit === 'pct') return fmtPct(k.value);
  if (k.unit === 'permille') return `${fmtDec(k.value, 1)}‰`;
  return fmtCount(k.value);
}

/** One KPI with its change against the previous period; an unknown value stays "–" with the reason. */
export function SocialKpi({ k }: { k: ChannelKpi }) {
  let note: ComponentChildren;
  let tone: Tone = 'neutral';
  if (!finite(k.value)) {
    note = ABSENT[k.key];
  } else {
    const d = deltaLabel(k.delta, k.deltaUnit === 'pt' && k.unit === 'permille' ? 'permille' : k.deltaUnit);
    const extra = k.key === 'followers' && finite(k.extra) ? `${k.extra >= 0 ? '+' : '−'}${fmtInt(Math.abs(k.extra))} ròng` : null;
    if (d) tone = d.sign > 0 ? 'good' : d.sign < 0 ? 'warn' : 'neutral';
    note = d || extra
      ? `${extra ? `${extra}${d ? ' · ' : ''}` : ''}${d ? (d.sign === 0 ? 'Không đổi so với kỳ trước' : `${d.text} so với kỳ trước`) : ''}`
      : 'Chưa có kỳ trước để so.';
  }
  return (
    <KpiTile label={k.label} value={kpiValueText(k)} delta={<span style={{ color: toneColor(tone) }}>{note}</span>} />
  );
}

/**
 * Table twin of a chart for screen readers: the same numbers, read row by row.
 * Absent cells say so in words instead of reading as 0.
 */
export function SrTable({ id, caption, columns, rows }: { id?: string; caption: string; columns: string[]; rows: (string | number | null)[][] }) {
  return (
    // a table ignores width/overflow, so the clipping box is the wrapper
    <div class="sr-only">
    <table id={id}>
      <caption>{caption}</caption>
      <thead>
        <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((cell, j) => {
              const text = cell === null ? 'chưa có số liệu' : String(cell);
              return j === 0 ? <th key={j} scope="row">{text}</th> : <td key={j}>{text}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/** Short grey sentence for a block whose data the API does not have. */
export function AbsentNote({ children }: { children: ComponentChildren }) {
  return <p class="m-0 text-[13px] text-[var(--color-text-muted)]">{children}</p>;
}
