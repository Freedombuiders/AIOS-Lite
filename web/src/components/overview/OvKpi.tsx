// One number of a Tổng quan section with its change against the previous period.
// `goodWhen` says which direction is good news (costs and response time: 'down').
import type { ComponentChildren } from 'preact';
import { delta } from '@/lib/overview-format';

export function OvKpis({ children }: { children: ComponentChildren }) {
  return <div class="ov-kpis">{children}</div>;
}

export function OvKpi({ label, value, cur, prev, goodWhen = 'up', hint }: {
  label: string;
  /** formatted current value */
  value: string;
  /** raw numbers for the change; leave prev undefined to hide it */
  cur?: number | null;
  prev?: number | null;
  goodWhen?: 'up' | 'down';
  hint?: string;
}) {
  // nothing to compare when the current value itself is unknown
  const d = prev === undefined || cur === null || cur === undefined ? null : delta(cur, prev);
  const tone = !d || d.pct === null || d.dir === 'flat' ? 'flat' : (d.dir === goodWhen ? 'good' : 'bad');
  return (
    <div class="ov-kpi">
      <span class="ov-kpi-label">{label}</span>
      <strong class="ov-kpi-value">{value}</strong>
      {d ? (
        <span class={`ov-kpi-delta is-${tone}`}>
          {d.pct === null ? 'chưa có kỳ trước để so' : `${d.dir === 'up' ? '▲' : d.dir === 'down' ? '▼' : '•'} ${Math.abs(d.pct * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}% so với kỳ trước`}
        </span>
      ) : hint ? <span class="ov-kpi-delta is-flat">{hint}</span> : null}
      {d && hint ? <span class="ov-kpi-hint">{hint}</span> : null}
    </div>
  );
}

/** Small "nguồn" chips: which data sources feed the section and whether they are connected. */
export function OvSources({ items }: { items: { label: string; ok: boolean; href?: string; detail?: string }[] }) {
  return (
    <div class="ov-sources" aria-label="Nguồn số liệu">
      {items.map((s) => {
        const body = <><i class={s.ok ? 'is-ok' : 'is-off'} aria-hidden="true" />{s.label}{s.ok ? '' : ': chưa kết nối'}</>;
        return s.href && !s.ok
          ? <a key={s.label} href={s.href} class="ov-source" title={s.detail}>{body}</a>
          : <span key={s.label} class="ov-source" title={s.detail}>{body}</span>;
      })}
    </div>
  );
}
