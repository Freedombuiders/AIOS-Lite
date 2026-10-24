// Catalog photos for the attribute library (src/kol/library-previews.ts): coverage per
// kind, the price and time of the missing ones, and the running job. The photos are for
// choosing by eye only; they are never sent to a model. With a KOL the panel draws that
// KOL's own set: every item on the KOL itself, from its identity images, face-checked.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ImagePlus, MoonStar, Square } from 'lucide-preact';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Toggle } from '@/components/Toggle';
import { Modal } from '@/components/Modal';
import { BTN, BTN_PRIMARY, InlineError } from '@modules/kol/web/components/shared/ops-shared';
import { LIBRARY_ICON, rememberPreviewModel, rememberedPreviewModel } from '@modules/kol/web/components/library';
import { ModelSelect, toastError, useKolStatus } from '@modules/kol/web/components/ui';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  KOL, LIBRARY_KIND_LABEL, fmtEstimate, fmtEta, fmtUsd, kolApi, modelOptions, previewEtaSeconds,
  type LibraryKind, type PreviewJobDto,
} from '@modules/kol/web/lib/kol';

const KINDS: LibraryKind[] = ['outfit', 'expression', 'hair', 'scene', 'pose', 'look', 'effect'];
/** A KOL's own set, in drawing order: what the KOL wears first, places last. */
const PERSONA_KINDS: LibraryKind[] = ['outfit', 'hair', 'expression', 'pose', 'look', 'effect', 'scene'];
/** The ChatGPT plan first (no per-image price), then Nano Banana at ≈ $0,04. */
const PREFERRED = ['chatgpt-image', 'gemini-2.5-flash-image'];

export function PreviewStudio({ onChanged, persona = null }: { onChanged?: () => void; persona?: { id: string; name: string } | null }) {
  const pid = persona?.id;
  const kinds = persona ? PERSONA_KINDS : KINDS;
  const status = useKolStatus();
  const options = useMemo(() => modelOptions(status.data, 'image'), [status.data]);
  const [model, setModelState] = useState('');
  const setModel = (id: string) => { setModelState(id); rememberPreviewModel(id); };

  const [running, setRunning] = useState(false);
  const res = useFetch<{ job: PreviewJobDto }>(KOL.libraryPreviews(model || undefined, pid), running ? 2500 : 0);
  const job = res.data?.job ?? null;
  // A run for the other scope (the shared catalog, another KOL) blocks this one until it ends.
  const runHere = !!job && (job.runPersonaId ?? null) === (pid ?? null);
  // The automatic plan belongs to one scope too.
  const autoHere = job?.auto && (job.auto.personaId ?? null) === (pid ?? null) ? job.auto : null;
  // Queued after another KOL: the plan reaches this one once the current scope is done.
  const queuedHere = !!pid && !!job?.auto?.enabled && !autoHere && (job.auto.queue ?? []).includes(pid);
  const autoElsewhere = !!job?.auto?.enabled && !autoHere && !queuedHere;
  useEffect(() => { setRunning(!!job?.running); }, [job?.running]);
  // Default: the automatic plan's model, then the owner's last pick, then the preferred configured one.
  useEffect(() => {
    if (model || !options.length || !res.data) return;
    const ok = options.filter((o) => o.configured).map((o) => o.model.id);
    const first = [autoHere?.model, rememberedPreviewModel(), ...PREFERRED].find((id) => !!id && ok.includes(id));
    setModelState(first ?? ok[0] ?? '');
  }, [options, !!res.data]);

  // New photos land while the job runs: refresh the pickers and grids as they arrive.
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!job) return;
    const n = job.done;
    if (seen.current !== null && n !== seen.current) { invalidateFetchCache('/api/m/kol/library'); status.refresh(); onChanged?.(); }
    seen.current = n;
  }, [job?.done, job?.running]);

  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cov = job?.coverage ?? {};
  const withPic = kinds.reduce((n, k) => n + (cov[k]?.withPreview ?? 0), 0);
  const total = kinds.reduce((n, k) => n + (cov[k]?.total ?? 0), 0);
  const missing = job?.estimate?.count ?? Math.max(0, total - withPic);
  const usd = job?.estimate?.usd ?? null;
  const picked = options.find((o) => o.model.id === model) ?? null;
  const provider = picked?.model.provider ?? null;
  const eta = previewEtaSeconds(missing, provider, !!persona);
  const spend = status.data?.spend;
  const capLeft = spend ? Math.max(0, spend.dailyCapUsd - spend.todayUsd) : null;
  const chat = status.data?.chatgpt;
  const chatPerDay = chat && chat.dailyLimit > 0 ? chat.dailyLimit : 0;
  // ChatGPT is rationed per day: past one day's limit the honest unit is days, not hours.
  const timeHint = provider === 'chatgpt' && chatPerDay && missing > chatPerDay ? `khoảng ${Math.ceil(missing / chatPerDay)} ngày (giới hạn ${chatPerDay} ảnh/ngày)` : fmtEta(eta);
  const chatLeft = chat && chat.dailyLimit > 0 ? Math.max(0, chat.dailyLimit - chat.imagesToday) : null;

  async function start() {
    setConfirm(false);
    setBusy(true);
    setError(null);
    try {
      const r = await kolApi.startPreviews({ model, ...(pid ? { personaId: pid } : {}) });
      seen.current = r.job.done;
      setRunning(true);
      res.refresh();
      pushToast({
        tone: 'success', title: persona ? `Đang vẽ ${r.job.total} ảnh của ${persona.name}` : `Đang vẽ ${r.job.total} ảnh minh hoạ`,
        description: [picked?.model.label, fmtEta(previewEtaSeconds(r.job.total, provider, !!persona))].filter(Boolean).join(' · '),
      });
    } catch (err) {
      toastError('Không bắt đầu được', err);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const [autoBusy, setAutoBusy] = useState(false);
  async function toggleAuto(on: boolean) {
    setAutoBusy(true);
    try {
      await kolApi.setPreviewAuto({ enabled: on, model, personaId: pid ?? null });
      res.refresh();
      pushToast({ tone: 'success', title: on ? 'Sẽ tự vẽ tiếp khi bạn rảnh' : 'Đã tắt tự vẽ tiếp' });
    } catch (err) {
      toastError('Không đổi được', err);
    } finally {
      setAutoBusy(false);
    }
  }

  async function stop() {
    try {
      await kolApi.stopPreviews();
      res.refresh();
    } catch (err) {
      toastError('Không dừng được', err);
    }
  }

  const progress = job && job.total ? ((job.done + job.failed) / job.total) * 100 : 0;
  const remaining = job ? Math.max(0, job.total - job.done - job.failed) : 0;
  // ChatGPT runs are rationed per day: say what today still holds instead of the whole run's time.
  const runChat = job?.model === 'chatgpt-image';
  const today = runChat && chatLeft !== null ? Math.min(remaining, chatLeft) : remaining;
  const runLeft = !remaining ? ''
    : runChat && today < remaining
      ? ` · hôm nay còn ${today} ảnh (${fmtEta(previewEtaSeconds(today, 'chatgpt', !!job?.runPersonaId)) || 'sắp xong'}), phần còn lại các ngày sau`
      : ` · còn ${fmtEta(previewEtaSeconds(remaining, runChat ? 'chatgpt' : provider, !!job?.runPersonaId))}`;

  return (
    <section class="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-3 min-w-0" aria-labelledby="kol-previews">
      <div class="flex flex-wrap items-start gap-x-4 gap-y-1">
        <div class="min-w-0 flex-1">
          <h2 id="kol-previews" class="text-[14px] font-semibold text-[var(--color-text)]">{persona ? `Ảnh minh hoạ của ${persona.name}` : 'Ảnh minh hoạ thư viện'}</h2>
          <p class="mt-0.5 text-[12px] text-[var(--color-text-muted)] leading-relaxed max-w-[720px]">
            {persona ? (
              <>
                Vẽ từng mục lên chính {persona.name}: mặc trang phục, làm biểu cảm, để kiểu tóc, tạo dáng, đứng trong bối cảnh. Mỗi ảnh dùng ảnh gốc của {persona.name} như khi tạo ở Studio,
                rồi được chấm độ giống khuôn mặt; ảnh lệch mặt được vẽ lại một lần, vẫn lệch thì giữ ảnh mẫu chung. Ảnh chỉ để chọn bằng mắt, không gửi cho mô hình.
              </>
            ) : (
              <>
                Mỗi mục một ảnh catalog để chọn bằng mắt: trang phục trên ma-nơ-canh vô hình, biểu cảm, tóc và dáng trên cùng một người mẫu studio, bối cảnh không người, look và hiệu ứng trên cùng một cảnh để so sánh.
                Ảnh chỉ để xem, không gửi cho mô hình nên không ảnh hưởng khuôn mặt KOL. Chọn một KOL ở “Phạm vi” để vẽ các mục lên chính KOL đó.
              </>
            )}
          </p>
        </div>
        {total > 0 && (
          <div class="text-right tabular-nums">
            <div class="text-[18px] font-semibold text-[var(--color-text)] leading-tight">{withPic}<span class="text-[13px] text-[var(--color-text-muted)] font-normal">/{total}</span></div>
            <div class="text-[11.5px] text-[var(--color-text-muted)]">{persona ? `mục có ${persona.name}` : 'mục có ảnh'}</div>
          </div>
        )}
      </div>

      {total > 0 && (
        <ul class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 list-none m-0 p-0">
          {kinds.map((k) => {
            const c = cov[k] ?? { withPreview: 0, total: 0 };
            const pct = c.total ? (c.withPreview / c.total) * 100 : 0;
            const Icon = LIBRARY_ICON[k];
            return (
              <li key={k} class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 flex flex-col gap-1.5 min-w-0">
                <span class="flex items-center gap-1.5 text-[12px] text-[var(--color-text)] min-w-0"><Icon size={13} class="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" /><span class="truncate">{LIBRARY_KIND_LABEL[k]}</span></span>
                <span class="text-[11.5px] tabular-nums text-[var(--color-text-muted)]">{c.withPreview}/{c.total}</span>
                <span class="h-1 rounded-full bg-[var(--color-elevated)] overflow-hidden" aria-hidden="true">
                  <span class="block h-full rounded-full bg-[var(--color-status-done)] transition-[width] duration-700" style={{ width: `${pct}%` }} />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {job?.running && !runHere ? (
        <p class="text-[12px] text-[var(--color-text-muted)] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
          Đang vẽ {job.runPersonaId ? 'ảnh cho một KOL khác' : 'ảnh minh hoạ thư viện chung'} ({job.done + job.failed}/{job.total}). Chờ lượt đó xong hoặc dừng nó rồi bắt đầu ở đây.
          <button type="button" class={`${BTN} ml-2 h-7`} onClick={() => { void stop(); }}><Square size={11} />Dừng lượt đó</button>
        </p>
      ) : job?.running ? (
        <div class="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
            <span class="inline-flex items-center gap-1.5 text-[var(--color-status-running)] font-medium"><span class="w-1.5 h-1.5 rounded-full bg-[var(--color-status-running)] animate-pulse" />Đang vẽ</span>
            <span class="tabular-nums text-[var(--color-text)]">{job.done + job.failed}/{job.total}</span>
            <span class="tabular-nums text-[var(--color-text-muted)]">{fmtUsd(job.costUsd)}{runLeft}</span>
            {job.failed > 0 && <span class="text-[var(--color-status-failed)] tabular-nums">{job.failed} lỗi</span>}
            <button type="button" class={`${BTN} ml-auto h-8`} onClick={() => { void stop(); }}><Square size={12} />Dừng</button>
          </div>
          <div class="h-1.5 rounded-full bg-[var(--color-elevated)] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
            <div class="h-full rounded-full bg-[var(--color-status-running)] transition-[width] duration-700" style={{ width: `${progress}%` }} />
          </div>
        </div>
      ) : (
        <div class="flex flex-wrap items-end gap-3">
          <label class="flex flex-col gap-1.5 text-[12px] text-[var(--color-text-muted)] min-w-[240px] flex-1 max-w-[420px]">
            Mô hình vẽ
            <ModelSelect options={options} value={model} allowEmpty={false} compact onChange={setModel} label="Mô hình vẽ ảnh minh hoạ" />
          </label>
          <div class="flex flex-col gap-0.5 text-[12px] tabular-nums min-w-0">
            <span class="text-[var(--color-text)]">{missing ? <>Còn <b>{missing}</b> mục chưa có ảnh</> : 'Mọi mục đã có ảnh'}</span>
            {missing > 0 && <span class="text-[var(--color-text-muted)]">{usd === null ? 'Chưa có giá cho mô hình này' : usd === 0 ? 'Trong gói ChatGPT, $0' : fmtEstimate(usd)}{timeHint ? ` · ${timeHint}` : ''}</span>}
          </div>
          <button type="button" class={`${BTN_PRIMARY} h-9 ml-auto`} disabled={!model || !missing || busy || usd === null} onClick={() => (usd ? setConfirm(true) : void start())}>
            <ImagePlus size={14} />{busy ? 'Đang bắt đầu…' : persona ? `Vẽ ${missing || ''} ảnh bằng ${persona.name}` : `Vẽ ${missing || ''} ảnh còn thiếu`}
          </button>
        </div>
      )}

      {missing > 0 && queuedHere && (
        <p class="text-[11.5px] text-[var(--color-text-muted)]">
          Đã xếp hàng “Tự vẽ tiếp khi bạn rảnh”: {persona?.name} được vẽ tự động ngay sau khi KOL đang vẽ xong.
        </p>
      )}
      {missing > 0 && model && autoElsewhere && (
        <p class="text-[11.5px] text-[var(--color-text-muted)]">
          “Tự vẽ tiếp khi bạn rảnh” đang bật cho {job?.auto?.personaId ? 'một KOL khác' : 'thư viện chung'}: mỗi lúc chỉ một phạm vi, bật ở đây sẽ chuyển sang {persona ? persona.name : 'thư viện chung'}.
        </p>
      )}
      {missing > 0 && model && (
        <AutoRow
          plan={autoHere}
          model={model}
          modelLabel={picked?.model.label ?? model}
          chatgpt={provider === 'chatgpt'}
          missing={missing}
          dailyLimit={chat?.dailyLimit ?? 0}
          busy={autoBusy}
          onToggle={(on) => { void toggleAuto(on); }}
        />
      )}
      {!job?.running && missing > 0 && provider !== 'chatgpt' && usd !== null && capLeft !== null && usd > capLeft && (
        <p class="text-[11.5px] text-[var(--color-priority-medium)]">
          Vượt phần còn lại của hạn mức hôm nay ({fmtUsd(capLeft)}): job tự dừng khi chạm hạn mức, ngày mai bấm lại để vẽ tiếp.
        </p>
      )}
      {!job?.running && missing > 0 && provider === 'chatgpt' && chatLeft !== null && chatLeft < missing && (
        <p class="text-[11.5px] text-[var(--color-priority-medium)]">
          Hôm nay ChatGPT còn {chatLeft}/{chat?.dailyLimit} ảnh (dùng chung với Studio): job dừng ở đó, ngày mai chạy tiếp.
        </p>
      )}
      {job && runHere && !job.running && job.finishedAt && (
        <p class="text-[12px] text-[var(--color-text-muted)]">
          Lượt gần nhất: vẽ {job.done}/{job.total} ảnh · {fmtUsd(job.costUsd)}{job.failed ? ` · ${job.failed} lỗi` : ''}{job.stopReason ? ` · ${job.stopReason}` : ''}
        </p>
      )}
      {persona && job && job.gaveUp.length > 0 && (
        <details class="text-[11.5px] text-[var(--color-text-muted)]">
          <summary class="cursor-pointer">{job.gaveUp.length} mục vẽ 2 lượt chưa đạt: giữ ảnh mẫu chung, lượt tự động bỏ qua (bấm vẽ thủ công để thử lại)</summary>
          <ul class="mt-1 flex flex-col gap-0.5 list-none m-0 p-0 text-[var(--color-text-faint)]">
            {job.gaveUp.map((g) => <li key={g.id} class="truncate" title={g.error}><span class="text-[var(--color-text-muted)]">{g.name}:</span> {g.error}</li>)}
          </ul>
        </details>
      )}
      {job && runHere && job.errors.length > 0 && (
        <ul class="flex flex-col gap-0.5 list-none m-0 p-0 text-[11.5px] text-[var(--color-text-faint)]">
          {job.errors.map((e, i) => <li key={i} class="truncate" title={e.error}><span class="text-[var(--color-text-muted)]">{e.name}:</span> {e.error}</li>)}
        </ul>
      )}
      {res.error && <InlineError>{res.error}</InlineError>}
      {error && !res.error && <InlineError>{error}</InlineError>}

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => { void start(); }}
        title={persona ? `Vẽ ${missing} ảnh của ${persona.name}?` : `Vẽ ${missing} ảnh minh hoạ?`}
        body={`${picked?.model.label ?? model} · ${usd !== null ? fmtEstimate(usd) : ''}, tính vào hạn mức KOL Studio (đã dùng hôm nay ${fmtUsd(spend?.todayUsd ?? 0)} / ${fmtUsd(spend?.dailyCapUsd ?? 0)}). Có thể dừng bất cứ lúc nào; ảnh đã vẽ được giữ lại.`}
        confirmLabel="Bắt đầu vẽ"
        cancelLabel="Huỷ"
      />
    </section>
  );
}

/** "Tự vẽ tiếp khi bạn rảnh": the automatic plan for the remaining photos. */
function AutoRow({ plan, model, modelLabel, chatgpt, missing, dailyLimit, busy, onToggle }: {
  plan: PreviewJobDto['auto']; model: string; modelLabel: string; chatgpt: boolean; missing: number; dailyLimit: number; busy: boolean;
  onToggle: (on: boolean) => void;
}) {
  const on = !!plan?.enabled;
  const reserve = plan?.reserve ?? 15;
  const usedModel = on ? plan!.model : model;
  const perNight = chatgpt && dailyLimit > 0 ? Math.max(1, dailyLimit - reserve) : 0;
  const nights = perNight ? Math.ceil(missing / perNight) : 0;
  return (
    <div class={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] bg-[var(--color-bg)]'}`}>
      <MoonStar size={16} class={`shrink-0 mt-0.5 ${on ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}`} aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div class="text-[12.5px] font-medium text-[var(--color-text)]">Tự vẽ tiếp khi bạn rảnh</div>
        <p class="text-[11.5px] text-[var(--color-text-muted)] leading-relaxed">
          Chạy ban đêm (0–6 giờ) hoặc sau 1 giờ bạn không tạo ảnh, không chen vào lượt tạo của bạn{chatgpt ? `, luôn chừa ${reserve} lượt ChatGPT mỗi ngày cho bạn` : ', trong hạn mức chi tiêu'}.
          {' '}{on && usedModel !== model ? `Đang dùng ${usedModel}. ` : ''}
          {nights ? `Còn ${missing} ảnh: khoảng ${nights} đêm là xong.` : `Còn ${missing} ảnh với ${modelLabel}.`}
          {' '}Tự tắt khi đã vẽ hết.
        </p>
      </div>
      <Toggle size="sm" on={on} disabled={busy} onChange={() => onToggle(!on)} ariaLabel="Tự vẽ tiếp khi bạn rảnh" />
    </div>
  );
}

/** The same panel in a dialog, opened from a picker (for the picking KOL when there is one). */
export function PreviewStudioModal({ onClose, onChanged, persona = null }: { onClose: () => void; onChanged?: () => void; persona?: { id: string; name: string } | null }) {
  return (
    <Modal open title={persona ? `Ảnh minh hoạ của ${persona.name}` : 'Ảnh minh hoạ thư viện'} width={960} onClose={onClose} bodyClassName="px-5 py-4">
      <PreviewStudio onChanged={onChanged} persona={persona} />
    </Modal>
  );
}
