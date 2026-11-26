// Video đã phân tích: the owner pastes public video links; each becomes a background job that measures the cuts
// and has a bot label the opening, structure and call to action. Only numbers and labels are kept.
import { useEffect, useState } from 'preact/hooks';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { apiDelete, apiPost, errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import { DreamHeader, useOverview } from './DreamHeader';
import { dateTime, LABEL_TEXT, lengthText, num, STEP_LABEL, type Channel, type Video } from './lib';

const INPUT =
  'px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none min-w-0';
const BTN_PRIMARY =
  'inline-flex items-center justify-center min-h-[40px] px-4 rounded-md bg-[var(--color-accent)] text-[13px] font-semibold text-[var(--color-on-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 border-0 cursor-pointer';
const BTN =
  'inline-flex items-center justify-center min-h-[36px] px-3 rounded-md border border-[var(--color-border-strong)] bg-transparent text-[12.5px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40 cursor-pointer';

interface QueueResult {
  queued: Video[];
  skipped: { input: string; reason: string }[];
}

export function VideosPage() {
  const overview = useOverview();
  const videos = useFetch<{ items: Video[] }>('/api/m/dream/videos');
  const channels = useFetch<{ items: Channel[] }>('/api/m/dream/channels');
  const [text, setText] = useState('');
  const [channelId, setChannelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<QueueResult['skipped']>([]);

  const items = videos.data?.items ?? [];
  const working = items.some((v) => v.status === 'queued' || v.status === 'running');
  useEffect(() => {
    if (!working) return;
    const id = setInterval(videos.refresh, 4000);
    return () => clearInterval(id);
  }, [working]);

  async function analyse() {
    setBusy(true);
    setSkipped([]);
    try {
      const r = await apiPost<QueueResult>('/api/m/dream/videos', { text, channelId: channelId || null });
      setSkipped(r.skipped);
      if (r.queued.length) {
        pushToast({ tone: 'success', title: `Đã xếp ${r.queued.length} video để phân tích`, description: 'Máy tải, đo rồi xoá file. Mỗi video mất vài phút.' });
        setText('');
      }
      videos.refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa phân tích được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const done = items.filter((v) => v.status === 'done').length;
  return (
    <div class="flex flex-col gap-4">
      <DreamHeader active="videos" overview={overview} aside={`${done} video đã phân tích${working ? ' · đang chạy' : ''}`} />

      <section class="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-[var(--color-text-muted)]">Dán link video công khai muốn học, mỗi dòng một link (tối đa 20)</span>
          <textarea class={`${INPUT} min-h-[72px] resize-y`} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} placeholder="https://www.youtube.com/shorts/..." />
        </label>
        <div class="flex flex-wrap items-end gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-[12px] text-[var(--color-text-muted)]">Thuộc kênh (không bắt buộc)</span>
            <select class={`${INPUT} h-10`} value={channelId} onChange={(e) => setChannelId((e.target as HTMLSelectElement).value)}>
              <option value="">Không gắn kênh</option>
              {(channels.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.handle}</option>)}
            </select>
          </label>
          <button type="button" class={BTN_PRIMARY} disabled={busy || !text.trim()} onClick={() => void analyse()}>Phân tích</button>
        </div>
        {skipped.length > 0 && (
          <ul class="m-0 flex flex-col gap-1 pl-4 text-[12.5px] text-[var(--color-text-muted)]">
            {skipped.map((s) => <li key={s.input}><code class="break-all">{s.input}</code>: {s.reason}</li>)}
          </ul>
        )}
        <span class="text-[12.5px] text-[var(--color-text-muted)]">Máy tải video (tối đa 720p, 200 MB), đo nhịp cắt, rồi xoá file. Video riêng tư hoặc cần đăng nhập sẽ được bỏ qua kèm lý do.</span>
      </section>

      {(videos.loading || videos.error || items.length === 0) && (
        <PageState loading={videos.loading} error={videos.error} empty={!videos.loading && !videos.error && items.length === 0} emptyTitle="Chưa có video nào" emptyDescription="Dán link một video bạn muốn học ở ô bên trên." />
      )}
      <div class="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(520px, 100%), 1fr))', alignItems: 'start' }}>
        {items.map((v) => <VideoCard key={v.id} v={v} onChange={videos.refresh} />)}
      </div>

      <span class="text-[12.5px] text-[var(--color-text-muted)]">Mỗi video đã phân tích lưu thành một ghi chú ở dream-100/video/. Nhịp cắt đo bằng máy nên chỉ là số xấp xỉ. Lời thoại, hình và nhạc không được lưu.</span>
    </div>
  );
}

function VideoCard({ v, onChange }: { v: Video; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const tone = v.status === 'done' ? 'success' : v.status === 'failed' ? 'error' : v.status === 'running' ? 'running' : 'queued';
  const statusText = v.status === 'done' ? 'Đã phân tích' : v.status === 'failed' ? 'Lỗi' : v.status === 'running' ? (STEP_LABEL[v.step ?? ''] ?? 'Đang chạy') : 'Đang chờ';

  async function act(kind: 'retry' | 'delete') {
    setBusy(true);
    try {
      if (kind === 'retry') await apiPost(`/api/m/dream/videos/${v.id}/retry`);
      else await apiDelete(`/api/m/dream/videos/${v.id}`);
      onChange();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa làm được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const label = (k: string | null) => (k ? LABEL_TEXT[k] ?? k : '—');
  const cuts = v.cuts_per_min === null ? '—' : `Khoảng ${num(v.cuts_per_min, 1)} lần cắt mỗi phút, ${num(v.cuts_first3s)} lần trong 3 giây đầu, cảnh dài nhất ${num(v.longest_scene_s, 1)} giây`;
  const cta = v.keu_goi ? `${label(v.keu_goi)}${v.giay_keu_goi !== null ? `, ở giây ${num(v.giay_keu_goi, 1)}` : ''}` : '—';
  return (
    <section class="flex flex-col gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-4">
      <div class="flex flex-wrap items-start gap-3">
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="break-words text-[15px] font-semibold">{v.title ?? <a href={v.url} target="_blank" rel="noreferrer noopener" class="break-all">{v.url}</a>}</span>
          <span class="text-[12.5px] text-[var(--color-text-muted)]">
            {[v.channel_handle ?? v.uploader, v.platform, lengthText(v.duration_s)].filter(Boolean).join(' · ')}
          </span>
          {v.views !== null && (
            <span class="text-[12.5px] text-[var(--color-text-muted)]">
              {num(v.views)} lượt xem · {num(v.likes)} lượt thích · {num(v.comments)} bình luận · đọc lúc {dateTime(v.captured_at)}
            </span>
          )}
        </div>
        <Pill tone={tone}>{statusText}</Pill>
      </div>
      {(v.status === 'done' || v.cuts_per_min !== null) && (
        <dl class="m-0 grid gap-x-3 gap-y-1.5 text-[13px]" style={{ gridTemplateColumns: '92px minmax(0, 1fr)' }}>
          <dt class="text-[var(--color-text-muted)]">Mở đầu</dt><dd class="m-0">{label(v.mo_dau)}</dd>
          <dt class="text-[var(--color-text-muted)]">Cấu trúc</dt><dd class="m-0">{label(v.cau_truc)}</dd>
          <dt class="text-[var(--color-text-muted)]">Nhịp cắt</dt><dd class="m-0">{cuts}</dd>
          <dt class="text-[var(--color-text-muted)]">Kêu gọi</dt><dd class="m-0">{cta}</dd>
        </dl>
      )}
      {v.label_note && <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">{v.label_note}</p>}
      {v.reason && <p class="m-0 text-[12.5px] text-[var(--color-status-failed)]">{v.reason}</p>}
      <div class="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-2">
        <span class="flex-1 break-all text-[12px] text-[var(--color-text-faint)]">{v.note_path ?? (v.status === 'failed' ? 'Không có ghi chú' : 'Chưa có ghi chú')}</span>
        {v.status === 'failed' && <button type="button" class={BTN} disabled={busy} onClick={() => void act('retry')}>Chạy lại</button>}
        {v.status !== 'running' && <button type="button" class={BTN} disabled={busy} onClick={() => void act('delete')}>Xoá khỏi danh sách</button>}
      </div>
    </section>
  );
}
