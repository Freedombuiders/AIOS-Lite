// Đề xuất hôm nay (DailyIdeas.dc.html): each morning code picks up to 2 formulas that fit the channel and 1 never
// tried, a bot words each pick. The owner gives one to the content bot (an idea in Kho nội dung with its lineage),
// leaves it for later, or drops it with a short reason (three drops lower that formula's priority).
import { useState } from 'preact/hooks';
import { PageState } from '@/components/PageState';
import { apiPost, errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import { DreamHeader, useOverview } from './DreamHeader';
import { num, PLATFORM_LABEL, vsMedianText, type Idea, type IdeasDto } from './lib';

const INPUT =
  'px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none min-w-0';
const BTN_PRIMARY =
  'inline-flex items-center justify-center min-h-[40px] px-4 rounded-md bg-[var(--color-accent)] text-[13px] font-semibold text-[var(--color-on-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 border-0 cursor-pointer';
const BTN =
  'inline-flex items-center justify-center min-h-[36px] px-3 rounded-md border border-[var(--color-border-strong)] bg-transparent text-[12.5px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40 cursor-pointer';
const CARD = 'rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]';

const TAGS = {
  sure: { tag: 'Công thức đã hợp', bg: 'rgba(70,194,138,0.16)', fg: '#46c28a', edge: '#46c28a' },
  test: { tag: 'Đang thử', bg: 'rgba(109,141,255,0.18)', fg: '#a9bbff', edge: '#6d8dff' },
  fresh: { tag: 'Thử cái mới', bg: 'rgba(240,178,74,0.16)', fg: '#f0b24a', edge: '#f0b24a' },
};

function tagOf(i: Idea) {
  if (i.kind === 'thu') return TAGS.fresh;
  return i.formula?.state === 'hop' ? TAGS.sure : TAGS.test;
}

const STATUS_TEXT: Record<Idea['status'], string> = { new: '', later: 'Để mai', given: 'Đã giao Bot Nội dung', rejected: 'Đã bỏ' };

function dayText(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  const wd = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'][dt.getUTCDay()];
  return `${wd} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

export function IdeasPage() {
  const overview = useOverview();
  const ideas = useFetch<IdeasDto>('/api/m/dream/ideas');
  const [running, setRunning] = useState(false);
  const d = ideas.data;

  async function runNow() {
    setRunning(true);
    try {
      const r = await apiPost<{ written: number; state: string }>('/api/m/dream/ideas/run');
      pushToast({ tone: r.written ? 'success' : 'info', title: r.written ? `Có ${r.written} đề xuất` : 'Chưa có đề xuất nào', description: r.written ? undefined : 'Xem lý do ở đầu trang.' });
      ideas.refresh();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa chạy được', description: errorText(e) });
    } finally {
      setRunning(false);
    }
  }

  const aside = d ? `${dayText(d.day)}${d.run?.note_path ? ` · ${d.run.note_path}` : ''}` : undefined;
  return (
    <div class="flex flex-col gap-4">
      <DreamHeader active="ideas" overview={overview} aside={aside} />
      {(ideas.loading || ideas.error) && <PageState loading={ideas.loading} error={ideas.error} />}
      {d && (
        <div class="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', alignItems: 'start' }}>
          <div class="flex flex-col gap-3" style={{ gridColumn: 'span 2 / span 2' }}>
            {!d.run && (
              <section class={`${CARD} flex flex-wrap items-center gap-3 p-4`}>
                <span class="flex-1 text-[13px] text-[var(--color-text-muted)]">Đề xuất hôm nay chưa chạy. Máy tự chạy lúc 7 giờ sáng, hoặc khi mở app sau giờ đó.</span>
                <button type="button" class={BTN_PRIMARY} disabled={running} onClick={() => void runNow()}>Chạy ngay</button>
              </section>
            )}
            {d.run?.log && (
              <ul class="m-0 flex flex-col gap-1 rounded-lg border border-[var(--color-border)] px-4 py-3 pl-8 text-[12.5px] text-[var(--color-text-muted)]">
                {d.run.log.split('\n').map((l) => <li key={l}>{l}</li>)}
              </ul>
            )}
            {d.run && d.items.length === 0 && !d.run.log && <PageState empty emptyTitle="Hôm nay không có đề xuất" emptyDescription="Không đủ công thức để chọn. Máy không bịa thêm đề xuất." />}
            {d.items.map((i) => <IdeaCard key={`${i.day}-${i.slot}`} i={i} onChange={ideas.refresh} />)}
          </div>
          <aside class="flex flex-col gap-3">
            <section class={`${CARD} flex flex-col gap-2 p-4 text-[13px]`}>
              <h2 class="m-0 text-[14px] font-semibold">Máy chọn đề xuất thế nào</h2>
              <ul class="m-0 flex flex-col gap-1 pl-4 text-[var(--color-text-muted)]">
                <li>Hai bài theo công thức đã hợp hoặc có vẻ hợp với kênh mình.</li>
                <li>Một bài thử công thức chưa từng làm, để có cái mới mà học.</li>
                <li>Không lặp một trụ cột đã có bài trong 7 ngày.</li>
                <li>Ưu tiên công thức vừa có video mới hôm nay; công thức bị bỏ ba lần xếp sau.</li>
                <li>Ít công thức thì ít đề xuất, không bịa thêm. Chỉ lấy cấu trúc; lời, hình, nhạc là của mình.</li>
              </ul>
            </section>
            <section class={`${CARD} flex flex-col gap-1 p-4 text-[13px]`}>
              <h2 class="m-0 text-[14px] font-semibold">Đề xuất mấy hôm trước ra sao</h2>
              <span class="text-[var(--color-text-muted)]">
                Trong 30 ngày: {d.history.suggested} đề xuất, bạn giao {d.history.given}, bỏ {d.history.rejected} vì không hợp, {d.history.later} để lại.
              </span>
            </section>
            <section class={`${CARD} flex flex-col gap-1 p-4 text-[13px]`}>
              <h2 class="m-0 text-[14px] font-semibold">Sau khi đăng</h2>
              <span class="text-[var(--color-text-muted)]">
                Bài được lưu kèm tên công thức, phiên bản, video đã học theo và kỳ vọng cố định lúc đề xuất. Sau 24 giờ và 7 ngày, máy so bài với các bài khác của kênh ở cùng mốc rồi cập nhật công thức.
              </span>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

function IdeaCard({ i, onChange }: { i: Idea; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const t = tagOf(i);
  const base = `/api/m/dream/ideas/${i.day}/${i.slot}`;
  const open = i.status === 'new' || i.status === 'later';

  async function act(kind: 'give' | 'later' | 'reject') {
    setBusy(true);
    try {
      await apiPost(`${base}/${kind}`, kind === 'reject' ? { reason } : undefined);
      if (kind === 'give') pushToast({ tone: 'success', title: 'Đã giao Bot Nội dung viết', description: 'Ý tưởng nằm trong Kho nội dung. Bài cần bạn duyệt trước khi đăng.' });
      setAsking(false);
      onChange();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa làm được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const f = i.formula;
  const formulaNote = !f ? '' : f.made === 0 ? 'chưa làm bài nào' : `${f.made} bài của mình, ${vsMedianText(f.ratio)}${f.exploratory ? ' (thăm dò)' : ''}`;
  return (
    <section class={`${CARD} flex flex-col gap-3 p-4`} style={{ borderLeft: `3px solid ${t.edge}` }} aria-label={i.tieu_de}>
      <div class="flex flex-wrap items-center gap-2">
        <span class="inline-flex rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold" style={{ background: t.bg, color: t.fg }}>{t.tag}</span>
        <span class="text-[12.5px] text-[var(--color-text-muted)]">{PLATFORM_LABEL[i.nen_tang] ?? i.nen_tang}{i.tru_cot ? ` · ${i.tru_cot}` : ''}</span>
        {STATUS_TEXT[i.status] && <span class="ml-auto text-[12px] font-semibold text-[var(--color-text-muted)]">{STATUS_TEXT[i.status]}{i.content_id ? ` · bài #${i.content_id}` : ''}</span>}
      </div>
      <span class="text-[16px] font-bold">{i.tieu_de}</span>
      <dl class="m-0 grid gap-x-3 gap-y-1.5 text-[13px]" style={{ gridTemplateColumns: '100px minmax(0, 1fr)' }}>
        <dt class="text-[var(--color-text-muted)]">Công thức</dt>
        <dd class="m-0">{f?.name ?? i.formula_slug}{formulaNote && <span class="text-[var(--color-text-muted)]"> · {formulaNote}</span>}</dd>
        <dt class="text-[var(--color-text-muted)]">Học từ</dt><dd class="m-0">{i.source_video_slug ?? 'chưa có video'}</dd>
        <dt class="text-[var(--color-text-muted)]">Câu mở đầu</dt><dd class="m-0">“{i.cau_mo_dau}”</dd>
        <dt class="text-[var(--color-text-muted)]">Bạn cần làm</dt><dd class="m-0">{i.viec_can_lam}</dd>
        <dt class="text-[var(--color-text-muted)]">Kỳ vọng</dt><dd class="m-0">Gấp {num(i.expected_ratio, 2)} lần ER trung vị của kênh, cố định lúc đề xuất</dd>
      </dl>
      {i.status === 'rejected' && i.reject_reason && <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">Lý do bỏ: {i.reject_reason}</p>}
      {open && !asking && (
        <div class="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
          <button type="button" class={BTN_PRIMARY} disabled={busy} onClick={() => void act('give')}>Giao Bot Nội dung viết</button>
          {i.status === 'new' && <button type="button" class={BTN} disabled={busy} onClick={() => void act('later')}>Để mai</button>}
          <button type="button" class={BTN} disabled={busy} onClick={() => setAsking(true)}>Bỏ, không hợp</button>
        </div>
      )}
      {open && asking && (
        <div class="flex flex-wrap items-end gap-2 border-t border-[var(--color-border)] pt-3">
          <label class="flex min-w-[220px] flex-1 flex-col gap-1">
            <span class="text-[12px] text-[var(--color-text-muted)]">Vì sao không hợp? (một câu ngắn)</span>
            <input class={INPUT} value={reason} maxLength={200} onInput={(e) => setReason((e.target as HTMLInputElement).value)} placeholder="Ví dụ: tuần này đang tập trung bán sỉ" />
          </label>
          <button type="button" class={BTN_PRIMARY} disabled={busy || reason.trim().length < 2} onClick={() => void act('reject')}>Bỏ đề xuất</button>
          <button type="button" class={BTN} disabled={busy} onClick={() => setAsking(false)}>Thôi</button>
        </div>
      )}
    </section>
  );
}
