import type { WindowValue } from './ListBroadcastTypes';
import { INPUT, LABEL } from './ListBroadcastTypes';

interface Props {
  value: WindowValue;
  onChange: (next: WindowValue) => void;
  disabled?: boolean;
}

// Monday first, as Vietnamese calendars do; values are JS weekdays (0 = Sunday).
const DAYS: Array<{ label: string; value: number }> = [
  { label: 'T2', value: 1 }, { label: 'T3', value: 2 }, { label: 'T4', value: 3 }, { label: 'T5', value: 4 },
  { label: 'T6', value: 5 }, { label: 'T7', value: 6 }, { label: 'CN', value: 0 },
];

const TIMEZONES = ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'UTC'];

/** Daily sending window: hours, weekdays, timezone and an optional date range. */
export function SendWindowEditor({ value, onChange, disabled }: Props) {
  const set = <K extends keyof WindowValue>(key: K, v: WindowValue[K]) => onChange({ ...value, [key]: v });
  const overnight = value.windowEnd <= value.windowStart;
  const zones = TIMEZONES.includes(value.timezone) ? TIMEZONES : [value.timezone, ...TIMEZONES];

  function toggleDay(day: number) {
    const has = value.daysOfWeek.includes(day);
    set('daysOfWeek', has ? value.daysOfWeek.filter((d) => d !== day) : [...value.daysOfWeek, day].sort());
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div>
          <label class={LABEL}>Giờ bắt đầu</label>
          <input type="time" class={INPUT} disabled={disabled} value={value.windowStart} onInput={(e) => set('windowStart', (e.target as HTMLInputElement).value)} />
        </div>
        <div>
          <label class={LABEL}>Giờ kết thúc</label>
          <input type="time" class={INPUT} disabled={disabled} value={value.windowEnd} onInput={(e) => set('windowEnd', (e.target as HTMLInputElement).value)} />
        </div>
        <div class="col-span-2 sm:col-span-1">
          <label class={LABEL}>Múi giờ</label>
          <select class={INPUT} disabled={disabled} value={value.timezone} onInput={(e) => set('timezone', (e.target as HTMLSelectElement).value)}>
            {zones.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
      </div>
      {overnight && value.windowStart !== value.windowEnd && (
        <div class="text-[11.5px] text-[var(--color-text-faint)] -mt-1">Khung giờ qua đêm: gửi từ {value.windowStart} đến {value.windowEnd} sáng hôm sau.</div>
      )}

      <div>
        <label class={LABEL}>Ngày gửi trong tuần {value.daysOfWeek.length === 0 && <span class="font-normal text-[var(--color-text-faint)]">(để trống = mọi ngày)</span>}</label>
        <div class="flex flex-wrap gap-1.5">
          {DAYS.map((d) => {
            const on = value.daysOfWeek.includes(d.value);
            return (
              <button
                key={d.value}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => toggleDay(d.value)}
                class={[
                  'toolbar-control control-button px-3 rounded-md text-[12px] disabled:opacity-40',
                  on ? 'control-accent' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-control-hover)]',
                ].join(' ')}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label class={LABEL}>Từ ngày (tuỳ chọn)</label>
          <input type="date" class={INPUT} disabled={disabled} value={value.startDate ?? ''} onInput={(e) => set('startDate', (e.target as HTMLInputElement).value || null)} />
        </div>
        <div>
          <label class={LABEL}>Đến ngày (tuỳ chọn)</label>
          <input type="date" class={INPUT} disabled={disabled} value={value.endDate ?? ''} onInput={(e) => set('endDate', (e.target as HTMLInputElement).value || null)} />
        </div>
      </div>
    </div>
  );
}
