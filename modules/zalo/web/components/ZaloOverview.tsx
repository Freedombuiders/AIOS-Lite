// "Bán hàng qua Zalo" body for the Tổng quan overview slot. Numbers come from GET /api/m/zalo/overview
// (counts and timings only). Orders and revenue are not tracked from Zalo yet.
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { OvKpi, OvKpis } from '@/components/overview/OvKpi';
import { LineChart } from '@/components/fb/charts/LineChart';
import { Legend } from '@/components/fb/charts/Legend';
import { SERIES, ORANGE, dayLabel, niceTicks } from '@/components/fb/charts/chart-utils';
import { fmtCount, fmtMinutes, fmtRate } from '@/lib/overview-format';
import { useFetch } from '@/lib/useFetch';
import type { OverviewRange } from '@/module-host/contracts';

interface Period {
  customers: number;
  newCustomers: number;
  customerMessages: number;
  replies: number;
  answeredRate: number | null;
  medianResponseMin: number | null;
  aiShare: number | null;
}
export interface ZaloOverviewData {
  hasAccount: boolean;
  current: Period;
  previous: Period;
  series: Array<{ date: string; customerMessages: number; replies: number; newCustomers: number }>;
  waiting: {
    count: number | null;
    over30m: number | null;
    top: Array<{ threadId: number; name: string; accountId: string; accountName: string; minutes: number }>;
  };
}

const CARE_INBOX = '/m/care/inbox';

export function ZaloOverview({ range }: { range: OverviewRange }) {
  const [groups, setGroups] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const qs = new URLSearchParams({ from: range.from, to: range.to, prevFrom: range.prevFrom, prevTo: range.prevTo, groups: groups ? '1' : '0' });
  const { data, loading, error } = useFetch<ZaloOverviewData>(`/api/m/zalo/overview?${qs}`, 60_000);

  if (!data) {
    return <p class="ov-sub">{error ? `Không tải được số liệu Zalo: ${error}` : loading ? 'Đang tải…' : ''}</p>;
  }
  const { current: c, previous: p, series, waiting } = data;

  const toggle = (
    <label style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '12.5px', color: 'var(--color-text-muted)' }}>
      <input type="checkbox" checked={groups} onChange={(e) => setGroups((e.currentTarget as HTMLInputElement).checked)} />
      Gồm cả nhóm
    </label>
  );

  if (!data.hasAccount || (c.customerMessages === 0 && c.replies === 0 && !waiting.count)) {
    return (
      <div class="ov-empty">
        <p>
          {data.hasAccount
            ? 'Chưa có tin nhắn Zalo nào trong khoảng thời gian này.'
            : 'Chưa kết nối tài khoản Zalo nào.'}{' '}
          <Link href="/m/zalo">Mở trang Tài khoản Zalo</Link>
        </p>
        <p class="ov-sub">Đơn hàng và doanh thu chưa được theo dõi từ Zalo.</p>
        {data.hasAccount ? toggle : null}
      </div>
    );
  }

  const max = Math.max(1, ...series.map((s) => Math.max(s.customerMessages, s.replies)));
  const ticks = niceTicks(0, max, 4);
  const labels = series.map((s) => dayLabel(s.date));
  const a = active !== null ? series[active] : null;

  return (
    <div>
      <OvKpis>
        <OvKpi label="Khách nhắn tin" value={fmtCount(c.customers)} cur={c.customers} prev={p.customers} />
        <OvKpi label="Khách mới" value={fmtCount(c.newCustomers)} cur={c.newCustomers} prev={p.newCustomers} />
        <OvKpi label="Tỉ lệ được trả lời" value={fmtRate(c.answeredRate, 0)} cur={c.answeredRate} prev={p.answeredRate} hint="trong 24 giờ" />
        <OvKpi label="Thời gian phản hồi" value={fmtMinutes(c.medianResponseMin)} cur={c.medianResponseMin} prev={p.medianResponseMin} goodWhen="down" hint="trung vị" />
        <OvKpi label="AI trả lời" value={fmtRate(c.aiShare, 0)} cur={c.aiShare} prev={p.aiShare} hint="trên tổng tin trả lời" />
      </OvKpis>

      <div class="ov-grid" style={{ marginTop: '14px' }}>
        <div>
          <p class="ov-sub">Tin khách gửi và tin đã trả lời mỗi ngày (tin nhắn)</p>
          <Legend items={[{ label: 'Tin khách gửi', color: SERIES, kind: 'line' }, { label: 'Tin đã trả lời', color: ORANGE, kind: 'line' }]} />
          <LineChart
            labels={labels}
            series={[
              { name: 'Tin khách gửi', color: SERIES, values: series.map((s) => s.customerMessages), noDots: series.length > 31 },
              { name: 'Tin đã trả lời', color: ORANGE, values: series.map((s) => s.replies), noDots: series.length > 31 },
            ]}
            yTicks={ticks}
            fmtY={(v) => fmtCount(v)}
            active={active}
            onActive={setActive}
            ariaOf={(i) => `${labels[i]}: ${series[i]!.customerMessages} tin khách gửi, ${series[i]!.replies} tin đã trả lời`}
            groupLabel="Tin nhắn Zalo theo ngày"
          />
          <p class="ov-sub" style={{ minHeight: '1.2em', marginTop: '4px', fontWeight: 400 }}>
            {a ? `${dayLabel(a.date)}: ${fmtCount(a.customerMessages)} tin khách gửi · ${fmtCount(a.replies)} tin đã trả lời · ${fmtCount(a.newCustomers)} khách mới` : ''}
          </p>
        </div>
        <div>
          <p class="ov-sub">Đang chờ trả lời{waiting.count !== null ? ` (${fmtCount(waiting.count)})` : ''}</p>
          {waiting.top.length === 0 ? (
            <p class="ov-sub" style={{ fontWeight: 400 }}>Không có khách nào đang chờ.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {waiting.top.map((w) => (
                <li key={w.threadId}>
                  <Link href={CARE_INBOX} class="flex justify-between gap-2" style={{ color: 'var(--color-text)' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name || 'Khách Zalo'}</span>
                    <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>{fmtMinutes(w.minutes)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p class="ov-sub" style={{ marginTop: '8px', fontWeight: 400 }}>
            Chờ quá 30 phút: <strong>{fmtCount(waiting.over30m)}</strong>
          </p>
          {toggle}
        </div>
      </div>
      <p class="ov-sub" style={{ marginTop: '10px', fontWeight: 400, color: 'var(--color-text-muted)' }}>
        Đơn hàng và doanh thu chưa được theo dõi từ Zalo.
      </p>
    </div>
  );
}
