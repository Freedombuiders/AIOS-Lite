/** Radar thị trường › one report: iframe viewer with hash sync. */
import { useEffect, useState } from 'preact/hooks';
import { Link, useParams } from 'wouter-preact';
import { ArrowLeft, ExternalLink, Play } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { BTN, apiFail } from '@modules/radar/web/components/ui';
import { pushToast } from '@/lib/toasts';
import { LAYER_LABEL, fmtDate, radarApi, type LayerKey } from '@modules/radar/web/lib/radar';
import { ReportFrame } from './ReportFrame';

export function RadarReportPage() {
  const params = useParams<{ date: string; layer: string }>();
  const { date, layer } = params;
  const [html, setHtml] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'missing' | 'error'>('loading');
  const [error, setError] = useState('');
  const label = LAYER_LABEL[layer as LayerKey] ?? layer;

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setState('loading');
    radarApi.reportHtml(date, layer).then((r) => {
      if (!cancelled) setHtml(r.html);
    }).catch((err) => {
      if (cancelled) return;
      const f = apiFail(err);
      setError(f.message);
      setState(f.status === 404 ? 'missing' : 'error');
    });
    return () => { cancelled = true; };
  }, [date, layer]);

  async function rerun() {
    try {
      await radarApi.run(layer as LayerKey);
      pushToast({ tone: 'success', title: `Đã xếp lịch chạy lớp ${label}` });
    } catch (err) {
      const f = apiFail(err);
      pushToast({ tone: f.status === 409 ? 'warn' : 'error', title: f.status === 409 ? 'Lớp này đang chạy hoặc đã xếp hàng' : 'Không chạy được', description: f.message });
    }
  }

  function fullscreen() {
    if (!html) return;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <div class="flex flex-col h-full min-h-0">
      <div class="shrink-0 flex flex-wrap items-center gap-3 px-6 py-2 border-b border-[var(--color-border)]">
        <Link href="/m/radar" class="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          <ArrowLeft size={14} /> Radar thị trường
        </Link>
        <h1 class="text-[14px] font-semibold text-[var(--color-text)]">{label} · {fmtDate(date)}</h1>
        <div class="ml-auto flex items-center gap-2">
          <button type="button" class={BTN} onClick={rerun}><Play size={13} /> Chạy lại lớp này</button>
          <button type="button" class={BTN} onClick={fullscreen} disabled={!html}><ExternalLink size={13} /> Mở toàn màn hình</button>
        </div>
      </div>
      {state === 'missing' ? (
        <div class="workspace-state">
          <h2>Chưa có báo cáo cho ngày này</h2>
          <p>{error || 'Lớp này chưa chạy trong ngày đã chọn.'}</p>
          <Link href="/m/radar" class={BTN}>Quay lại Radar thị trường</Link>
        </div>
      ) : html === null ? (
        <PageState loading={state === 'loading'} error={state === 'error' ? error : null} />
      ) : (
        <ReportFrame html={html} title={`${label} ${fmtDate(date)}`} syncHash />
      )}
    </div>
  );
}
