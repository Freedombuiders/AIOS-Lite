/** KOL Studio › Cài đặt: master switches, caps, default models, price overrides, provider status. */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { AlertTriangle, CheckCircle2, ExternalLink, Plus, X, XCircle } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Toggle } from '@/components/Toggle';
import { Card } from '@modules/kol/web/components/shared/common';
import { BTN_PRIMARY, BTN_SM, Field, INPUT, InlineError, apiFail } from '@modules/kol/web/components/shared/ops-shared';
import { FieldGrid, Meter, ModelSelect, toastError } from '@modules/kol/web/components/ui';
import { invalidateFetchCache } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  KOL, MODEL_KIND_LABEL, kolApi, modelOptions,
  type KolSettingsDto, type KolStatusDto,
} from '@modules/kol/web/lib/kol';

const JUDGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Tự động (Gemini nếu có key, không thì ChatGPT)' },
  { value: 'chatgpt', label: 'ChatGPT (Codex) · trong gói, ~7 giây/ảnh' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash · ~$0,001/ảnh, ~3 giây' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite · rẻ nhất' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro · kỹ nhất' },
];

function judgeHint(status: KolStatusDto | null): string | undefined {
  if (!status) return undefined;
  if (!status.judge.configured) return 'Chưa có bộ chấm: thêm GOOGLE_API_KEY hoặc đăng nhập Codex bằng ChatGPT. Ảnh sẽ không được chấm.';
  return `Đang dùng ${status.judge.provider === 'chatgpt' ? 'ChatGPT (Codex)' : status.judge.model}.`;
}

interface PriceRow { model: string; usd: string }

export function KolSettingsTab({ status, onChanged }: { status: KolStatusDto | null; onChanged: () => void }) {
  const [s, setS] = useState<KolSettingsDto | null>(null);
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);

  useEffect(() => {
    let cancelled = false;
    kolApi.settings()
      .then((r) => { if (!cancelled) { setS(r.settings); setPrices(toRows(r.settings.priceOverrides)); } })
      .catch((e) => { if (!cancelled) setLoadError(apiFail(e).message); });
    return () => { cancelled = true; };
  }, []);

  const imageModels = useMemo(() => modelOptions(status, 'image'), [status]);
  const videoModels = useMemo(() => modelOptions(status, 'video'), [status]);
  const allModels = useMemo(() => [...imageModels, ...videoModels, ...modelOptions(status, 'lipsync')], [imageModels, videoModels, status]);

  if (!s) return <div class="flex-1 min-h-0 overflow-y-auto"><PageState loading={!loadError} error={loadError} /></div>;

  async function saveSwitch(patch: Partial<KolSettingsDto>, msg: string) {
    try {
      const r = await kolApi.saveSettings(patch);
      setS((cur) => (cur ? { ...cur, ...patch, ...pickSwitches(r.settings) } : r.settings));
      invalidateFetchCache(KOL.status);
      onChanged();
      pushToast({ tone: 'success', title: msg });
    } catch (err) {
      toastError('Không đổi được công tắc', err);
    }
  }

  async function save() {
    if (!s) return;
    const priceOverrides: Record<string, number> = {};
    for (const row of prices) {
      const v = Number(row.usd.replace(',', '.'));
      if (!row.model) continue;
      if (!Number.isFinite(v) || v < 0) { setSaveError(`Giá của ${row.model} không hợp lệ.`); return; }
      priceOverrides[row.model] = v;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const r = await kolApi.saveSettings({ ...s, priceOverrides });
      setS(r.settings);
      setPrices(toRows(r.settings.priceOverrides));
      invalidateFetchCache(KOL.status);
      onChanged();
      pushToast({ tone: 'success', title: 'Đã lưu cài đặt KOL Studio' });
    } catch (err) {
      setSaveError(apiFail(err).message);
    } finally {
      setSaving(false);
    }
  }

  const num = (e: Event) => Number((e.target as HTMLInputElement).value);

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4">
      <div class="flex flex-col gap-4">
        <Card title="Bật / tắt" aside={status && <span class="tabular-nums">Hàng đợi: {status.queue.running} đang chạy · {status.queue.queued} đang chờ</span>}>
          <SwitchRow
            label="KOL Studio"
            desc="Tắt thì không tạo ảnh/video mới. Bạn vẫn xem, soạn và sắp lịch được."
            on={s.enabled}
            onChange={() => { void saveSwitch({ enabled: !s.enabled }, s.enabled ? 'Đã tắt KOL Studio' : 'Đã bật KOL Studio'); }}
          />
          <SwitchRow
            label="Cho phép đăng bài"
            desc="Mặc định tắt. Khi bật, bài đã lên lịch được đăng thật lên các kênh qua Composio."
            on={s.publishEnabled}
            warn={s.publishEnabled ? 'Đang đăng thật. Bài đã duyệt và lên lịch sẽ tự lên mạng xã hội đúng giờ.' : undefined}
            onChange={() => { if (s.publishEnabled) void saveSwitch({ publishEnabled: false }, 'Đã tắt đăng bài'); else setConfirmPublish(true); }}
          />
          <SwitchRow
            label="Autopilot"
            desc="Cho phép autopilot của từng KOL lập kế hoạch bài mỗi ngày (cấu hình riêng trong Hồ sơ của KOL)."
            on={s.autopilotEnabled}
            onChange={() => { void saveSwitch({ autopilotEnabled: !s.autopilotEnabled }, s.autopilotEnabled ? 'Đã tắt autopilot' : 'Đã bật autopilot'); }}
          />
          {status && (
            <div class="flex flex-wrap gap-2 pt-1 text-[12px]">
              <SwitchState ok={status.killSwitches.generate} label="KOL_GENERATE_ENABLED" />
              <SwitchState ok={status.killSwitches.publish} label="KOL_PUBLISH_ENABLED" />
              <span class="text-[var(--color-text-muted)]">Công tắc an toàn trong <code>.env</code>, chỉ đổi được trên máy chủ.</span>
            </div>
          )}
        </Card>

        <Card title="Chi tiêu" aside={<Link href="/budgets" class="underline">Ngân sách</Link>}>
          {status && (
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Meter label="Hôm nay" used={status.spend.todayUsd} cap={status.spend.dailyCapUsd} />
              <Meter label="Tháng này" used={status.spend.monthUsd} cap={status.spend.monthlyCapUsd} />
            </div>
          )}
          <FieldGrid>
            <Field label="Hạn mức ngày (USD)" hint="Lần tạo vượt hạn mức bị từ chối trước khi gọi API.">
              <input type="number" min={0} step="0.5" class={`${INPUT} w-full`} value={s.dailyCapUsd} onInput={(e) => setS({ ...s, dailyCapUsd: num(e) })} />
            </Field>
            <Field label="Hạn mức tháng (USD)" hint="Mỗi KOL còn có hạn mức riêng trong Hồ sơ.">
              <input type="number" min={0} step="1" class={`${INPUT} w-full`} value={s.monthlyCapUsd} onInput={(e) => setS({ ...s, monthlyCapUsd: num(e) })} />
            </Field>
          </FieldGrid>
        </Card>

        <Card title="Mô hình mặc định">
          <FieldGrid>
            <Field label="Ảnh">
              <ModelSelect options={imageModels} value={s.defaultImageModel} onChange={(defaultImageModel) => setS({ ...s, defaultImageModel })} />
            </Field>
            <Field label="Video">
              <ModelSelect options={videoModels} value={s.defaultVideoModel} onChange={(defaultVideoModel) => setS({ ...s, defaultVideoModel })} />
            </Field>
            <Field label="Mô hình chấm khuôn mặt" hint={judgeHint(status)}>
              <select class={`${INPUT} w-full`} value={s.judgeModel} onChange={(e) => setS({ ...s, judgeModel: (e.target as HTMLSelectElement).value })}>
                {!JUDGE_OPTIONS.some((o) => o.value === s.judgeModel) && <option value={s.judgeModel}>{s.judgeModel}</option>}
                {JUDGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Số lượt tạo cùng lúc (API)" hint="Gemini, fal, Higgsfield; video tính gấp đôi. Ảnh ChatGPT có giới hạn riêng bên dưới.">
              <select class={`${INPUT} w-full`} value={s.concurrency} onChange={(e) => setS({ ...s, concurrency: Number((e.target as HTMLSelectElement).value) })}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
          </FieldGrid>
        </Card>

        <ChatgptCard settings={s} status={status} onChange={(patch) => setS({ ...s, ...patch })} />

        <Card title="Giá tuỳ chỉnh" aside="USD mỗi ảnh, hoặc mỗi giây video">
          <p class="text-[12px] text-[var(--color-text-muted)]">Chỉ cần khi giá nhà cung cấp thay đổi. Giá dùng để ước tính trước và chặn theo hạn mức.</p>
          {prices.length > 0 && (
            <ul class="flex flex-col gap-2 list-none m-0 p-0">
              {prices.map((row, i) => {
                const info = allModels.find((o) => o.model.id === row.model);
                return (
                  <li key={i} class="flex flex-wrap items-center gap-2">
                    <select
                      class={`${INPUT} flex-1 min-w-[200px]`}
                      aria-label="Mô hình"
                      value={row.model}
                      onChange={(e) => setPrices(prices.map((r, j) => (j === i ? { ...r, model: (e.target as HTMLSelectElement).value } : r)))}
                    >
                      <option value="">Chọn mô hình…</option>
                      {row.model && !info && <option value={row.model}>{row.model}</option>}
                      {allModels.map((o) => <option key={o.model.id} value={o.model.id}>{o.providerLabel} · {o.model.label} ({MODEL_KIND_LABEL[o.model.kind]})</option>)}
                    </select>
                    <input
                      class={`${INPUT} w-28`}
                      inputMode="decimal"
                      aria-label="Giá USD"
                      placeholder="0,04"
                      value={row.usd}
                      onInput={(e) => setPrices(prices.map((r, j) => (j === i ? { ...r, usd: (e.target as HTMLInputElement).value } : r)))}
                    />
                    {info && <span class="text-[11.5px] text-[var(--color-text-faint)]">Mặc định {info.model.priceNote}</span>}
                    <button type="button" class={`${BTN_SM} px-1.5`} aria-label="Xoá dòng" onClick={() => setPrices(prices.filter((_, j) => j !== i))}><X size={13} /></button>
                  </li>
                );
              })}
            </ul>
          )}
          <div><button type="button" class={BTN_SM} onClick={() => setPrices([...prices, { model: '', usd: '' }])}><Plus size={12} class="mr-1" />Thêm giá</button></div>
        </Card>

        {saveError && <InlineError>{saveError}</InlineError>}
        <div class="flex gap-2 sticky bottom-0 py-3 bg-[var(--color-bg)] z-[1]">
          <button type="button" class={BTN_PRIMARY} disabled={saving} onClick={() => { void save(); }}>{saving ? 'Đang lưu…' : 'Lưu cài đặt'}</button>
        </div>

        <Card title="Nhà cung cấp AI">
          {!status ? <p class="text-[12.5px] text-[var(--color-text-muted)]">Đang kiểm tra…</p> : (
            <ul class="grid grid-cols-1 md:grid-cols-3 gap-3 list-none m-0 p-0">
              {status.providers.map((p) => (
                <li key={p.id} class="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2 min-w-0">
                  <div class="flex items-center gap-2">
                    {p.configured ? <CheckCircle2 size={16} class="text-[var(--color-status-done)]" /> : <XCircle size={16} class="text-[var(--color-text-faint)]" />}
                    <span class="font-semibold text-[13.5px]">{p.label}</span>
                    <span class="ml-auto text-[12px] text-[var(--color-text-muted)]">{p.id === 'chatgpt' ? (p.configured ? 'Đã đăng nhập' : 'Chưa đăng nhập') : p.configured ? 'Đã có key' : 'Chưa có key'}</span>
                  </div>
                  {!p.configured && (
                    <p class="text-[12px] text-[var(--color-text-muted)]">
                      {p.hint} {p.id !== 'chatgpt' && <Link href={`/integrations?service=${encodeURIComponent(p.id)}`} class="text-[var(--color-accent)] underline inline-flex items-center gap-0.5">Mở Kết nối<ExternalLink size={11} /></Link>}
                    </p>
                  )}
                  <ul class="flex flex-col gap-0.5 list-none m-0 p-0 text-[12px]">
                    {p.models.map((m) => (
                      <li key={m.id} class="flex items-baseline justify-between gap-2 min-w-0">
                        <span class="truncate">{m.label}{m.recommended ? ' ★' : ''} <span class="text-[var(--color-text-faint)]">· {MODEL_KIND_LABEL[m.kind]}</span></span>
                        <span class="shrink-0 tabular-nums text-[var(--color-text-muted)]">{m.priceNote}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {status && (
          <Card title="Dịch vụ đi kèm">
            <ul class="flex flex-col gap-2 list-none m-0 p-0 text-[13px]">
              <ServiceRow ok={status.composio} label="Composio (đăng bài)" okText="Đã kết nối" badText="Chưa có API key" href="/connections" />
              <ServiceRow ok={status.judge.configured} label="Chấm khuôn mặt" okText={status.judge.provider === 'chatgpt' ? 'ChatGPT (Codex)' : status.judge.model} badText="Cần GOOGLE_API_KEY hoặc đăng nhập Codex" href="/connections" />
              <ServiceRow ok={status.chatgpt.configured} label="ChatGPT (Codex)" okText={status.chatgpt.mode === 'api-key' ? 'OPENAI_API_KEY' : 'Đã đăng nhập gói ChatGPT'} badText="Chạy codex login" href="/m/kol?tab=settings" />
              <ServiceRow ok={status.voice.configured} label="Giọng nói (ElevenLabs)" okText="Sẵn sàng cho video nói chuyện" badText="Chưa có key, không tạo được video nói chuyện" href="/connections" />
            </ul>
          </Card>
        )}
      </div>

      <ConfirmModal
        open={confirmPublish}
        onClose={() => setConfirmPublish(false)}
        onConfirm={() => { void saveSwitch({ publishEnabled: true }, 'Đã bật đăng bài'); }}
        title="Bật đăng bài thật?"
        body="Từ giờ, bài đã duyệt và lên lịch sẽ được đăng lên Facebook, Instagram, TikTok, YouTube đúng giờ. Mọi caption đều kèm dòng công bố AI."
        detail="Kiểm tra lại quy tắc đăng của từng kênh (tab Kênh của mỗi KOL) trước khi bật."
        confirmLabel="Bật đăng bài"
        cancelLabel="Để sau"
      />
    </div>
  );
}

function toRows(map: Record<string, number>): PriceRow[] {
  return Object.entries(map).map(([model, usd]) => ({ model, usd: String(usd).replace('.', ',') }));
}

function pickSwitches(s: KolSettingsDto): Partial<KolSettingsDto> {
  return { enabled: s.enabled, publishEnabled: s.publishEnabled, autopilotEnabled: s.autopilotEnabled };
}

function SwitchRow({ label, desc, on, onChange, warn }: { label: string; desc: string; on: boolean; onChange: () => void; warn?: string }) {
  return (
    <div class="flex items-start gap-3 py-1">
      <div class="flex-1 min-w-0">
        <div class="text-[13px] font-medium text-[var(--color-text)]">{label}</div>
        <div class="text-[12px] text-[var(--color-text-muted)]">{desc}</div>
        {warn && <div class="mt-1 inline-flex items-center gap-1.5 text-[12px] text-[var(--color-priority-medium)]"><AlertTriangle size={13} aria-hidden="true" />{warn}</div>}
      </div>
      <Toggle on={on} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

function SwitchState({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span class="inline-flex items-center gap-1.5 h-6 px-2 rounded-full border border-[var(--color-border)]">
      <span class="w-1.5 h-1.5 rounded-full" style={{ background: ok ? 'var(--color-status-done)' : 'var(--color-status-failed)' }} aria-hidden="true" />
      <code class="text-[11px]">{label}</code>
      <span>{ok ? 'bật' : 'tắt'}</span>
    </span>
  );
}

/** ChatGPT through Codex: login state, today's images against the daily limit, the Codex model. */
function ChatgptCard({ settings, status, onChange }: { settings: KolSettingsDto; status: KolStatusDto | null; onChange: (patch: Partial<KolSettingsDto>) => void }) {
  const c = status?.chatgpt;
  const models = c?.models.length ? c.models : [settings.codexModel];
  const pct = c && c.dailyLimit > 0 ? Math.min(100, Math.round((c.imagesToday / c.dailyLimit) * 100)) : 0;
  return (
    <Card title="ChatGPT (Codex)" aside={c ? (c.mode === 'chatgpt' ? 'Đã đăng nhập gói ChatGPT' : c.mode === 'api-key' ? 'Dùng OPENAI_API_KEY' : 'Chưa đăng nhập') : undefined}>
      <p class="text-[12px] text-[var(--color-text-muted)]">
        Tạo ảnh bằng ChatGPT Images, chấm khuôn mặt và làm “bộ não” viết caption (chọn “ChatGPT (Codex)” trong Hồ sơ của KOL) bằng tài khoản ChatGPT đã đăng nhập Codex. Không tính tiền mỗi ảnh nhưng trừ vào hạn mức dùng của gói; mỗi ảnh mất khoảng 1–2 phút.
      </p>
      {c && !c.configured && <p class="text-[12px] text-[var(--color-status-failed)]">{c.hint}</p>}
      {c?.mode === 'api-key' && <p class="text-[12px] text-[var(--color-text-muted)]">{c.hint}</p>}
      {c && (
        <div class="flex flex-col gap-1">
          <div class="flex items-baseline justify-between gap-2 text-[12px]">
            <span class="text-[var(--color-text-muted)]">Ảnh ChatGPT hôm nay</span>
            <span class="tabular-nums">{c.imagesToday}{c.dailyLimit > 0 ? ` / ${c.dailyLimit}` : ' · không giới hạn'}</span>
          </div>
          {c.dailyLimit > 0 && (
            <div class="h-1.5 rounded-full bg-[var(--color-elevated)] overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={c.dailyLimit} aria-valuenow={c.imagesToday} aria-label="Ảnh ChatGPT hôm nay">
              <div class={`h-full ${pct >= 90 ? 'bg-[var(--color-status-failed)]' : 'bg-[var(--color-accent)]'}`} style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}
      <FieldGrid>
        <Field label="Số ảnh ChatGPT mỗi ngày" hint="Giữ hạn mức gói ChatGPT cho việc khác. 0 = không giới hạn.">
          <input type="number" min={0} max={1000} step={1} class={`${INPUT} w-full`} value={settings.chatgptDailyLimit} onInput={(e) => onChange({ chatgptDailyLimit: Number((e.target as HTMLInputElement).value) })} />
        </Field>
        <Field label="Số ảnh ChatGPT chạy song song" hint="1–6. Nhiều hơn thì xong nhanh hơn nhưng dễ bị ChatGPT ngắt kết nối hoặc chạm giới hạn của gói hơn.">
          <select class={`${INPUT} w-full`} value={settings.chatgptParallel} onChange={(e) => onChange({ chatgptParallel: Number((e.target as HTMLSelectElement).value) })}>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Model Codex" hint="Model điều khiển Codex khi tạo ảnh, chấm khuôn mặt và viết caption. Bản luna nhanh nhất; bản sol chấm khuôn mặt kỹ hơn. Ảnh do ChatGPT Images vẽ nên chất lượng ảnh như nhau.">
          <select class={`${INPUT} w-full`} value={settings.codexModel} onChange={(e) => onChange({ codexModel: (e.target as HTMLSelectElement).value })}>
            {!models.includes(settings.codexModel) && <option value={settings.codexModel}>{settings.codexModel}</option>}
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
      </FieldGrid>
    </Card>
  );
}

function ServiceRow({ ok, label, okText, badText, href }: { ok: boolean; label: string; okText: string; badText: string; href: string }) {
  return (
    <li class="flex flex-wrap items-center gap-2">
      {ok ? <CheckCircle2 size={15} class="text-[var(--color-status-done)]" /> : <XCircle size={15} class="text-[var(--color-text-faint)]" />}
      <span class="font-medium">{label}</span>
      <span class="text-[12px] text-[var(--color-text-muted)]">{ok ? okText : badText}</span>
      {!ok && <Link href={href} class="text-[12px] text-[var(--color-accent)] underline">Thêm key</Link>}
    </li>
  );
}
