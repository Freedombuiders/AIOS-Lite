import { useEffect, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { fmtDate, fmtDateTime, LAYER_LABEL, phaseLabel, radarApi, type RadarStatus, type RunInfo } from '@modules/radar/web/lib/radar';

const STATUS: Record<RunInfo['status'], { label: string; cls: string }> = {
  queued: { label: 'Đang chờ', cls: 'text-[var(--color-text-muted)]' },
  running: { label: 'Đang chạy', cls: 'text-[var(--color-accent)]' },
  ok: { label: 'Xong', cls: 'text-[var(--color-status-success,#16a34a)]' },
  error: { label: 'Lỗi', cls: 'text-[var(--color-status-failed)]' },
};

export function RadarRuns({ status, loading, error }: { status: RadarStatus | null; loading: boolean; error: string | null }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const runs = status?.runs ?? [];
  if (!status) return <PageState loading={loading} error={error} />;
  if (!runs.length) return <PageState empty emptyTitle="Chưa có lần chạy nào" emptyDescription="Bấm “Chạy ngay” ở tab Báo cáo để quét thử." />;
  return (
    <div class="flex-1 min-h-0 overflow-auto px-6 py-4">
      <table class="w-full text-[12.5px]">
        <thead>
          <tr class="text-left text-[11.5px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
            {['Lớp', 'Ngày', 'Kích hoạt', 'Trạng thái', 'Giai đoạn', 'Bài', 'Chi phí', 'Bắt đầu', 'Kết thúc', 'Lỗi'].map((h) => <th key={h} class="py-2 pr-3 font-semibold">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} class="border-t border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-control-hover)]" onClick={() => setOpenId(r.id)}>
              <td class="py-2 pr-3">{LAYER_LABEL[r.layer]}</td>
              <td class="pr-3">{fmtDate(r.day)}</td>
              <td class="pr-3">{r.trigger === 'manual' ? 'Thủ công' : 'Lịch'}</td>
              <td class={`pr-3 font-medium ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</td>
              <td class="pr-3">{phaseLabel(r.phase)}</td>
              <td class="pr-3 tabular-nums">{r.itemCount}</td>
              <td class="pr-3 tabular-nums">${r.costUsd.toFixed(2)}</td>
              <td class="pr-3">{fmtDateTime(r.startedAt)}</td>
              <td class="pr-3">{fmtDateTime(r.finishedAt)}</td>
              <td class="pr-3 max-w-[260px] truncate text-[var(--color-status-failed)]" title={r.error ?? ''}>{r.error ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {openId !== null && <RunDrawer id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function RunDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const [data, setData] = useState<{ run: RunInfo; log: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const live = !data || data.run.status === 'running' || data.run.status === 'queued';

  useEffect(() => {
    let cancelled = false;
    const load = () => radarApi.runDetail(id).then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(String(e?.message ?? e)); });
    load();
    if (!live) return () => { cancelled = true; };
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [id, live]);

  return (
    <div class="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside role="dialog" aria-label="Nhật ký lần chạy" class="w-full max-w-[560px] h-full bg-[var(--color-card)] border-l border-[var(--color-border)] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div class="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
          <h2 class="text-[14px] font-semibold">Lần chạy #{id}{data ? ` · ${LAYER_LABEL[data.run.layer]}` : ''}</h2>
          <button type="button" aria-label="Đóng" class="ml-auto p-1 rounded hover:bg-[var(--color-control-hover)]" onClick={onClose}><X size={16} /></button>
        </div>
        <pre class="flex-1 overflow-auto p-4 text-[12px] leading-relaxed whitespace-pre-wrap font-mono text-[var(--color-text)]">
          {err ? err : data ? (data.log.length ? data.log.join('\n') : 'Chưa có nhật ký.') : 'Đang tải…'}
        </pre>
      </aside>
    </div>
  );
}
