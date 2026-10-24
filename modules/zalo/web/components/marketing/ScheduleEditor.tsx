import { useState } from 'preact/hooks';
import { Plus, X } from 'lucide-preact';
import {
  DEFAULT_TIMEZONE, KIND_LABEL, MAX_TIMES_PER_DAY, WEEKDAYS,
  type ScheduleKind, type ScheduleValue,
} from './GroupBroadcastModel';

const INPUT = 'px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)] disabled:opacity-50';
const LABEL = 'block text-[12px] font-medium text-[var(--color-text-muted)] mb-1.5';
const CHIP_ON = 'bg-[var(--color-accent-soft)] border-[var(--color-accent)] text-[var(--color-accent)]';
const CHIP_OFF = 'bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]';

const TIMEZONES = [
  'Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Sydney',
  'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'UTC',
];

interface Props {
  value: ScheduleValue;
  onChange: (next: ScheduleValue) => void;
  disabled?: boolean;
}

/** Edits when a group broadcast fires: kind, times of day, weekdays / month days, timezone and date range. */
export function ScheduleEditor({ value, onChange, disabled }: Props) {
  const [draftTime, setDraftTime] = useState('09:00');
  const set = (patch: Partial<ScheduleValue>) => onChange({ ...value, ...patch });
  const timezones = TIMEZONES.includes(value.timezone) ? TIMEZONES : [value.timezone, ...TIMEZONES];

  function toggle<T>(list: T[], item: T): T[] {
    return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
  }

  function addTime() {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draftTime) || value.timesOfDay.includes(draftTime)) return;
    if (value.timesOfDay.length >= MAX_TIMES_PER_DAY) return;
    set({ timesOfDay: [...value.timesOfDay, draftTime].sort() });
  }

  return (
    <div class="flex flex-col gap-3">
      <div>
        <label class={LABEL}>Kiểu lịch</label>
        <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kiểu lịch">
          {(Object.keys(KIND_LABEL) as ScheduleKind[]).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={value.scheduleKind === k}
              disabled={disabled}
              class={`px-3 py-1.5 rounded border text-[12px] disabled:opacity-50 ${value.scheduleKind === k ? CHIP_ON : CHIP_OFF}`}
              onClick={() => set({ scheduleKind: k })}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        {value.scheduleKind === 'now' && (
          <div class="mt-1.5 text-[11.5px] text-[var(--color-text-faint)]">
            Bấm Kích hoạt là gửi ngay (trong vòng 1 phút), chỉ một lần.
          </div>
        )}
      </div>

      {value.scheduleKind === 'weekly' && (
        <div>
          <label class={LABEL}>Các thứ trong tuần</label>
          <div class="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => (
              <button
                key={d.value}
                type="button"
                aria-pressed={value.daysOfWeek.includes(d.value)}
                disabled={disabled}
                class={`w-10 py-1.5 rounded border text-[12px] disabled:opacity-50 ${value.daysOfWeek.includes(d.value) ? CHIP_ON : CHIP_OFF}`}
                onClick={() => set({ daysOfWeek: toggle(value.daysOfWeek, d.value) })}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {value.scheduleKind === 'monthly' && (
        <div>
          <label class={LABEL}>Các ngày trong tháng</label>
          <div class="grid grid-cols-7 gap-1 max-w-xs">
            {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
              <button
                key={day}
                type="button"
                aria-pressed={value.daysOfMonth.includes(day)}
                disabled={disabled}
                class={`py-1 rounded border text-[11.5px] tabular-nums disabled:opacity-50 ${value.daysOfMonth.includes(day) ? CHIP_ON : CHIP_OFF}`}
                onClick={() => set({ daysOfMonth: toggle(value.daysOfMonth, day) })}
              >
                {day}
              </button>
            ))}
          </div>
          {value.daysOfMonth.some((d) => d > 28) && (
            <div class="mt-1.5 text-[11.5px] text-[var(--color-text-faint)]">
              Tháng nào không có ngày {Math.max(...value.daysOfMonth)} thì bỏ qua tháng đó, không dồn sang ngày khác.
            </div>
          )}
        </div>
      )}

      {value.scheduleKind !== 'now' && (
        <div>
          <label class={LABEL}>Mốc giờ gửi (tối đa {MAX_TIMES_PER_DAY} mốc mỗi ngày)</label>
          <div class="flex flex-wrap items-center gap-1.5">
            {value.timesOfDay.map((t) => (
              <span key={t} class="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded border text-[12px] tabular-nums bg-[var(--color-card)] border-[var(--color-border)] text-[var(--color-text)]">
                {t}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Bỏ mốc ${t}`}
                  class="p-0.5 rounded hover:bg-[var(--color-control-hover)] disabled:opacity-50"
                  onClick={() => set({ timesOfDay: value.timesOfDay.filter((x) => x !== t) })}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <input
              type="time"
              class={`${INPUT} w-[110px]`}
              disabled={disabled || value.timesOfDay.length >= MAX_TIMES_PER_DAY}
              value={draftTime}
              onInput={(e) => setDraftTime((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTime(); } }}
              aria-label="Giờ cần thêm"
            />
            <button
              type="button"
              disabled={disabled || value.timesOfDay.length >= MAX_TIMES_PER_DAY}
              class="toolbar-control control-button inline-flex items-center gap-1 px-2.5 rounded-md text-[12px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40"
              onClick={addTime}
            >
              <Plus size={12} /> Thêm mốc
            </button>
          </div>
        </div>
      )}

      {value.scheduleKind !== 'now' && (
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label class={LABEL}>Múi giờ</label>
            <select
              class={`${INPUT} w-full`}
              disabled={disabled}
              value={value.timezone || DEFAULT_TIMEZONE}
              onInput={(e) => set({ timezone: (e.target as HTMLSelectElement).value })}
            >
              {timezones.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div>
            <label class={LABEL}>Từ ngày (tuỳ chọn)</label>
            <input
              type="date"
              class={`${INPUT} w-full`}
              disabled={disabled}
              value={value.startDate}
              onInput={(e) => set({ startDate: (e.target as HTMLInputElement).value })}
            />
          </div>
          <div>
            <label class={LABEL}>Đến hết ngày (tuỳ chọn)</label>
            <input
              type="date"
              class={`${INPUT} w-full`}
              disabled={disabled}
              value={value.endDate}
              min={value.startDate || undefined}
              onInput={(e) => set({ endDate: (e.target as HTMLInputElement).value })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
