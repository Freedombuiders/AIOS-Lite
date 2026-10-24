/**
 * Building blocks of the P&L views (pages/Pnl.tsx and the dashboard's PnlSection): KPI tile, delta chip,
 * profit waterfall, statement table, revenue mix and the issue list. Read-only; styles in styles/pnl.css.
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { AlertTriangle, ChevronRight, Info, type LucideIcon } from 'lucide-preact';

import { useElementWidth } from '@/components/fb/charts/useElementWidth';
import { pct, vndFull, vndShort, type PnlIssue, type PnlLine, type WaterfallStep } from '../../lib/pnl';

export function Delta({ value, inverse = false, label }: { value: number | null; inverse?: boolean; label?: string }) {
  if (value === null || !Number.isFinite(value)) return null;
  const up = value >= 0;
  const good = inverse ? !up : up;
  return (
    <span class={`pl-delta ${good ? 'is-good' : 'is-bad'}`} title={label}>
      {up ? '▲' : '▼'} {pct(Math.abs(value), Math.abs(value) >= 1 ? 0 : 1)}
    </span>
  );
}

export function KpiTile({ label, value, sub, delta, deltaInverse, tone, icon: Icon, title, compare }: {
  label: string; value: string; sub?: ComponentChildren; delta?: number | null; deltaInverse?: boolean;
  tone?: 'good' | 'bad' | 'neutral'; icon?: LucideIcon; title?: string; compare?: string;
}) {
  return (
    <div class={`pl-kpi${tone ? ` is-${tone}` : ''}`} title={title}>
      <div class="pl-kpi-label">{Icon ? <Icon size={14} /> : null}{label}</div>
      <div class="pl-kpi-value">{value}</div>
      <div class="pl-kpi-foot">
        {delta !== undefined ? <Delta value={delta ?? null} inverse={deltaInverse} label={compare} /> : null}
        {sub ? <span class="pl-kpi-sub">{sub}</span> : null}
      </div>
    </div>
  );
}

const GOOD = '#1f9d6b';
const BAD = '#e05a5a';
const START = '#3987e5';

/** Gross revenue down to net profit. Bars float between running totals; a negative result drops below zero. */
export function Waterfall({ steps, height = 240 }: { steps: WaterfallStep[]; height?: number }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(520);
  const [active, setActive] = useState<number | null>(null);
  if (!steps.length) return null;
  const pad = { left: 8, right: 8, top: 22, bottom: 50 };
  const bars: Array<{ s: WaterfallStep; y0: number; y1: number }> = [];
  let run = 0;
  for (const s of steps) {
    if (s.kind === 'start') { bars.push({ s, y0: 0, y1: s.value }); run = s.value; }
    else if (s.kind === 'total') bars.push({ s, y0: 0, y1: s.value });
    else { bars.push({ s, y0: run, y1: run + s.value }); run += s.value; }
  }
  const vals = bars.flatMap((b) => [b.y0, b.y1]);
  const hi = Math.max(0, ...vals);
  const lo = Math.min(0, ...vals);
  const span = hi - lo || 1;
  const plotH = height - pad.top - pad.bottom;
  const slot = (width - pad.left - pad.right) / bars.length;
  const bw = Math.min(54, slot * 0.62);
  const y = (v: number) => pad.top + ((hi - v) / span) * plotH;
  const x = (i: number) => pad.left + i * slot + (slot - bw) / 2;
  return (
    <div ref={ref} class="pl-waterfall" style={{ height: `${height}px` }} onMouseLeave={() => setActive(null)}>
      <svg width={width} height={height} role="img" aria-label={steps.map((s) => `${s.label} ${vndShort(s.value)}`).join(', ')}>
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--color-border-strong)" />
        {bars.map((b, i) => {
          const top = y(Math.max(b.y0, b.y1));
          const h = Math.max(2, Math.abs(y(b.y0) - y(b.y1)));
          const color = b.s.kind === 'start' ? START : b.s.kind === 'total' ? (b.s.value >= 0 ? GOOD : BAD) : BAD;
          const next = bars[i + 1];
          return (
            <g key={b.s.key} onMouseEnter={() => setActive(i)} opacity={active === null || active === i ? 1 : 0.5}>
              <rect x={x(i)} y={top} width={bw} height={h} rx={4} fill={color} opacity={b.s.kind === 'down' ? 0.82 : 1} />
              {next && next.s.kind === 'down' ? <line x1={x(i) + bw} x2={x(i + 1)} y1={y(b.s.kind === 'down' ? b.y1 : b.y1)} y2={y(b.s.kind === 'down' ? b.y1 : b.y1)} stroke="var(--color-border-strong)" stroke-dasharray="3 3" /> : null}
              <text x={x(i) + bw / 2} y={b.y1 >= b.y0 || b.s.kind !== 'down' ? (b.s.value < 0 && b.s.kind === 'total' ? top + h + 13 : top - 6) : top + h + 13}
                text-anchor="middle" font-size="11" font-weight="600" fill={b.s.kind === 'total' ? color : 'var(--color-text)'}>{vndShort(b.s.value)}</text>
              <text x={x(i) + bw / 2} y={height - 6} text-anchor="middle" font-size="10.5" fill="var(--color-text-muted)">{b.s.label}</text>
            </g>
          );
        })}
      </svg>
      {active !== null ? <div class="pl-tip" style={{ left: `${Math.min(width - 180, Math.max(0, x(active) - 60))}px` }}>{bars[active].s.label}: <strong>{vndFull(bars[active].s.value)}</strong></div> : null}
    </div>
  );
}

/** The P&L statement: top lines with expandable detail, share of net revenue, estimate badges. */
export function Statement({ lines, compact = false }: { lines: PnlLine[]; compact?: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>({ gross: true, marketing: true });
  const net = lines.find((l) => l.key === 'net')?.value ?? 0;
  const share = (v: number) => (net > 0 ? pct(Math.abs(v) / net, Math.abs(v) / net < 0.1 ? 1 : 0) : '—');
  const sign = (l: PnlLine) => (l.kind === 'deduction' || l.kind === 'cost' ? -1 : 1);
  return (
    <table class={`pl-statement${compact ? ' is-compact' : ''}`}>
      <thead><tr><th>Khoản mục</th><th class="num">Số tiền</th>{compact ? null : <th class="num">% DT thuần</th>}</tr></thead>
      <tbody>
        {lines.map((l) => {
          const kids = l.children?.filter((c) => c.value !== 0 || l.key === 'gross') ?? [];
          const expandable = kids.length > 0;
          const isOpen = !!open[l.key];
          return [
            <tr key={l.key} class={`is-${l.kind}${l.value < 0 && (l.kind === 'subtotal' || l.kind === 'result') ? ' is-negative' : ''}`}>
              <td>
                <button type="button" class="pl-st-label" disabled={!expandable} aria-expanded={expandable ? isOpen : undefined}
                  onClick={() => expandable && setOpen({ ...open, [l.key]: !isOpen })}>
                  {expandable ? <ChevronRight size={13} class={`pl-caret${isOpen ? ' is-open' : ''}`} /> : <span class="pl-caret-space" />}
                  <span>{l.kind === 'deduction' || l.kind === 'cost' ? '− ' : l.kind === 'subtotal' || l.kind === 'result' ? '= ' : ''}{l.label}</span>
                  {!l.exact ? <span class="pl-badge" title="Có phần ước tính hoặc thiếu dữ liệu, xem mục Cần chú ý">ước tính</span> : null}
                </button>
                {l.note && !compact ? <div class="pl-st-note">{l.note}</div> : null}
              </td>
              <td class="num" title={l.source}>{vndFull(sign(l) * l.value)}</td>
              {compact ? null : <td class="num pl-muted">{l.kind === 'subtotal' || l.kind === 'result' ? (l.value < 0 ? `−${share(l.value)}` : share(l.value)) : share(l.value)}</td>}
            </tr>,
            ...(isOpen ? kids.map((c) => (
              <tr key={c.key} class="is-child">
                <td><span class="pl-child-label" title={c.source}>{c.label}{!c.exact ? <span class="pl-badge">ước tính</span> : null}{c.note ? <em> · {c.note}</em> : null}</span></td>
                <td class="num" title={c.source}>{vndFull(sign(c) * c.value)}</td>
                {compact ? null : <td class="num pl-muted">{share(c.value)}</td>}
              </tr>
            )) : []),
          ];
        })}
      </tbody>
    </table>
  );
}

/** One stacked bar of revenue sources with their values. */
export function MixBar({ parts }: { parts: Array<{ label: string; value: number; color: string; hint?: string }> }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  if (total <= 0) return <p class="pl-muted text-xs">Chưa có doanh thu trong kỳ.</p>;
  return (
    <div>
      <div class="pl-mix" role="img" aria-label={parts.map((p) => `${p.label} ${pct(p.value / total, 0)}`).join(', ')}>
        {parts.filter((p) => p.value > 0).map((p) => <i key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${vndFull(p.value)}`} />)}
      </div>
      <ul class="pl-mix-legend">
        {parts.map((p) => (
          <li key={p.label} title={p.hint}>
            <span><i style={{ background: p.color }} />{p.label}</span>
            <strong>{vndShort(p.value)}</strong>
            <em>{pct(p.value / total, 0)}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IssueList({ issues, onAction, limit }: { issues: PnlIssue[]; onAction?: (a: NonNullable<PnlIssue['action']>) => void; limit?: number }) {
  if (!issues.length) return null;
  const shown = limit ? issues.slice(0, limit) : issues;
  return (
    <ul class="pl-issues" aria-label="Cần chú ý">
      {shown.map((i) => (
        <li key={i.text} class={`is-${i.level}`}>
          {i.level === 'warn' ? <AlertTriangle size={14} /> : <Info size={14} />}
          <span>{i.text}</span>
          {onAction && i.action && ACTION_LABEL[i.action] ? <button type="button" onClick={() => onAction(i.action!)}>{ACTION_LABEL[i.action]}</button> : null}
        </li>
      ))}
    </ul>
  );
}

const ACTION_LABEL: Record<NonNullable<PnlIssue['action']>, string> = {
  fx: 'Đặt tỷ giá', ads: 'Gán chiến dịch', ledger: 'Mở sổ thu chi', erp: 'Xem ERP', whop: 'Kết nối',
};

/** A thin labelled meter, e.g. ads spent against the ads fund. */
export function Meter({ value, max, color, label }: { value: number; max: number; color: string; label: string }) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return <div class="pl-meter" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}><i style={{ width: `${w}%`, background: color }} /></div>;
}
