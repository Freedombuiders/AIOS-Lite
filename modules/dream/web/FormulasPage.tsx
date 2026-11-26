// Công thức (Formulas.dc.html): the formulas the owner made from reference videos, how each one did on the owner's
// own channel, and the proposals "rút thành công thức" waiting for a name. Every number comes from the server (code);
// under 5 posts any verdict is labelled "thăm dò". Only the owner creates a formula, from this page.
import { useEffect, useState } from 'preact/hooks';
import { PageState } from '@/components/PageState';
import { apiPost, errorText } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import { DreamHeader, useOverview } from './DreamHeader';
import { LABEL_TEXT, lengthText, num, STATE_STYLE, vsMedianText, type Formula, type FormulaDetailDto, type FormulaProposal, type FormulasDto } from './lib';

const INPUT =
  'px-3 py-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none min-w-0';
const BTN_PRIMARY =
  'inline-flex items-center justify-center min-h-[40px] px-4 rounded-md bg-[var(--color-accent)] text-[13px] font-semibold text-[var(--color-on-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 border-0 cursor-pointer';
const BTN =
  'inline-flex items-center justify-center min-h-[36px] px-3 rounded-md border border-[var(--color-border-strong)] bg-transparent text-[12.5px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40 cursor-pointer';
const CARD = 'rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]';

function StatePill({ f }: { f: Pick<Formula, 'state' | 'stateLabel' | 'exploratory' | 'made'> }) {
  const s = STATE_STYLE[f.state];
  return (
    <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold" style={{ background: s.bg, color: s.fg }}>
      {f.stateLabel}
      {f.state !== 'chua-thu' && f.exploratory ? ' · thăm dò' : ''}
    </span>
  );
}

const resultText = (f: Formula) => (f.made === 0 ? '–' : `${num(f.result, 2)} so với kỳ vọng · ${vsMedianText(f.ratio)}`);

export function FormulasPage() {
  const overview = useOverview();
  const list = useFetch<FormulasDto>('/api/m/dream/formulas');
  const [selected, setSelected] = useState<string | null>(null);
  const formulas = list.data?.formulas ?? [];
  const proposals = list.data?.proposals ?? [];
  useEffect(() => {
    if (!selected && formulas[0]) setSelected(formulas[0].slug);
  }, [formulas.length]);

  return (
    <div class="flex flex-col gap-4">
      <DreamHeader active="formulas" overview={overview} aside={list.data?.folder ? `${list.data.folder}/cong-thuc/` : undefined} />
      <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Học từ kênh người khác, rồi kiểm lại trên kênh của mình. Mỗi bài làm theo công thức được so với ER trung vị của các bài khác trên kênh mình ở cùng mốc đo.</p>

      {proposals.length > 0 && (
        <section class="flex flex-col gap-3">
          <h2 class="m-0 text-[15px] font-semibold">Chờ bạn đặt tên ({proposals.length})</h2>
          {proposals.map((p) => <ProposalCard key={p.id} p={p} onDone={list.refresh} />)}
        </section>
      )}

      {(list.loading || list.error) && <PageState loading={list.loading} error={list.error} />}
      {!list.loading && !list.error && formulas.length === 0 && proposals.length === 0 && (
        <PageState empty emptyTitle="Chưa có công thức nào" emptyDescription="Phân tích vài video cùng một kiểu. Khi 3 video trong 30 ngày giống nhau, máy hỏi bạn có muốn rút thành công thức không." />
      )}

      {formulas.length > 0 && (
        <div class="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', alignItems: 'start' }}>
          <ul class="m-0 flex list-none flex-col gap-2 p-0" aria-label="Danh sách công thức">
            {formulas.map((f) => {
              const on = f.slug === selected;
              return (
                <li key={f.slug}>
                  <button
                    type="button"
                    class={`flex w-full cursor-pointer flex-col gap-1.5 rounded-xl border px-4 py-3 text-left ${on ? 'bg-[var(--color-card)]' : 'bg-transparent'}`}
                    style={{ borderColor: on ? 'var(--color-accent)' : 'var(--color-border)' }}
                    aria-pressed={on}
                    onClick={() => setSelected(f.slug)}
                  >
                    <span class="flex flex-wrap items-center gap-2">
                      <span class="min-w-0 flex-1 text-[14px] font-semibold text-[var(--color-text)]">{f.name}</span>
                      <StatePill f={f} />
                    </span>
                    <span class="text-[12.5px] text-[var(--color-text-muted)]">
                      Học từ {f.evidence} video · Mình đã làm {f.made} bài{f.rejections >= 3 ? ` · bị bỏ ${f.rejections} lần, ít được đề xuất` : ''}
                    </span>
                    <span class="text-[12.5px] text-[var(--color-text-muted)]">Kết quả: {resultText(f)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected && <FormulaDetail slug={selected} />}
        </div>
      )}

      <NewFormula options={list.data?.options} onDone={list.refresh} />
      <span class="text-[12.5px] text-[var(--color-text-muted)]">
        Kỳ vọng của công thức mới là gấp rưỡi trung vị kênh. Dưới 3 bài thì chưa kết luận; 3 đến 4 bài chỉ là thăm dò, chưa nói được công thức làm tăng hiệu quả. Bot không tạo hay sửa được công thức.
      </span>
    </div>
  );
}

function FormulaDetail({ slug }: { slug: string }) {
  const d = useFetch<FormulaDetailDto>(`/api/m/dream/formulas/${encodeURIComponent(slug)}`);
  if (!d.data) return <PageState loading={d.loading} error={d.error} />;
  const { formula: f, result, posts, videos, remark } = d.data;
  const s = STATE_STYLE[result.trang_thai];
  const measured = posts.filter((p) => p.comparisons.length);
  const maxEr = Math.max(1, ...measured.flatMap((p) => p.comparisons.map((c) => c.er ?? 0)));
  return (
    <section class={`${CARD} flex flex-col gap-4 p-4`} aria-label={`Công thức ${f.name}`}>
      <div class="flex flex-col gap-1">
        <span class="text-[16px] font-bold">{f.name}</span>
        <code class="text-[12px] text-[var(--color-text-faint)]">{f.path} · phiên bản {f.version}</code>
      </div>
      <dl class="m-0 grid gap-x-3 gap-y-1.5 text-[13px]" style={{ gridTemplateColumns: '110px minmax(0, 1fr)' }}>
        <dt class="text-[var(--color-text-muted)]">Mở đầu</dt><dd class="m-0">{LABEL_TEXT[f.moDau ?? ''] ?? '—'}</dd>
        <dt class="text-[var(--color-text-muted)]">Cấu trúc</dt><dd class="m-0">{LABEL_TEXT[f.cauTruc ?? ''] ?? '—'}</dd>
        <dt class="text-[var(--color-text-muted)]">Độ dài tối đa</dt><dd class="m-0">{f.maxLen ? `${f.maxLen} giây` : 'không giới hạn'}</dd>
        <dt class="text-[var(--color-text-muted)]">Nhịp cắt gốc</dt><dd class="m-0">{f.cutsPerMin === null ? '—' : `khoảng ${num(f.cutsPerMin, 1)} lần mỗi phút`}</dd>
        <dt class="text-[var(--color-text-muted)]">Trụ cột</dt><dd class="m-0">{f.pillar ?? 'chưa gắn'}</dd>
      </dl>

      <div class="flex flex-col gap-2">
        <h3 class="m-0 text-[13.5px] font-semibold">Bài mình đã làm theo công thức này</h3>
        {measured.length === 0 ? (
          <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có bài nào đo xong ở mốc 24 giờ.</p>
        ) : (
          <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
            {measured.map((p) => {
              const c = p.comparisons.at(-1)!;
              return (
                <li key={p.path} class="flex flex-col gap-1">
                  <span class="flex flex-wrap items-baseline gap-2 text-[12.5px]">
                    <span class="min-w-0 flex-1 truncate">{p.title}</span>
                    <span class="text-[var(--color-text-muted)]">{c.moc} · ER {num(c.er ?? null, 2)}% · trung vị kênh {num(c.trung_vi_kenh ?? null, 2)}% ({c.so_bai_nen ?? 0} bài) · so với kỳ vọng {num(c.so_voi_ky_vong ?? null, 2)}</span>
                  </span>
                  <span class="h-1.5 rounded-full" style={{ width: `${Math.max(4, Math.round(((c.er ?? 0) / maxEr) * 100))}%`, background: s.edge }} />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div class="flex flex-col gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-3" style={{ borderLeft: `3px solid ${s.edge}` }}>
        <span class="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Bot Đối chiếu kết luận</span>
        <span class="text-[14px] font-semibold" style={{ color: s.fg }}>
          {result.label}{result.trang_thai !== 'chua-thu' && result.tham_do ? ' (thăm dò)' : ''}
        </span>
        {result.da_lam > 0 && (
          <p class="m-0 text-[13px]">
            {result.da_lam} bài. Kỳ vọng mỗi lần thử được cố định lúc đề xuất; kết quả so với kỳ vọng là {num(result.ket_qua, 2)} (1 là đúng kỳ vọng), {vsMedianText(result.ti_le_trung_vi)}.
          </p>
        )}
        {remark && <p class="m-0 text-[13px] text-[var(--color-text-muted)]">{remark}</p>}
      </div>

      <div class="flex flex-col gap-1.5">
        <h3 class="m-0 text-[13.5px] font-semibold">Học từ {videos.length} video của Dream 100</h3>
        <ul class="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
          {videos.slice(0, 6).map((v) => (
            <li key={v.id} class="flex flex-wrap gap-2">
              <span class="min-w-0 flex-1 truncate">{v.title ?? v.url}</span>
              <span class="text-[var(--color-text-muted)]">{v.channel_handle ?? v.uploader ?? ''} · {num(v.views)} lượt xem · {lengthText(v.duration_s)}</span>
            </li>
          ))}
          {videos.length > 6 && <li class="text-[var(--color-text-muted)]">và {videos.length - 6} video khác</li>}
        </ul>
      </div>
    </section>
  );
}

function ProposalCard({ p, onDone }: { p: FormulaProposal; onDone: () => void }) {
  const [name, setName] = useState(p.suggestedName);
  const [maxLen, setMaxLen] = useState(p.maxDuration ? String(p.maxDuration) : '');
  const [pillar, setPillar] = useState('');
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await apiPost('/api/m/dream/formulas', { name, moDau: p.moDau, cauTruc: p.cauTruc, maxLen: maxLen ? Number(maxLen) : null, pillar: pillar || null, proposalId: p.id });
      pushToast({ tone: 'success', title: 'Đã tạo công thức', description: 'Trạng thái Chưa thử. Sáng mai máy có thể đề xuất một bài theo công thức này.' });
      onDone();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa tạo được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  async function dismiss() {
    setBusy(true);
    try {
      await apiPost(`/api/m/dream/formulas/proposals/${p.id}/dismiss`);
      onDone();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa bỏ được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class={`${CARD} flex flex-col gap-3 p-4`}>
      <span class="text-[13.5px]">
        <b>{p.videos.length} video</b> cùng kiểu “{p.label}” trong 30 ngày, chưa thuộc công thức nào.
      </span>
      <ul class="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px] text-[var(--color-text-muted)]">
        {p.videos.map((v) => <li key={v.id}>{v.title ?? v.id} · {v.channel ?? 'không rõ kênh'} · {num(v.views)} lượt xem · {lengthText(v.durationS)}</li>)}
      </ul>
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex min-w-[220px] flex-1 flex-col gap-1">
          <span class="text-[12px] text-[var(--color-text-muted)]">Tên công thức</span>
          <input class={INPUT} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label class="flex w-[130px] flex-col gap-1">
          <span class="text-[12px] text-[var(--color-text-muted)]">Dài tối đa (giây)</span>
          <input class={INPUT} inputMode="numeric" value={maxLen} onInput={(e) => setMaxLen((e.target as HTMLInputElement).value)} />
        </label>
        <label class="flex w-[160px] flex-col gap-1">
          <span class="text-[12px] text-[var(--color-text-muted)]">Trụ cột (không bắt buộc)</span>
          <input class={INPUT} value={pillar} onInput={(e) => setPillar((e.target as HTMLInputElement).value)} />
        </label>
        <button type="button" class={BTN_PRIMARY} disabled={busy || name.trim().length < 3} onClick={() => void create()}>Tạo công thức</button>
        <button type="button" class={BTN} disabled={busy} onClick={() => void dismiss()}>Bỏ qua</button>
      </div>
    </section>
  );
}

function NewFormula({ options, onDone }: { options?: FormulasDto['options']; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [moDau, setMoDau] = useState('');
  const [cauTruc, setCauTruc] = useState('');
  const [maxLen, setMaxLen] = useState('');
  const [pillar, setPillar] = useState('');
  const [busy, setBusy] = useState(false);
  if (!options) return null;
  if (!open) return <div><button type="button" class={BTN} onClick={() => setOpen(true)}>Tự tạo một công thức</button></div>;

  async function create() {
    setBusy(true);
    try {
      await apiPost('/api/m/dream/formulas', { name, moDau, cauTruc, maxLen: maxLen ? Number(maxLen) : null, pillar: pillar || null });
      pushToast({ tone: 'success', title: 'Đã tạo công thức' });
      setOpen(false);
      setName('');
      onDone();
    } catch (e) {
      pushToast({ tone: 'error', title: 'Chưa tạo được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class={`${CARD} flex flex-wrap items-end gap-3 p-4`} aria-label="Tạo công thức">
      <label class="flex min-w-[220px] flex-1 flex-col gap-1">
        <span class="text-[12px] text-[var(--color-text-muted)]">Tên công thức</span>
        <input class={INPUT} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-[12px] text-[var(--color-text-muted)]">Mở đầu</span>
        <select class={`${INPUT} h-10`} value={moDau} onChange={(e) => setMoDau((e.target as HTMLSelectElement).value)}>
          <option value="">Chọn…</option>
          {options.moDau.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-[12px] text-[var(--color-text-muted)]">Cấu trúc</span>
        <select class={`${INPUT} h-10`} value={cauTruc} onChange={(e) => setCauTruc((e.target as HTMLSelectElement).value)}>
          <option value="">Chọn…</option>
          {options.cauTruc.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <label class="flex w-[130px] flex-col gap-1">
        <span class="text-[12px] text-[var(--color-text-muted)]">Dài tối đa (giây)</span>
        <input class={INPUT} inputMode="numeric" value={maxLen} onInput={(e) => setMaxLen((e.target as HTMLInputElement).value)} />
      </label>
      <label class="flex w-[160px] flex-col gap-1">
        <span class="text-[12px] text-[var(--color-text-muted)]">Trụ cột</span>
        <input class={INPUT} value={pillar} onInput={(e) => setPillar((e.target as HTMLInputElement).value)} />
      </label>
      <button type="button" class={BTN_PRIMARY} disabled={busy || name.trim().length < 3 || !moDau || !cauTruc} onClick={() => void create()}>Tạo</button>
      <button type="button" class={BTN} disabled={busy} onClick={() => setOpen(false)}>Huỷ</button>
    </section>
  );
}
