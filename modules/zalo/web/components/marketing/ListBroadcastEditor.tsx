import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ArrowLeft, UserX } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { TemplatePicker } from '../TemplatePicker';
import { Toggle } from '@/components/Toggle';
import { apiPatch, apiPost } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import type { ZaloAccount } from '../../lib/zalo';
import { SendWindowEditor } from './SendWindowEditor';
import {
  BTN, BTN_ACCENT, INPUT, LABEL, errMsg, fmtDuration,
  type ListBroadcast, type ListEstimate, type WindowValue,
} from './ListBroadcastTypes';

interface Form {
  name: string;
  templateId: number | null;
  accountIds: string[];
  activeWithinDays: string;
  nameContains: string;
  excludePaused: boolean;
  excludeThreadIds: number[];
  /** Not editable here; kept so saving an edit doesn't drop them. */
  includeThreadIds: number[];
  window: WindowValue;
  dailyQuota: number;
  perNickDailyQuota: number;
  minDelaySec: number;
  maxDelaySec: number;
}

interface Preview {
  count: number;
  perAccount: Record<string, number>;
  sample: Array<{ threadId: number; accountId: string; name: string; lastMessageAt: number }>;
}

const DEFAULT_FORM: Form = {
  name: '',
  templateId: null,
  accountIds: [],
  activeWithinDays: '',
  nameContains: '',
  excludePaused: true,
  excludeThreadIds: [],
  includeThreadIds: [],
  window: { windowStart: '08:00', windowEnd: '17:00', daysOfWeek: [], timezone: 'Asia/Ho_Chi_Minh', startDate: null, endDate: null },
  dailyQuota: 100,
  perNickDailyQuota: 40,
  minDelaySec: 45,
  maxDelaySec: 90,
};

function fromBroadcast(b: ListBroadcast): Form {
  return {
    name: b.name,
    templateId: b.templateId,
    accountIds: b.accountIds,
    activeWithinDays: b.filter.activeWithinDays ? String(b.filter.activeWithinDays) : '',
    nameContains: b.filter.nameContains ?? '',
    excludePaused: b.filter.excludePaused !== false,
    excludeThreadIds: b.filter.excludeThreadIds ?? [],
    includeThreadIds: b.filter.includeThreadIds ?? [],
    window: {
      windowStart: b.windowStart, windowEnd: b.windowEnd, daysOfWeek: b.daysOfWeek,
      timezone: b.timezone, startDate: b.startDate, endDate: b.endDate,
    },
    dailyQuota: b.dailyQuota,
    perNickDailyQuota: b.perNickDailyQuota,
    minDelaySec: b.minDelaySec,
    maxDelaySec: b.maxDelaySec,
  };
}

function filterOf(f: Form) {
  const days = parseInt(f.activeWithinDays, 10);
  return {
    activeWithinDays: Number.isFinite(days) && days > 0 ? days : null,
    nameContains: f.nameContains.trim(),
    excludePaused: f.excludePaused,
    excludeThreadIds: f.excludeThreadIds,
    includeThreadIds: f.includeThreadIds,
  };
}

function payloadOf(f: Form) {
  return {
    name: f.name,
    templateId: f.templateId,
    accountIds: f.accountIds,
    filter: filterOf(f),
    ...f.window,
    dailyQuota: f.dailyQuota,
    perNickDailyQuota: f.perNickDailyQuota,
    minDelaySec: f.minDelaySec,
    maxDelaySec: f.maxDelaySec,
  };
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ComponentChildren }) {
  return (
    <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-3">
      <div>
        <h2 class="text-[13px] font-semibold text-[var(--color-text)]">{title}</h2>
        {hint && <div class="text-[11.5px] text-[var(--color-text-faint)] mt-0.5">{hint}</div>}
      </div>
      {children}
    </section>
  );
}

interface Props {
  /** Existing campaign to edit; omit to create. */
  editId?: number;
  onDone: (id: number) => void;
  onCancel: () => void;
}

export function ListBroadcastEditor({ editId, onDone, onCancel }: Props) {
  const accounts = useFetch<{ accounts: ZaloAccount[] }>('/api/m/zalo/accounts');
  const existing = useFetch<{ broadcast: ListBroadcast }>(editId ? `/api/m/zalo/list-broadcasts/${editId}` : null);
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [loaded, setLoaded] = useState(!editId);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [estimate, setEstimate] = useState<ListEstimate | null>(null);
  const [estimateError, setEstimateError] = useState('');
  const [saving, setSaving] = useState(false);

  const accountList = accounts.data?.accounts ?? [];
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    if (editId && existing.data && !loaded) {
      setForm(fromBroadcast(existing.data.broadcast));
      setLoaded(true);
    }
  }, [existing.data]);

  // Live preview of who the filter selects (debounced; nothing is saved).
  const previewKey = JSON.stringify([form.accountIds, filterOf(form)]);
  useEffect(() => {
    if (form.accountIds.length === 0) { setPreview(null); setPreviewError(''); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiPost<Preview>('/api/m/zalo/list-broadcasts/preview-recipients', { accountIds: form.accountIds, filter: filterOf(form) })
        .then((p) => { if (!cancelled) { setPreview(p); setPreviewError(''); } })
        .catch((err) => { if (!cancelled) setPreviewError(errMsg(err)); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [previewKey]);

  // ETA and quota warnings, from the same numbers the server will use.
  const estimateKey = JSON.stringify([payloadOf(form), preview?.count ?? 0]);
  useEffect(() => {
    if (!form.templateId || form.accountIds.length === 0) { setEstimate(null); setEstimateError(''); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiPost<{ estimate: ListEstimate }>('/api/m/zalo/list-broadcasts/estimate', { ...payloadOf(form), recipientCount: preview?.count ?? 0 })
        .then((r) => { if (!cancelled) { setEstimate(r.estimate); setEstimateError(''); } })
        .catch((err) => { if (!cancelled) { setEstimate(null); setEstimateError(errMsg(err)); } });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [estimateKey]);

  const accountName = useMemo(() => {
    const map = new Map(accountList.map((a) => [a.id, a.displayName || a.label]));
    return (id: string) => map.get(id) ?? id;
  }, [accounts.data]);

  const valid = form.name.trim().length > 0 && form.templateId !== null && form.accountIds.length > 0;

  function toggleAccount(id: string) {
    set('accountIds', form.accountIds.includes(id) ? form.accountIds.filter((x) => x !== id) : [...form.accountIds, id]);
  }

  async function save(activate: boolean) {
    setSaving(true);
    try {
      const body = payloadOf(form);
      let id = editId;
      if (editId) {
        await apiPatch(`/api/m/zalo/list-broadcasts/${editId}`, body);
      } else {
        id = (await apiPost<{ broadcast: ListBroadcast }>('/api/m/zalo/list-broadcasts', body)).broadcast.id;
      }
      if (activate && id) {
        await apiPost(`/api/m/zalo/list-broadcasts/${id}/activate`);
        pushToast({ tone: 'success', title: 'Đã kích hoạt chiến dịch' });
      } else {
        pushToast({ tone: 'success', title: 'Đã lưu chiến dịch' });
      }
      if (id) onDone(id);
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errMsg(err) });
    } finally {
      setSaving(false);
    }
  }

  if (editId && !loaded) return existing.error ? <PageState error={existing.error} /> : <PageState loading />;

  return (
    <div class="flex-1 overflow-y-auto px-6 py-5">
      <div class="w-full min-w-0 flex flex-col gap-4">
        <button type="button" class={`${BTN} self-start`} onClick={onCancel}><ArrowLeft size={13} /> Quay lại</button>

        <Section title="Chiến dịch">
          <div>
            <label class={LABEL}>Tên chiến dịch</label>
            <input class={INPUT} value={form.name} maxLength={120} placeholder="Ví dụ: Tri ân khách cũ tháng 10" onInput={(e) => set('name', (e.target as HTMLInputElement).value)} />
          </div>
          <div>
            <label class={LABEL}>Mẫu tin gửi</label>
            <TemplatePicker value={form.templateId} onChange={(id) => set('templateId', id)} />
            <div class="mt-1 text-[11px] text-[var(--color-text-faint)]">Mỗi khách nhận một bản được điền biến và xoay vòng cách nói riêng ({'{name}'}, {'{a|b}'}).</div>
          </div>
        </Section>

        <Section
          title="Người nhận"
          hint="Chỉ gồm khách đã nhắn tin 1-1 với nick. Không nhập số điện thoại, không nhắn người lạ. Khách đã từ chối nhận tin tự động bị loại."
        >
          <div>
            <label class={LABEL}>Nick gửi</label>
            {accountList.length === 0 ? (
              <div class="text-[12px] text-[var(--color-text-faint)]">Chưa có nick Zalo. Thêm ở Zalo · Tài khoản.</div>
            ) : (
              <div class="flex flex-wrap gap-2">
                {accountList.map((a) => {
                  const on = form.accountIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleAccount(a.id)}
                      class={['toolbar-control control-button px-3 rounded-md text-[12px]', on ? 'control-accent' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)]'].join(' ')}
                    >
                      {a.displayName || a.label}
                      {a.status !== 'connected' && <span class="ml-1 text-[10px] opacity-70">(offline)</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class={LABEL}>Chỉ khách có tin nhắn trong … ngày gần đây</label>
              <input type="number" min={1} max={3650} class={INPUT} value={form.activeWithinDays} placeholder="Bỏ trống = tất cả" onInput={(e) => set('activeWithinDays', (e.target as HTMLInputElement).value)} />
            </div>
            <div>
              <label class={LABEL}>Tên khách chứa (không phân biệt dấu)</label>
              <input class={INPUT} value={form.nameContains} placeholder="Ví dụ: lan" onInput={(e) => set('nameContains', (e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <label class="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
            <Toggle size="sm" on={form.excludePaused} onChange={() => set('excludePaused', !form.excludePaused)} ariaLabel="Bỏ khách đang chuyển người thật" />
            Bỏ khách đang được người thật chăm (agent tạm dừng)
          </label>

          <div class="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
            {form.accountIds.length === 0 ? (
              <div class="text-[12px] text-[var(--color-text-faint)]">Chọn nick để xem danh sách khách phù hợp.</div>
            ) : previewError ? (
              <div class="text-[12px] text-[var(--color-status-failed)]">{previewError}</div>
            ) : !preview ? (
              <div class="text-[12px] text-[var(--color-text-faint)]">Đang đếm…</div>
            ) : (
              <>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[var(--color-text)]">
                  <b>{preview.count.toLocaleString('vi-VN')} khách</b> sẽ nhận tin
                  {Object.entries(preview.perAccount).map(([id, n]) => (
                    <span key={id} class="text-[11.5px] text-[var(--color-text-faint)]">{accountName(id)}: {n}</span>
                  ))}
                  {form.excludeThreadIds.length > 0 && (
                    <button type="button" class="text-[11.5px] text-[var(--color-accent)] hover:underline" onClick={() => set('excludeThreadIds', [])}>
                      Đã loại {form.excludeThreadIds.length} khách · hoàn tác
                    </button>
                  )}
                </div>
                {preview.sample.length > 0 && (
                  <ul class="mt-2 divide-y divide-[var(--color-border)] text-[12px]">
                    {preview.sample.map((s) => (
                      <li key={s.threadId} class="flex items-center gap-2 py-1">
                        <span class="truncate text-[var(--color-text)]">{s.name || 'Không tên'}</span>
                        <span class="text-[11px] text-[var(--color-text-faint)] shrink-0">{accountName(s.accountId)}</span>
                        <button
                          type="button"
                          class="ml-auto p-1 rounded hover:bg-[var(--color-control-hover)] text-[var(--color-text-faint)] hover:text-[var(--color-status-failed)]"
                          aria-label={`Loại ${s.name} khỏi danh sách`}
                          title="Loại khỏi danh sách"
                          onClick={() => set('excludeThreadIds', [...form.excludeThreadIds, s.threadId])}
                        >
                          <UserX size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {preview.count > preview.sample.length && (
                  <div class="mt-1 text-[11px] text-[var(--color-text-faint)]">Hiện {preview.sample.length} khách đầu tiên (hoạt động gần nhất).</div>
                )}
              </>
            )}
          </div>
        </Section>

        <Section title="Khung giờ gửi" hint="Chiến dịch chỉ gửi trong khung giờ này, rải đều từng khách một. Hết khung giờ thì dừng, hôm sau gửi tiếp.">
          <SendWindowEditor value={form.window} onChange={(w) => set('window', w)} />
        </Section>

        <Section title="Hạn mức và giãn cách" hint="Giữ nhẹ để nick an toàn: Zalo dễ khoá nick gửi dồn dập cho nhiều người.">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label class={LABEL}>Khách / ngày (tối đa 2000)</label>
              <input type="number" min={1} max={2000} class={INPUT} value={form.dailyQuota} onInput={(e) => set('dailyQuota', Number((e.target as HTMLInputElement).value))} />
            </div>
            <div>
              <label class={LABEL}>Khách / nick / ngày</label>
              <input type="number" min={1} max={2000} class={INPUT} value={form.perNickDailyQuota} onInput={(e) => set('perNickDailyQuota', Number((e.target as HTMLInputElement).value))} />
            </div>
            <div>
              <label class={LABEL}>Giãn cách tối thiểu (giây)</label>
              <input type="number" min={20} max={900} class={INPUT} value={form.minDelaySec} onInput={(e) => set('minDelaySec', Number((e.target as HTMLInputElement).value))} />
            </div>
            <div>
              <label class={LABEL}>Giãn cách tối đa (giây)</label>
              <input type="number" min={20} max={900} class={INPUT} value={form.maxDelaySec} onInput={(e) => set('maxDelaySec', Number((e.target as HTMLInputElement).value))} />
            </div>
          </div>
          <div class="text-[11px] text-[var(--color-text-faint)]">Tối thiểu 20 giây giữa hai khách. Hạn mức mỗi nick tính chung cho mọi chiến dịch gửi 1-1 của nick đó.</div>
        </Section>

        <Section title="Ước tính">
          {estimateError ? (
            <div class="text-[12px] text-[var(--color-text-faint)]">{estimateError}</div>
          ) : !estimate ? (
            <div class="text-[12px] text-[var(--color-text-faint)]">Chọn mẫu tin và nick để xem ước tính.</div>
          ) : (
            <div class="flex flex-col gap-2 text-[12.5px] text-[var(--color-text)]">
              <div>
                Gửi tối đa <b>{estimate.effectiveDailyQuota}</b> khách/ngày
                {preview ? <> → xong <b>{preview.count}</b> khách trong khoảng <b>{estimate.sendingDays}</b> ngày gửi{estimate.calendarDays > estimate.sendingDays && <> (~{estimate.calendarDays} ngày lịch)</>}.</> : '.'}
              </div>
              <div class="text-[11.5px] text-[var(--color-text-muted)]">
                Mỗi khách {estimate.opsPerRecipient} lệnh gửi · hạn mức một ngày mất ~{fmtDuration(estimate.dailyDurationSec)} · khung giờ chứa được ~{estimate.fitsPerDay} khách.
              </div>
              {estimate.warnings.map((w) => (
                <div key={w} class="rounded border border-[color-mix(in_srgb,var(--color-priority-high)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-priority-high)_8%,transparent)] px-3 py-2 text-[12px]">{w}</div>
              ))}
            </div>
          )}
        </Section>

        <div class="flex items-center gap-2 pb-6">
          <button type="button" class={BTN} onClick={onCancel}>Huỷ</button>
          <div class="ml-auto flex gap-2">
            <button type="button" class={BTN} disabled={!valid || saving} onClick={() => void save(false)}>{editId ? 'Lưu' : 'Lưu nháp'}</button>
            {!editId && (
              <button type="button" class={BTN_ACCENT} disabled={!valid || saving} onClick={() => void save(true)}>Lưu và kích hoạt</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
