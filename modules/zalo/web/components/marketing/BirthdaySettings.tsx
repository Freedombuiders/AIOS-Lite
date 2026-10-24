import { useEffect, useState } from 'preact/hooks';
import { AlertTriangle, Save } from 'lucide-preact';
import { Toggle } from '@/components/Toggle';
import { TemplatePicker } from '../TemplatePicker';
import { apiPut } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import type { ZaloAccount } from '../../lib/zalo';
import {
  BTN, INPUT, LABEL, OCCASION_LABEL, errMsg,
  type BirthdayConfig, type BirthdayConfigResponse, type BirthdayOccasion,
} from './BirthdayShared';

const TIMEZONES = ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'UTC'];

interface OccasionRow {
  occasion: BirthdayOccasion;
  enabledKey: 'beforeEnabled' | 'onDayEnabled' | 'afterEnabled';
  daysKey?: 'beforeDays' | 'afterDays';
  templateKey: 'beforeTemplateId' | 'onDayTemplateId' | 'afterTemplateId';
  hint: string;
}

const OCCASIONS: OccasionRow[] = [
  { occasion: 'before', enabledKey: 'beforeEnabled', daysKey: 'beforeDays', templateKey: 'beforeTemplateId', hint: 'Báo trước vài ngày, ví dụ gợi ý ưu đãi sinh nhật.' },
  { occasion: 'on_day', enabledKey: 'onDayEnabled', templateKey: 'onDayTemplateId', hint: 'Lời chúc chính, gửi đúng ngày sinh nhật của khách.' },
  { occasion: 'after', enabledKey: 'afterEnabled', daysKey: 'afterDays', templateKey: 'afterTemplateId', hint: 'Nhắn lại sau sinh nhật, ví dụ nhắc ưu đãi còn hạn.' },
];

function inQuietWindow(time: string, q: { enabled: boolean; start: string; end: string }): boolean {
  if (!q.enabled) return false;
  const mins = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const t = mins(time), s = mins(q.start), e = mins(q.end);
  if ([t, s, e].some((n) => !Number.isFinite(n)) || s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

function sameConfig(a: BirthdayConfig, b: BirthdayConfig): boolean {
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}

export function BirthdaySettings({ data, accounts, onSaved }: {
  data: BirthdayConfigResponse;
  accounts: ZaloAccount[];
  onSaved: () => void;
}) {
  const [form, setForm] = useState<BirthdayConfig>(data.config);
  const [saving, setSaving] = useState(false);
  // Pick up the server copy after a save or a refresh, unless the user is mid-edit.
  const [base, setBase] = useState<BirthdayConfig>(data.config);
  useEffect(() => {
    if (sameConfig(form, base)) setForm(data.config);
    setBase(data.config);
  }, [JSON.stringify(data.config)]);

  const dirty = !sameConfig(form, base);
  const set = <K extends keyof BirthdayConfig>(key: K, value: BirthdayConfig[K]) => setForm((f) => ({ ...f, [key]: value }));
  const num = (key: 'lateToleranceMinutes' | 'beforeDays' | 'afterDays' | 'perNickDailyQuota' | 'minDelaySec' | 'maxDelaySec') =>
    (e: Event) => set(key, Number((e.target as HTMLInputElement).value) || 0);

  const quiet = inQuietWindow(form.sendTime, data.quietHours)
    || (form.sendTime === base.sendTime && data.sendTimeInQuietHours);

  async function save() {
    setSaving(true);
    try {
      await apiPut('/api/m/zalo/birthday/config', form);
      pushToast({ tone: 'success', title: 'Đã lưu cấu hình chúc sinh nhật' });
      onSaved();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errMsg(err) });
    } finally {
      setSaving(false);
    }
  }

  function toggleNick(id: string) {
    set('accountIds', form.accountIds.includes(id) ? form.accountIds.filter((x) => x !== id) : [...form.accountIds, id]);
  }

  return (
    <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] w-full min-w-0">
      <div class="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
        <div class="min-w-0">
          <h2 class="text-[13.5px] font-semibold text-[var(--color-text)]">Cấu hình</h2>
          <p class="text-[11.5px] text-[var(--color-text-faint)]">
            Lời chúc gửi từ chính nick đang chat 1-1 với khách, tôn trọng giờ yên tĩnh và hạn mức bảo vệ nick.
          </p>
        </div>
        <label class="ml-auto flex items-center gap-2 text-[12px] text-[var(--color-text)] whitespace-nowrap">
          {form.enabled ? 'Đang bật' : 'Đang tắt'}
          <Toggle on={form.enabled} onChange={() => set('enabled', !form.enabled)} ariaLabel="Bật/tắt chúc mừng sinh nhật" />
        </label>
      </div>

      <div class="p-4 flex flex-col gap-5">
        <div class="grid gap-3 grid-cols-1 sm:grid-cols-3">
          <div>
            <label class={LABEL} for="bd-time">Giờ gửi</label>
            <input id="bd-time" type="time" class={INPUT} value={form.sendTime} onInput={(e) => set('sendTime', (e.target as HTMLInputElement).value)} />
          </div>
          <div>
            <label class={LABEL} for="bd-tz">Múi giờ</label>
            <select id="bd-tz" class={INPUT} value={form.timezone} onChange={(e) => set('timezone', (e.target as HTMLSelectElement).value)}>
              {(TIMEZONES.includes(form.timezone) ? TIMEZONES : [form.timezone, ...TIMEZONES]).map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div>
            <label class={LABEL} for="bd-late">Trễ tối đa (phút)</label>
            <input id="bd-late" type="number" min={0} max={1440} class={INPUT} value={form.lateToleranceMinutes} onInput={num('lateToleranceMinutes')} />
            <p class="text-[10.5px] text-[var(--color-text-faint)] mt-1">Quá mức này lời chúc bị bỏ, không gửi bù.</p>
          </div>
        </div>

        {quiet && (
          <div class="flex items-start gap-2 rounded-md border border-[color-mix(in_srgb,var(--color-priority-medium)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-priority-medium)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--color-text)]">
            <AlertTriangle size={14} class="shrink-0 mt-0.5 text-[var(--color-priority-medium)]" />
            <span>
              Giờ gửi {form.sendTime} nằm trong giờ yên tĩnh ({data.quietHours.start}–{data.quietHours.end}). Hệ thống sẽ không gửi trong khung này,
              lời chúc chờ đến hết giờ yên tĩnh và bị bỏ nếu vượt quá “trễ tối đa”. Hãy chọn giờ gửi ngoài khung đó.
            </span>
          </div>
        )}

        <div class="flex flex-col gap-3">
          {OCCASIONS.map((o) => {
            const on = form[o.enabledKey];
            return (
              <div key={o.occasion} class="rounded-md border border-[var(--color-border)] p-3 flex flex-col gap-2.5">
                <div class="flex items-center gap-3">
                  <Toggle size="sm" on={on} onChange={() => set(o.enabledKey, !on)} ariaLabel={`Bật dịp ${OCCASION_LABEL[o.occasion]}`} />
                  <div class="min-w-0">
                    <div class="text-[12.5px] font-medium text-[var(--color-text)]">{OCCASION_LABEL[o.occasion]}</div>
                    <div class="text-[11px] text-[var(--color-text-faint)]">{o.hint}</div>
                  </div>
                  {o.daysKey && (
                    <label class="ml-auto flex items-center gap-1.5 text-[12px] text-[var(--color-text-muted)] whitespace-nowrap">
                      {o.occasion === 'before' ? 'Trước' : 'Sau'}
                      <input
                        type="number" min={1} max={30} disabled={!on}
                        class={`${INPUT} !w-[64px] !px-2 !py-1`}
                        value={form[o.daysKey]}
                        onInput={num(o.daysKey)}
                        aria-label="Số ngày"
                      />
                      ngày
                    </label>
                  )}
                </div>
                {on && (
                  <TemplatePicker value={form[o.templateKey]} onChange={(id) => set(o.templateKey, id)} />
                )}
              </div>
            );
          })}
        </div>

        <div class="grid gap-3 grid-cols-1 sm:grid-cols-3">
          <div>
            <label class={LABEL} for="bd-quota">Hạn mức mỗi nick / ngày</label>
            <input id="bd-quota" type="number" min={1} max={500} class={INPUT} value={form.perNickDailyQuota} onInput={num('perNickDailyQuota')} />
          </div>
          <div>
            <label class={LABEL} for="bd-min">Nghỉ giữa 2 khách, tối thiểu (giây)</label>
            <input id="bd-min" type="number" min={5} max={600} class={INPUT} value={form.minDelaySec} onInput={num('minDelaySec')} />
          </div>
          <div>
            <label class={LABEL} for="bd-max">Tối đa (giây)</label>
            <input id="bd-max" type="number" min={5} max={600} class={INPUT} value={form.maxDelaySec} onInput={num('maxDelaySec')} />
          </div>
        </div>

        <div>
          <div class={LABEL}>Nick áp dụng</div>
          <div class="flex flex-wrap gap-x-4 gap-y-1.5">
            {accounts.map((a) => (
              <label key={a.id} class="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-text)]">
                <input type="checkbox" checked={form.accountIds.includes(a.id)} onChange={() => toggleNick(a.id)} />
                {a.displayName || a.label}
              </label>
            ))}
            {accounts.length === 0 && <span class="text-[12px] text-[var(--color-text-faint)]">Chưa có nick Zalo.</span>}
          </div>
          <p class="text-[10.5px] text-[var(--color-text-faint)] mt-1">
            {form.accountIds.length === 0 ? 'Không chọn nick nào = áp dụng cho tất cả nick.' : `Chỉ chúc khách của ${form.accountIds.length} nick đã chọn.`}
          </p>
        </div>

        <div class="flex items-center gap-2">
          <button type="button" class={`${BTN} control-accent`} disabled={!dirty || saving} onClick={() => void save()}>
            <Save size={13} /> {saving ? 'Đang lưu…' : 'Lưu cấu hình'}
          </button>
          {dirty && (
            <button type="button" class={BTN} disabled={saving} onClick={() => setForm(base)}>Hoàn tác</button>
          )}
        </div>
      </div>
    </section>
  );
}
