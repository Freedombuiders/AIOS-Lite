// "Khớp sổ bài học x/y" inside marketing's composer (provided as 'marketing.composerScore', drawing Content.dc.html).
// While the person types, only the code checks run (posting time, format, length: free). The opening type needs one
// agent run, so it is read only when the person asks (and the answer is cached by the text's hash on the server).
import { useEffect, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { apiPost, errorText } from '@/lib/api';
import type { ScoreDto } from '@modules/learn/web/lib/types';

export interface ComposerScoreProps {
  text: string;
  /** marketing format: reel, video, photo, album, text, link */
  format: string;
  /** unix seconds, null when not scheduled */
  scheduledAt: number | null;
  hasVideo: boolean;
  videoLengthS?: number | null;
}

const DEBOUNCE_MS = 700;

export function ScoreBox(props: ComposerScoreProps) {
  const [data, setData] = useState<ScoreDto | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const payload = { text: props.text, format: props.format, scheduledAt: props.scheduledAt, hasVideo: props.hasVideo, videoLengthS: props.videoLengthS ?? null };
  const key = JSON.stringify(payload);

  const run = async (hook: boolean) => {
    const my = ++seq.current;
    if (hook) setBusy(true);
    try {
      const r = await apiPost<ScoreDto>('/api/m/learn/score-draft', { ...payload, hook });
      if (my === seq.current) {
        setData(r);
        setErr('');
      }
    } catch (e) {
      if (my === seq.current) setErr(errorText(e));
    } finally {
      if (hook) setBusy(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void run(false), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key]);

  if (err) return <div class="text-[12px] text-[var(--color-text-faint)]">Chưa chấm được theo sổ bài học: {err}</div>;
  if (!data || data.state !== 'ok') return null;
  if (data.checkable === 0) {
    return (
      <div class="rounded-lg border border-[var(--color-border)] px-3 py-2 text-[12.5px] text-[var(--color-text-muted)]">
        Sổ bài học chưa có bài học đã kiểm chứng nào máy kiểm được. <Link href="/m/learn/playbook" class="underline">Mở sổ bài học</Link>
      </div>
    );
  }
  const misses = data.lessons.flatMap((l) => l.checks.filter((c) => c.ok === false).map((c) => c.text));
  const hits = data.lessons.flatMap((l) => l.checks.filter((c) => c.ok === true).map((c) => c.text));
  return (
    <section class="flex items-start gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2" aria-label="Khớp sổ bài học">
      <span class="shrink-0 text-[20px] font-semibold tabular-nums" style={{ color: data.matched === data.checkable ? 'var(--color-status-done)' : 'var(--color-text)' }}>
        {data.matched}/{data.checkable}
      </span>
      <div class="flex min-w-0 flex-col gap-0.5 text-[12.5px]">
        <span class="font-semibold">Khớp sổ bài học</span>
        {hits.length > 0 && <span class="text-[var(--color-text-muted)]">{hits.join('. ')}.</span>}
        {misses.length > 0 && <span>Chưa khớp: {misses.join('. ')}.</span>}
        {data.hook.note && <span class="text-[var(--color-text-faint)]">{data.hook.note}</span>}
        <span class="flex flex-wrap items-center gap-2">
          {data.needsHook && (
            <button type="button" class="control-button" disabled={busy} onClick={() => void run(true)}>{busy ? 'Đang đọc câu mở đầu…' : 'Chấm cả kiểu mở đầu'}</button>
          )}
          <Link href="/m/learn/playbook" class="text-[12px]">Xem bài học</Link>
        </span>
      </div>
    </section>
  );
}
