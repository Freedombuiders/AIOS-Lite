import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { AlertTriangle, CircleAlert } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { TemplatePicker } from '../TemplatePicker';
import { ScheduleEditor } from './ScheduleEditor';
import {
  apiErrorMessage, DEFAULT_TIMEZONE, formatDurationSec, MAX_DELAY_CAP_SEC, MAX_GROUPS, MIN_DELAY_FLOOR_SEC,
  type Broadcast, type CostPlan, type ScheduleValue,
} from './GroupBroadcastModel';
import { apiPatch, apiPost } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import type { ZaloAccount, ZaloThreadSummary } from '../../lib/zalo';

const INPUT = 'w-full px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none text-[12.5px] text-[var(--color-text)] disabled:opacity-50';
const BTN = 'toolbar-control control-button inline-flex items-center gap-1.5 px-3 rounded-md text-[12px] text-[var(--color-text)] hover:bg-[var(--color-control-hover)] disabled:opacity-40';
const LABEL = 'block text-[12px] font-medium text-[var(--color-text-muted)] mb-1.5';

interface FormState {
  name: string;
  accountId: string;
  templateId: number | null;
  targetThreadIds: number[];
  schedule: ScheduleValue;
  minDelaySec: number;
  maxDelaySec: number;
}

function toForm(b: Broadcast | null, accounts: ZaloAccount[]): FormState {
  if (!b) {
    return {
      name: '',
      accountId: accounts.find((a) => a.chatEnabled)?.id ?? accounts[0]?.id ?? '',
      templateId: null,
      targetThreadIds: [],
      schedule: { scheduleKind: 'daily', timesOfDay: ['09:00'], daysOfWeek: [], daysOfMonth: [], timezone: DEFAULT_TIMEZONE, startDate: '', endDate: '' },
      minDelaySec: 20,
      maxDelaySec: 45,
    };
  }
  return {
    name: b.name,
    accountId: b.accountId,
    templateId: b.templateId,
    targetThreadIds: b.targetThreadIds,
    schedule: {
      scheduleKind: b.scheduleKind,
      timesOfDay: b.timesOfDay,
      daysOfWeek: b.daysOfWeek,
      daysOfMonth: b.daysOfMonth,
      timezone: b.timezone,
      startDate: b.startDate ?? '',
      endDate: b.endDate ?? '',
    },
    minDelaySec: b.minDelaySec,
    maxDelaySec: b.maxDelaySec,
  };
}

function toPayload(f: FormState) {
  return {
    name: f.name.trim(),
    accountId: f.accountId,
    templateId: f.templateId,
    targetThreadIds: f.targetThreadIds,
    ...f.schedule,
    startDate: f.schedule.startDate || null,
    endDate: f.schedule.endDate || null,
    minDelaySec: f.minDelaySec,
    maxDelaySec: f.maxDelaySec,
  };
}

function scheduleComplete(s: ScheduleValue): boolean {
  if (s.scheduleKind === 'now') return true;
  if (s.timesOfDay.length === 0) return false;
  if (s.scheduleKind === 'weekly') return s.daysOfWeek.length > 0;
  if (s.scheduleKind === 'monthly') return s.daysOfMonth.length > 0;
  return true;
}

interface Props {
  initial: Broadcast | null;
  accounts: ZaloAccount[];
  onClose: () => void;
  onSaved: (b: Broadcast) => void;
}

export function GroupBroadcastEditor({ initial, accounts, onClose, onSaved }: Props) {
  const [f, setF] = useState<FormState>(() => toForm(initial, accounts));
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [plan, setPlan] = useState<CostPlan | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setF((prev) => ({ ...prev, [key]: value }));

  const threads = useFetch<{ threads: ZaloThreadSummary[] }>(
    f.accountId ? `/api/m/zalo/threads?accountId=${encodeURIComponent(f.accountId)}&type=group&limit=500` : null,
  );
  const groups = threads.data?.threads ?? [];
  const account = accounts.find((a) => a.id === f.accountId);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter((g) => !q || g.name.toLowerCase().includes(q));
  }, [groups, query]);

  // Live cost: debounce so typing a delay or ticking groups does not hammer the API.
  const seq = useRef(0);
  useEffect(() => {
    if (!f.accountId) { setPlan(null); return; }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      apiPost<CostPlan>('/api/m/zalo/group-broadcasts/preview-cost', {
        accountId: f.accountId,
        templateId: f.templateId,
        targetThreadIds: f.targetThreadIds,
        scheduleKind: f.schedule.scheduleKind,
        timesOfDay: f.schedule.timesOfDay,
        minDelaySec: f.minDelaySec,
        maxDelaySec: f.maxDelaySec,
      }).then((p) => { if (mine === seq.current) setPlan(p); })
        .catch(() => { if (mine === seq.current) setPlan(null); });
    }, 350);
    return () => clearTimeout(timer);
  }, [f.accountId, f.templateId, f.targetThreadIds, f.schedule.scheduleKind, f.schedule.timesOfDay, f.minDelaySec, f.maxDelaySec]);

  const selected = new Set(f.targetThreadIds);
  function toggleGroup(id: number) {
    set('targetThreadIds', selected.has(id) ? f.targetThreadIds.filter((x) => x !== id) : [...f.targetThreadIds, id]);
  }
  function selectVisible() {
    const next = new Set(f.targetThreadIds);
    for (const g of visible) if (next.size < MAX_GROUPS) next.add(g.id);
    set('targetThreadIds', [...next]);
  }

  const delayOk = f.minDelaySec >= MIN_DELAY_FLOOR_SEC && f.maxDelaySec >= f.minDelaySec && f.maxDelaySec <= MAX_DELAY_CAP_SEC;
  const valid = f.name.trim() !== '' && !!f.accountId && f.templateId !== null
    && f.targetThreadIds.length > 0 && f.targetThreadIds.length <= MAX_GROUPS
    && scheduleComplete(f.schedule) && delayOk;
  const budgetBlocked = plan?.errors.some((e) => e.code === 'DAILY_BUDGET_EXCEEDED') ?? false;

  async function save() {
    setSaving(true);
    try {
      const res = initial
        ? await apiPatch<{ broadcast: Broadcast }>(`/api/m/zalo/group-broadcasts/${initial.id}`, toPayload(f))
        : await apiPost<{ broadcast: Broadcast }>('/api/m/zalo/group-broadcasts', toPayload(f));
      pushToast({ tone: 'success', title: initial ? 'Đã lưu lịch gửi' : 'Đã tạo lịch gửi (nháp)' });
      onSaved(res.broadcast);
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: apiErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Sửa lịch gửi nhóm' : 'Tạo lịch gửi nhóm'}
      width={760}
      footer={
        <>
          <button type="button" class={BTN} onClick={onClose}>Huỷ</button>
          <button
            type="button"
            disabled={!valid || saving}
            onClick={() => void save()}
            class="control-button ml-auto px-3 py-1.5 rounded text-[12.5px] font-medium control-accent disabled:opacity-40"
          >
            {saving ? 'Đang lưu…' : 'Lưu'}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-5">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class={LABEL}>Tên lịch gửi</label>
            <input class={INPUT} value={f.name} maxLength={120} placeholder="Ví dụ: Thông báo lịch học tuần" onInput={(e) => set('name', (e.target as HTMLInputElement).value)} />
          </div>
          <div>
            <label class={LABEL}>Nick Zalo gửi</label>
            <select
              class={INPUT}
              value={f.accountId}
              onInput={(e) => setF((prev) => ({ ...prev, accountId: (e.target as HTMLSelectElement).value, targetThreadIds: [] }))}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.displayName || a.label}{a.chatEnabled ? '' : ' (chỉ nhận tin)'}</option>
              ))}
            </select>
            {account && !account.chatEnabled && (
              <div class="mt-1 text-[11.5px] text-[var(--color-status-failed)]">Nick đang tắt gửi tin, hãy bật ở Zalo › Tài khoản.</div>
            )}
          </div>
        </div>

        <div>
          <div class="flex items-center gap-2 mb-1.5">
            <label class="text-[12px] font-medium text-[var(--color-text-muted)]">Nhóm nhận tin</label>
            <span class={`text-[11.5px] tabular-nums ${f.targetThreadIds.length > MAX_GROUPS ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-text-faint)]'}`}>
              {f.targetThreadIds.length}/{MAX_GROUPS} nhóm
            </span>
            <div class="ml-auto flex gap-1.5">
              <button type="button" class={BTN} disabled={visible.length === 0} onClick={selectVisible}>Chọn các nhóm đang lọc</button>
              <button type="button" class={BTN} disabled={f.targetThreadIds.length === 0} onClick={() => set('targetThreadIds', [])}>Bỏ chọn hết</button>
            </div>
          </div>
          <input class={`${INPUT} mb-1.5`} placeholder="Lọc theo tên nhóm…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
          <div class="rounded border border-[var(--color-border)] max-h-52 overflow-y-auto">
            {threads.loading && groups.length === 0 && (
              <div class="px-3 py-3 text-[12px] text-[var(--color-text-faint)]">Đang tải nhóm…</div>
            )}
            {!threads.loading && groups.length === 0 && (
              <div class="px-3 py-3 text-[12px] text-[var(--color-text-faint)]">
                Nick này chưa có nhóm nào. Bấm “Cập nhật nhóm” ở <Link href="/m/zalo" class="underline">Zalo › Tài khoản</Link> để tải danh sách nhóm của nick.
              </div>
            )}
            {groups.length > 0 && visible.length === 0 && (
              <div class="px-3 py-3 text-[12px] text-[var(--color-text-faint)]">Không có nhóm nào khớp.</div>
            )}
            {visible.map((g) => (
              <label key={g.id} class="flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--color-text)] border-b last:border-b-0 border-[var(--color-border)] hover:bg-[var(--color-card)] cursor-pointer">
                <input type="checkbox" checked={selected.has(g.id)} onChange={() => toggleGroup(g.id)} />
                <span class="truncate">{g.name || g.externalId}</span>
                {g.membersCount !== null && <span class="ml-auto text-[11px] text-[var(--color-text-faint)] tabular-nums">{g.membersCount} thành viên</span>}
              </label>
            ))}
          </div>
        </div>

        <div>
          <label class={LABEL}>Mẫu tin</label>
          <TemplatePicker value={f.templateId} onChange={(id) => set('templateId', id)} />
          <div class="mt-1 text-[11.5px] text-[var(--color-text-faint)]">
            Mỗi nhóm nhận một bản riêng: biến như {'{group}'} và nội dung xoay vòng {'{a|b}'} được áp riêng cho từng nhóm.
          </div>
        </div>

        <ScheduleEditor value={f.schedule} onChange={(s) => set('schedule', s)} />

        <div>
          <label class={LABEL}>Giãn cách giữa 2 nhóm (giây, ngẫu nhiên trong khoảng)</label>
          <div class="flex items-center gap-2">
            <input
              type="number" class={`${INPUT} w-24`} min={MIN_DELAY_FLOOR_SEC} max={MAX_DELAY_CAP_SEC} value={f.minDelaySec}
              onInput={(e) => set('minDelaySec', Number((e.target as HTMLInputElement).value))}
              aria-label="Giãn cách tối thiểu"
            />
            <span class="text-[12px] text-[var(--color-text-faint)]">đến</span>
            <input
              type="number" class={`${INPUT} w-24`} min={MIN_DELAY_FLOOR_SEC} max={MAX_DELAY_CAP_SEC} value={f.maxDelaySec}
              onInput={(e) => set('maxDelaySec', Number((e.target as HTMLInputElement).value))}
              aria-label="Giãn cách tối đa"
            />
            <span class="text-[12px] text-[var(--color-text-faint)]">giây</span>
          </div>
          <div class={`mt-1 text-[11.5px] ${delayOk ? 'text-[var(--color-text-faint)]' : 'text-[var(--color-status-failed)]'}`}>
            Tối thiểu {MIN_DELAY_FLOOR_SEC} giây và tối đa {MAX_DELAY_CAP_SEC} giây. Gửi dồn quá nhanh dễ khiến Zalo khoá nick.
          </div>
        </div>

        <CostPanel plan={plan} groupCount={f.targetThreadIds.length} />
        {budgetBlocked && (
          <div class="text-[11.5px] text-[var(--color-text-muted)] -mt-3">
            Vẫn lưu nháp được, nhưng chưa kích hoạt được cho đến khi lịch nằm trong ngân sách.
          </div>
        )}
      </div>
    </Modal>
  );
}

function CostPanel({ plan, groupCount }: { plan: CostPlan | null; groupCount: number }) {
  if (!plan) {
    return (
      <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2.5 text-[12px] text-[var(--color-text-faint)]">
        Chọn nick, mẫu tin và nhóm để xem ước tính ngân sách gửi.
      </div>
    );
  }
  const used = plan.budget > 0 ? Math.min(100, Math.round((plan.cost.opsPerDay / plan.budget) * 100)) : 100;
  const over = plan.cost.opsPerDay > plan.budget;
  return (
    <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-3 flex flex-col gap-2">
      <div class="text-[12px] font-medium text-[var(--color-text)]">Ước tính ngân sách gửi</div>
      <div class="h-1.5 rounded-full bg-[var(--color-elevated)] overflow-hidden" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={100} aria-label="Mức dùng ngân sách gửi trong ngày">
        <div class="h-full" style={{ width: `${used}%`, background: over ? 'var(--color-status-failed)' : 'var(--color-accent)' }} />
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px]">
        <Stat label="Lượt gửi / nhóm" value={String(plan.cost.opsPerGroup)} />
        <Stat label="Lượt gửi / ngày" value={`${plan.cost.opsPerDay} / ${plan.budget}`} danger={over} />
        <Stat label="Thời gian mỗi lượt" value={groupCount > 0 ? formatDurationSec(plan.cost.runDurationSec) : '—'} />
        <Stat label="Hạn mức nick hôm nay" value={`${plan.dailyCap} tin (dùng tối đa ${plan.bulkSharePercent}%)`} />
      </div>
      {plan.errors.map((e) => (
        <div key={e.code} class="flex gap-1.5 text-[12px] text-[var(--color-status-failed)]">
          <CircleAlert size={14} class="shrink-0 mt-0.5" /> <span>{e.message}</span>
        </div>
      ))}
      {plan.warnings.map((w) => (
        <div key={w.code} class="flex gap-1.5 text-[12px] text-[var(--color-priority-medium)]">
          <AlertTriangle size={14} class="shrink-0 mt-0.5" /> <span>{w.message}</span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <div class="text-[11px] text-[var(--color-text-faint)]">{label}</div>
      <div class={`tabular-nums ${danger ? 'text-[var(--color-status-failed)] font-medium' : 'text-[var(--color-text)]'}`}>{value}</div>
    </div>
  );
}
