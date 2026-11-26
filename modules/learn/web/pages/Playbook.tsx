// "Vòng học · Sổ bài học" (drawing Playbook.dc.html): lessons by state, with their evidence and trial numbers.
// The owner moves lessons here (the server checks every move in transition()); bots only propose.
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { PageState } from '@/components/PageState';
import { apiPost, errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { pct, postHref } from '@modules/learn/web/lib/format';
import { loopChanged, LoopHeader, NoFolder, STATE_HINT, STATE_LABEL, StateDot, StatePill, useLoopFetch } from '@modules/learn/web/lib/loop';
import type { Area, LessonState, LessonView, PlaybookDto } from '@modules/learn/web/lib/types';

const ORDER: LessonState[] = ['gia-thuyet', 'dang-thu', 'da-kiem-chung', 'bi-bac-bo'];
const AREAS: Array<{ key: Area | 'all'; label: string }> = [
  { key: 'all', label: 'Tất cả' }, { key: 'noi-dung', label: 'Nội dung' }, { key: 'cham-khach', label: 'Chăm khách' }, { key: 'quang-cao', label: 'Quảng cáo' },
];

/** Moves the owner may make from a state (the server enforces the same table). */
const MOVES: Record<LessonState, Array<{ to: LessonState; label: string; danger?: boolean }>> = {
  'gia-thuyet': [{ to: 'dang-thu', label: 'Đem thử' }, { to: 'bi-bac-bo', label: 'Bỏ', danger: true }],
  'dang-thu': [{ to: 'da-kiem-chung', label: 'Duyệt: đã kiểm chứng' }, { to: 'bi-bac-bo', label: 'Bác bỏ', danger: true }],
  'da-kiem-chung': [{ to: 'dang-thu', label: 'Đưa về đang thử' }, { to: 'bi-bac-bo', label: 'Bác bỏ', danger: true }],
  'bi-bac-bo': [{ to: 'gia-thuyet', label: 'Mở lại' }],
};

const reload = () => loopChanged();

function proofLine(l: LessonView, minEvidence: number): string {
  if (l.state === 'gia-thuyet') {
    const missing = Math.max(0, minEvidence - l.liveEvidence);
    return `${l.liveEvidence} bằng chứng${missing ? ` · cần thêm ${missing} nữa mới thử` : ' · đủ để thử'}`;
  }
  const t = l.trial;
  if (t && l.state === 'dang-thu') {
    return `Đã thử ${t.measured}/${t.threshold} bài${t.measured ? ` · ${t.label}` : ''}${t.medianEr !== null && t.channelMedian !== null ? ` · ${pct(t.medianEr)} so với trung vị kênh ${pct(t.channelMedian)}` : ''}`;
  }
  if (t && l.state === 'da-kiem-chung') {
    return `${l.liveEvidence} bằng chứng · ${t.measured} bài gần đây làm theo${t.medianEr !== null ? `, trung vị ${pct(t.medianEr)}` : ''}`;
  }
  return `${l.liveEvidence} bằng chứng`;
}

function LessonCard({ l, minEvidence }: { l: LessonView; minEvidence: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const move = async (to: LessonState) => {
    setBusy(to);
    try {
      await apiPost('/api/m/learn/playbook/transition', { path: l.path, to });
      pushToast({ tone: 'success', title: `Đã chuyển sang ${STATE_LABEL[to]}` });
      reload();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa chuyển được', description: errorText(e) });
    } finally {
      setBusy('');
    }
  };
  const dead = l.evidence.filter((e) => !e.live).length;
  return (
    <li class="flex flex-col gap-1.5 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-card)] p-3">
      <button type="button" class="cursor-pointer border-0 bg-transparent p-0 text-left text-[13.5px] font-semibold text-[var(--color-text)]" aria-expanded={open} onClick={() => setOpen(!open)}>
        {l.title}
      </button>
      <span class="text-[12.5px] text-[var(--color-text-muted)]">{proofLine(l, minEvidence)}</span>
      <div class="flex flex-wrap gap-1.5 text-[12px]">
        <span class="rounded-full bg-[var(--color-control-bg)] px-2 py-px">{l.areaLabel}</span>
        {l.usedBy.length > 0 && <span class="rounded-full bg-[var(--color-control-bg)] px-2 py-px">Dùng bởi {l.usedBy.join(', ')}</span>}
        {l.proposedBy && <span class="rounded-full bg-[var(--color-control-bg)] px-2 py-px">Bot {l.proposedBy} đề xuất</span>}
        {l.state === 'da-kiem-chung' && !l.ownerVerified && <span class="rounded-full px-2 py-px text-[var(--color-warning)]" style={{ background: 'color-mix(in srgb, var(--color-warning) 14%, transparent)' }}>Chưa duyệt trong app</span>}
      </div>
      {open && (
        <div class="mt-1 flex flex-col gap-2 border-t border-[var(--color-border)] pt-2 text-[12.5px]">
          {l.summary && <p class="m-0">{l.summary}</p>}
          {l.ruleText.length > 0 && <p class="m-0 text-[var(--color-text-muted)]">Máy kiểm được: {l.ruleText.join('; ')}.</p>}
          <div>
            <div class="font-medium">Bằng chứng</div>
            {l.evidence.length === 0 ? (
              <span class="text-[var(--color-text-faint)]">Chưa có. Thêm liên kết <code>[[ten-ghi-chu-bai]]</code> vào <code>bang_chung</code> trong ghi chú.</span>
            ) : (
              <ul class="m-0 list-none p-0">
                {l.evidence.map((e) => (
                  <li key={e.link}>
                    {e.live && e.path ? <Link href={postHref(e.path)}>{e.title ?? e.path}</Link> : <span class="text-[var(--color-text-faint)] line-through">{e.link}</span>}
                    {e.live ? ` · ER ${pct(e.er)}` : ' · không còn, không tính'}
                  </li>
                ))}
              </ul>
            )}
            {dead > 0 && <span class="text-[var(--color-text-faint)]">{dead} liên kết không trỏ tới bài đăng nào nên không được tính.</span>}
          </div>
          {l.trial && l.trial.recent.length > 0 && (
            <div>
              <div class="font-medium">{l.state === 'dang-thu' ? 'Bài thử' : 'Bài gần nhất làm theo'} (mốc {l.trial.moc})</div>
              <ul class="m-0 list-none p-0">
                {l.trial.recent.map((r) => (
                  <li key={r.path}>
                    <Link href={postHref(r.path)}>{r.title}</Link> · ER {pct(r.er)}{r.below === true ? ' · dưới trung vị' : r.below === false ? ' · trên trung vị' : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <span class="text-[var(--color-text-faint)]">Ghi chú: <code>{l.path}</code></span>
          <div class="flex flex-wrap gap-2">
            {l.state === 'da-kiem-chung' && !l.ownerVerified && (
              <button type="button" class="control-button control-accent" disabled={!!busy} onClick={() => void move('da-kiem-chung')}>Xác nhận đã kiểm chứng</button>
            )}
            {MOVES[l.state].map((m) => (
              <button key={m.to} type="button" class={`control-button ${m.danger ? '' : 'control-accent'}`} disabled={!!busy} onClick={() => void move(m.to)}>
                {busy === m.to ? 'Đang chuyển…' : m.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

function AddHypothesis({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [area, setArea] = useState<Area>('noi-dung');
  const [text, setText] = useState('');
  const [links, setLinks] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await apiPost('/api/m/learn/playbook', { tieu_de: title.trim(), mang: area, noi_dung: text, bang_chung: links.split(/\n|,/).map((s) => s.trim()).filter(Boolean) });
      pushToast({ tone: 'success', title: 'Đã thêm giả thuyết' });
      reload();
      onDone();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card card-pad flex flex-col gap-2" aria-labelledby="them-gia-thuyet">
      <h2 id="them-gia-thuyet" class="m-0 text-[15px] font-semibold">Thêm giả thuyết</h2>
      <label class="flex flex-col gap-1 text-[12.5px]">Điều bạn nghĩ là đúng<input class="field" value={title} maxLength={160} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} placeholder="Video hướng dẫn dưới 45 giây có ER cao hơn ảnh sản phẩm" /></label>
      <label class="flex flex-col gap-1 text-[12.5px]">Mảng
        <select class="field max-w-[220px]" value={area} onChange={(e) => setArea((e.target as HTMLSelectElement).value as Area)}>
          {AREAS.filter((a) => a.key !== 'all').map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
      </label>
      <label class="flex flex-col gap-1 text-[12.5px]">Vì sao nghĩ vậy<textarea class="field" rows={3} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} /></label>
      <label class="flex flex-col gap-1 text-[12.5px]">Bằng chứng (mỗi dòng một ghi chú bài, ví dụ <code>noi-dung/bai/2026-11-24-cach-uop-tra.md</code>)<textarea class="field" rows={2} value={links} onInput={(e) => setLinks((e.target as HTMLTextAreaElement).value)} /></label>
      {err && <p class="m-0 text-[12px] text-[var(--color-status-failed)]">{err}</p>}
      <div class="flex gap-2">
        <button type="button" class="control-button control-accent" disabled={busy || title.trim().length < 3} onClick={() => void save()}>{busy ? 'Đang ghi…' : 'Ghi vào sổ'}</button>
        <button type="button" class="control-button" onClick={onDone}>Hủy</button>
      </div>
    </section>
  );
}

export function Playbook() {
  const { data, loading, error } = useLoopFetch<PlaybookDto>('/api/m/learn/playbook', 60_000);
  const [area, setArea] = useState<Area | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const lessons = (data?.lessons ?? []).filter((l) => area === 'all' || l.area === area);
  const countOf = (a: Area | 'all') => (data?.lessons ?? []).filter((l) => a === 'all' || l.area === a).length;
  const evaluate = async () => {
    setChecking(true);
    try {
      const r = await apiPost<{ moved: unknown[]; proposed: number }>('/api/m/learn/playbook/evaluate');
      pushToast({ tone: 'success', title: r.moved.length || r.proposed ? `Đã xét: ${r.moved.length} bài học đổi trạng thái, ${r.proposed} đề xuất mới` : 'Đã xét: chưa có gì thay đổi' });
      reload();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa xét được', description: errorText(e) });
    } finally {
      setChecking(false);
    }
  };
  return (
    <div class="flex flex-col gap-4">
      <LoopHeader
        title="Sổ bài học"
        actions={data?.folder ? (
          <>
            <button type="button" class="control-button" disabled={checking} onClick={() => void evaluate()}>{checking ? 'Đang xét…' : 'Xét lại ngay'}</button>
            <button type="button" class="control-button control-accent" onClick={() => setAdding(true)}>Thêm giả thuyết</button>
          </>
        ) : undefined}
      />
      <PageState loading={loading && !data} error={error} />
      {data && !data.folder && <NoFolder />}
      {data && data.folder && (
        <>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap gap-1" role="tablist" aria-label="Mảng">
              {AREAS.map((a) => (
                <button key={a.key} type="button" role="tab" aria-selected={area === a.key} class={`control-button ${area === a.key ? 'control-accent' : ''}`} onClick={() => setArea(a.key)}>
                  {a.label} · {countOf(a.key)}
                </button>
              ))}
            </div>
            <code class="text-[12px] text-[var(--color-text-muted)]">{data.dir}</code>
          </div>
          {adding && <AddHypothesis onDone={() => setAdding(false)} />}
          <div class="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
            {ORDER.map((s) => {
              const items = lessons.filter((l) => l.state === s);
              return (
                <section key={s} class="flex flex-col gap-2.5 rounded-[14px] border border-[var(--color-border)] bg-[var(--color-elevated)] p-3" aria-labelledby={`cot-${s}`}>
                  <div class="flex items-center gap-2">
                    <StateDot state={s} />
                    <h2 id={`cot-${s}`} class="m-0 text-[14px] font-semibold">{STATE_LABEL[s]}</h2>
                    <span class="text-[12px] text-[var(--color-text-muted)]">{items.length}</span>
                  </div>
                  <span class="text-[12px] text-[var(--color-text-muted)]">{STATE_HINT[s]}</span>
                  {items.length === 0 ? (
                    <span class="text-[12px] text-[var(--color-text-faint)]">Chưa có.</span>
                  ) : (
                    <ul class="m-0 flex list-none flex-col gap-2 p-0">
                      {items.map((l) => <LessonCard key={l.path} l={l} minEvidence={data.minEvidence} />)}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
          <div class="flex flex-wrap gap-4 text-[12.5px]">
            <p class="m-0 flex-[1_1_260px]"><span class="font-semibold">Lên hạng thế nào.</span> <span class="text-[var(--color-text-muted)]">Giả thuyết cần ít nhất {data.minEvidence} bằng chứng mới được đem thử. Thử xong đạt thì máy đề xuất, và chỉ khi bạn duyệt mới thành <StatePill state="da-kiem-chung" />. 3–4 bài chỉ là thăm dò.</span></p>
            <p class="m-0 flex-[1_1_260px]"><span class="font-semibold">Bằng chứng là gì.</span> <span class="text-[var(--color-text-muted)]">Mỗi bằng chứng là một liên kết tới ghi chú bài đăng thật. Liên kết tới ghi chú không còn thì không được tính. Chỉ so các bài cùng nền tảng và cùng mốc {data.moc}.</span></p>
            <p class="m-0 flex-[1_1_260px]"><span class="font-semibold">Bài học cũ có hết hạn không.</span> <span class="text-[var(--color-text-muted)]">Bài học đã kiểm chứng mà 5 bài gần nhất làm theo đều thấp hơn trung vị thì tự quay về Đang thử.</span></p>
          </div>
        </>
      )}
    </div>
  );
}
