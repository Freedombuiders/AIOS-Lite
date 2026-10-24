/** Radar thị trường: report index, sources & schedule, run history. */
import { useEffect, useState } from 'preact/hooks';
import { useLocation, useSearch } from 'wouter-preact';
import { Play, Radio } from 'lucide-preact';
import { PageHeader, Tab } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { BTN, apiFail } from '@modules/radar/web/components/ui';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import { LAYER_LABEL, LAYER_ORDER, phaseLabel, radarApi, type LayerKey, type RadarStatus } from '@modules/radar/web/lib/radar';
import { ReportFrame } from './ReportFrame';
import { RadarSettings } from './RadarSettings';
import { RadarRuns } from './RadarRuns';

type TabKey = 'reports' | 'settings' | 'runs';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'reports', label: 'Báo cáo' },
  { key: 'settings', label: 'Kênh & lịch' },
  { key: 'runs', label: 'Lần chạy' },
];

export function RadarHome() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const raw = new URLSearchParams(search).get('tab');
  const tab: TabKey = raw === 'settings' || raw === 'runs' ? raw : 'reports';
  const status = useFetch<RadarStatus>('/api/m/radar/status');
  const busy = !!status.data?.running || (status.data?.queue.length ?? 0) > 0;

  // Poll every 5s only while something runs.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(status.refresh, 5000);
    return () => clearInterval(id);
  }, [busy]);

  function setTab(next: TabKey) {
    navigate(next === 'reports' ? '/m/radar' : `/m/radar?tab=${next}`, { replace: true });
  }

  return (
    <div class="flex flex-col h-full min-h-0">
      <PageHeader
        title="Radar thị trường"
        tabs={TABS.map((t) => <Tab key={t.key} label={t.label} active={tab === t.key} onClick={() => setTab(t.key)} />)}
        actions={<span class="hidden xl:inline text-[12px] text-[var(--color-text-muted)]">
          Ba ống kính mỗi ngày: AI trong nước 7h, Thế giới 12h, Ngành nghề 20h. Chỉ hiện thứ mới.
        </span>}
        compact
      />
      {tab === 'reports' && <ReportsTab status={status.data} onChanged={status.refresh} onChannels={() => setTab('settings')} />}
      {tab === 'settings' && <RadarSettings status={status.data} onChanged={status.refresh} />}
      {tab === 'runs' && <RadarRuns status={status.data} loading={status.loading} error={status.error} />}
    </div>
  );
}

function ReportsTab({ status, onChanged, onChannels }: { status: RadarStatus | null; onChanged: () => void; onChannels: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = status?.running ?? null;

  // Reload the index when a run finishes.
  const runKey = running ? `${running.id}:${running.status}` : 'idle';
  useEffect(() => {
    let cancelled = false;
    radarApi.index().then((r) => { if (!cancelled) { setHtml(r.html); setError(null); } })
      .catch((e) => { if (!cancelled) setError(apiFail(e).message); });
    return () => { cancelled = true; };
  }, [runKey]);

  async function run(layer: LayerKey) {
    try {
      await radarApi.run(layer);
      pushToast({ tone: 'success', title: `Đã xếp lịch chạy ${LAYER_LABEL[layer]}` });
      onChanged();
    } catch (err) {
      const f = apiFail(err);
      pushToast({ tone: f.status === 409 ? 'warn' : 'error', title: f.status === 409 ? `${LAYER_LABEL[layer]} đang chạy hoặc đã xếp hàng` : 'Không chạy được', description: f.message });
    }
  }

  const queued = (l: LayerKey) => !!status && (status.queue.includes(l) || status.running?.layer === l);

  return (
    <div class="flex flex-col flex-1 min-h-0">
      <div class="shrink-0 flex flex-wrap items-center gap-2 px-6 py-2 border-b border-[var(--color-border)]">
        {status && (
          <span data-testid="radar-chip" class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)]">
            <span class={`w-1.5 h-1.5 rounded-full ${running ? 'bg-[var(--color-status-running,#3b82f6)] animate-pulse' : status.enabled ? 'bg-[var(--color-status-success,#22c55e)]' : 'bg-[var(--color-text-faint)]'}`} />
            {running
              ? `Đang chạy ${LAYER_LABEL[running.layer]}${running.phase ? ` · ${phaseLabel(running.phase)}` : ''}`
              : status.enabled ? 'Lịch tự động: bật' : 'Lịch tự động: tắt'}
          </span>
        )}
        <div class="ml-auto flex flex-wrap gap-2">
          <button type="button" class={BTN} onClick={onChannels}><Radio size={12} /> Kênh theo dõi</button>
          {LAYER_ORDER.map((l) => (
            <button key={l} type="button" class={BTN} disabled={queued(l)} onClick={() => run(l)}>
              <Play size={12} /> Chạy ngay: {LAYER_LABEL[l]}
            </button>
          ))}
        </div>
      </div>
      {html === null
        ? <PageState loading={!error} error={error} />
        : <ReportFrame html={html} title="Radar thị trường" />}
    </div>
  );
}
