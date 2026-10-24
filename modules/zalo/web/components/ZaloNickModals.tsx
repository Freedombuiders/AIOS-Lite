// Zalo nick connection flows (add a nick, QR login, anti-ban settings, per-nick limits, usage bar). Used by
// pages/ZaloAccounts.tsx and by the care channel panel (ZaloChannelPanel), so both run the SAME components.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Modal } from '@/components/Modal';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { Toggle } from '@/components/Toggle';
import { apiGet, apiPatch, apiPost, apiPut } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import { pushToast } from '@/lib/toasts';
import {
  CATEGORY_LABEL,
  type ZaloAccount, type ZaloAccountStatus, type ZaloCategoryLimit, type ZaloLimitOverrides, type ZaloLiveState,
  type ZaloOpCategory, type ZaloProtectionResponse,
} from '../lib/zalo';
import { BTN, INPUT, errMsg } from './shared';

/**
 * Live session state wins over the DB row: the row can still say
 * "connected" from before the daemon stopped.
 */
export function effectiveStatus(a: ZaloAccount): ZaloAccountStatus {
  if (a.live?.live === 'connected') return 'connected';
  if (a.live?.live === 'qr_pending') return 'qr_pending';
  if (a.live?.live === 'connecting') return 'connecting';
  return a.status === 'connected' || a.status === 'connecting' || a.status === 'qr_pending' ? 'disconnected' : a.status;
}

/** "Hôm nay X/Y tin" with a bar; Y is the effective cap (warm-up aware). */
export function UsageBar({ account: a }: { account: ZaloAccount }) {
  const used = a.usage?.message.used ?? 0;
  const limit = a.usage?.message.limit ?? a.effectiveMessageCap;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div class="flex items-center justify-between text-[11.5px] text-[var(--color-text-muted)]">
        <span>Hôm nay <b class="tabular-nums text-[var(--color-text)]">{used}/{limit}</b> tin</span>
        {a.warmup.week > 0 && a.warmup.cap !== null && (
          <span class="text-[var(--color-text-faint)]">trần tuần {a.warmup.week}: {a.warmup.cap} tin/ngày</span>
        )}
      </div>
      <div class="mt-1 h-1.5 rounded-full bg-[var(--color-elevated)] overflow-hidden">
        <div
          class="h-full rounded-full"
          style={{ width: `${pct}%`, backgroundColor: pct >= 90 ? 'var(--color-status-failed)' : 'var(--color-accent)' }}
        />
      </div>
    </div>
  );
}

// ── Limit tables (global defaults and per-nick overrides) ───────────

type LimitField = keyof ZaloCategoryLimit;
type LimitDraft = Record<ZaloOpCategory, Record<LimitField, string>>;

const LIMIT_FIELDS: Array<{ key: LimitField; label: string }> = [
  { key: 'daily', label: 'Tối đa/ngày' },
  { key: 'burst', label: 'Dồn/cửa sổ' },
  { key: 'windowSec', label: 'Cửa sổ (giây)' },
];

function toDraft(categories: ZaloOpCategory[], overrides: ZaloLimitOverrides): LimitDraft {
  const draft = {} as LimitDraft;
  for (const cat of categories) {
    const o = overrides[cat] ?? {};
    draft[cat] = {
      daily: o.daily !== undefined ? String(o.daily) : '',
      burst: o.burst !== undefined ? String(o.burst) : '',
      windowSec: o.windowSec !== undefined ? String(o.windowSec) : '',
    };
  }
  return draft;
}

/** Blank fields drop out, so the next level down (default) applies. */
function fromDraft(draft: LimitDraft): ZaloLimitOverrides {
  const out: ZaloLimitOverrides = {};
  for (const cat of Object.keys(draft) as ZaloOpCategory[]) {
    const entry: Partial<ZaloCategoryLimit> = {};
    for (const { key } of LIMIT_FIELDS) {
      const n = parseInt(draft[cat][key], 10);
      if (Number.isFinite(n) && n > 0) entry[key] = n;
    }
    if (Object.keys(entry).length > 0) out[cat] = entry;
  }
  return out;
}

function LimitTable({ categories, draft, placeholders, onChange }: {
  categories: ZaloOpCategory[];
  draft: LimitDraft;
  placeholders: Record<ZaloOpCategory, Record<LimitField, string>>;
  onChange: (cat: ZaloOpCategory, key: LimitField, value: string) => void;
}) {
  return (
    <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
      <table class="w-full text-[13px]">
        <thead>
          <tr class="text-left text-[12px] text-[var(--color-text-faint)] border-b border-[var(--color-border)]">
            <th class="px-3 py-2 font-medium">Thao tác</th>
            {LIMIT_FIELDS.map((f) => <th key={f.key} class="px-2 py-2 font-medium">{f.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {categories.map((cat) => (
            <tr key={cat} class="border-b border-[var(--color-border)] last:border-b-0">
              <td class="px-3 py-1.5 text-[var(--color-text)]">{CATEGORY_LABEL[cat]}</td>
              {LIMIT_FIELDS.map((f) => (
                <td key={f.key} class="px-2 py-1.5">
                  <input
                    type="number"
                    min={1}
                    value={draft[cat][f.key]}
                    placeholder={placeholders[cat][f.key]}
                    class="w-24 px-2 py-1 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-[13px] text-[var(--color-text)] tabular-nums focus:outline-none focus:border-[var(--color-accent)]"
                    onInput={(e) => onChange(cat, f.key, (e.target as HTMLInputElement).value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function limitPlaceholders(
  categories: ZaloOpCategory[],
  defaults: Record<ZaloOpCategory, ZaloCategoryLimit>,
  global: ZaloLimitOverrides,
  extra?: (cat: ZaloOpCategory, key: LimitField) => number | undefined,
): Record<ZaloOpCategory, Record<LimitField, string>> {
  const out = {} as Record<ZaloOpCategory, Record<LimitField, string>>;
  for (const cat of categories) {
    out[cat] = {} as Record<LimitField, string>;
    for (const { key } of LIMIT_FIELDS) {
      out[cat][key] = String(extra?.(cat, key) ?? global[cat]?.[key] ?? defaults[cat][key]);
    }
  }
  return out;
}

const NUM = 'w-24 px-2 py-1.5 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-[12.5px] text-[var(--color-text)] tabular-nums focus:outline-none focus:border-[var(--color-accent)]';

function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <div>
      <label class="block text-[13px] font-medium text-[var(--color-text-muted)] mb-1">{label}</label>
      {children}
      {hint && <div class="text-[12px] text-[var(--color-text-faint)] mt-1 leading-snug">{hint}</div>}
    </div>
  );
}

/** "Cài đặt chống khoá": quiet hours, caps, auto-lock, warm-up and the default limit table. */
export function ProtectionSettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const res = useFetch<ZaloProtectionResponse>('/api/m/zalo/settings');
  const [quietOn, setQuietOn] = useState(true);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('07:00');
  const [agentCap, setAgentCap] = useState('500');
  const [lockThreshold, setLockThreshold] = useState('3');
  const [warmup, setWarmup] = useState(['30', '80', '150']);
  const [bulkShare, setBulkShare] = useState('60');
  const [draft, setDraft] = useState<LimitDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const data = res.data;

  useEffect(() => {
    if (!data) return;
    const st = data.settings;
    setQuietOn(st.quietHours.enabled);
    setQuietStart(st.quietHours.start);
    setQuietEnd(st.quietHours.end);
    setAgentCap(String(st.agentDailyReplyCap));
    setLockThreshold(String(st.restrictionLockThreshold));
    setWarmup([0, 1, 2].map((i) => String(st.warmupSchedule[i] ?? '')));
    setBulkShare(String(st.bulkSharePercent));
    setDraft(toDraft(data.categories, st.limits));
  }, [data]);

  async function save() {
    if (!data || !draft) return;
    setSaving(true);
    try {
      const schedule = warmup.map((w) => parseInt(w, 10)).filter((n) => Number.isFinite(n) && n > 0);
      await apiPut('/api/m/zalo/settings', {
        quietHours: { enabled: quietOn, start: quietStart, end: quietEnd },
        agentDailyReplyCap: Number(agentCap),
        restrictionLockThreshold: Number(lockThreshold),
        warmupSchedule: schedule,
        bulkSharePercent: Number(bulkShare),
        limits: fromDraft(draft),
      });
      pushToast({ tone: 'success', title: 'Đã lưu cài đặt chống khoá' });
      onSaved();
      onClose();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errMsg(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Cài đặt chống khoá nick"
      width={680}
      footer={
        <>
          <button type="button" class={BTN} onClick={onClose}>Huỷ</button>
          <button
            type="button"
            disabled={saving || !draft}
            onClick={() => void save()}
            class="control-button ml-auto px-3 py-1.5 rounded text-[12.5px] font-medium control-accent disabled:opacity-40"
          >
            Lưu
          </button>
        </>
      }
    >
      {res.error && <PageState error={res.error} />}
      {!data && !res.error && <PageState loading />}
      {data && draft && (
        <div class="flex flex-col gap-5">
          <div>
            <div class="flex items-center gap-2.5">
              <Toggle size="sm" on={quietOn} onChange={() => setQuietOn(!quietOn)} ariaLabel="Giờ nghỉ" />
              <span class="text-[12.5px] font-medium text-[var(--color-text)]">Giờ nghỉ (không gửi marketing, agent chỉ soạn nháp)</span>
              {data.quietNow && quietOn && <Pill tone="accent">đang trong giờ nghỉ</Pill>}
            </div>
            <div class={`flex items-center gap-2 mt-2 text-[13px] text-[var(--color-text-muted)] ${quietOn ? '' : 'opacity-50'}`}>
              Từ
              <input type="time" value={quietStart} disabled={!quietOn} class={NUM} onInput={(e) => setQuietStart((e.target as HTMLInputElement).value)} />
              đến
              <input type="time" value={quietEnd} disabled={!quietOn} class={NUM} onInput={(e) => setQuietEnd((e.target as HTMLInputElement).value)} />
              <span class="text-[12px] text-[var(--color-text-faint)]">múi giờ {data.settings.timezone}; qua nửa đêm vẫn được</span>
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label="Agent trả lời tối đa/ngày" hint="Tổng số tin agent sinh ra (gửi + nháp) mỗi ngày, mọi hội thoại.">
              <input type="number" min={1} value={agentCap} class={NUM} onInput={(e) => setAgentCap((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Tự khoá sau N lần bị từ chối" hint="Số lần liên tiếp Zalo từ chối gửi thì khoá gửi của nick. 0 = không tự khoá.">
              <input type="number" min={0} max={20} value={lockThreshold} class={NUM} onInput={(e) => setLockThreshold((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Marketing dùng tối đa (%)" hint="Phần trăm trần tin/ngày dành cho chiến dịch; còn lại để chat tay và agent.">
              <input type="number" min={0} max={100} value={bulkShare} class={NUM} onInput={(e) => setBulkShare((e.target as HTMLInputElement).value)} />
            </Field>
          </div>

          <Field label="Lịch nuôi nick mới (tin/ngày)" hint="Nick đang bật “Nuôi nick mới” bị giới hạn theo tuần kể từ lần kết nối đầu tiên; sau tuần 3 dùng trần thường.">
            <div class="flex flex-wrap items-center gap-3 text-[13px] text-[var(--color-text-muted)]">
              {warmup.map((w, i) => (
                <label key={i} class="flex items-center gap-1.5">
                  Tuần {i + 1}
                  <input
                    type="number"
                    min={1}
                    value={w}
                    class={NUM}
                    onInput={(e) => setWarmup((prev) => prev.map((x, j) => (j === i ? (e.target as HTMLInputElement).value : x)))}
                  />
                </label>
              ))}
            </div>
          </Field>

          <Field label="Trần mặc định theo loại thao tác" hint="Để trống = dùng giá trị gợi ý (mặc định của hệ thống). Mỗi nick có thể ghi đè riêng ở nút “Trần an toàn”.">
            <LimitTable
              categories={data.categories}
              draft={draft}
              placeholders={limitPlaceholders(data.categories, data.defaults, {})}
              onChange={(cat, key, value) => setDraft((prev) => (prev ? { ...prev, [cat]: { ...prev[cat], [key]: value } } : prev))}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/** "Trần an toàn": per-nick overrides; blank = the default shown as placeholder. */
export function NickLimitsModal({ account: a, onClose, onSaved }: { account: ZaloAccount; onClose: () => void; onSaved: () => void }) {
  const res = useFetch<ZaloProtectionResponse>('/api/m/zalo/settings');
  const categories = res.data?.categories ?? (Object.keys(a.effectiveLimits) as ZaloOpCategory[]);
  const [draft, setDraft] = useState<LimitDraft>(() => toDraft(categories, a.limits));
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const limits = fromDraft(draft);
      await apiPatch(`/api/m/zalo/accounts/${encodeURIComponent(a.id)}`, { limits: Object.keys(limits).length > 0 ? limits : null });
      pushToast({ tone: 'success', title: 'Đã lưu trần an toàn của nick' });
      onSaved();
      onClose();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errMsg(err) });
    } finally {
      setSaving(false);
    }
  }

  const placeholders = res.data
    ? limitPlaceholders(categories, res.data.defaults, res.data.settings.limits, (cat, key) => (cat === 'message' && key === 'daily' ? a.dailyMessageCap : undefined))
    : limitPlaceholders(categories, a.effectiveLimits, {});

  return (
    <Modal
      open
      onClose={onClose}
      title={`Trần an toàn · ${a.displayName || a.label}`}
      width={680}
      footer={
        <>
          <button type="button" class={BTN} onClick={() => setDraft(toDraft(categories, {}))}>Về mặc định</button>
          <button type="button" class={`${BTN} ml-auto`} onClick={onClose}>Huỷ</button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            class="control-button px-3 py-1.5 rounded text-[12.5px] font-medium control-accent disabled:opacity-40"
          >
            Lưu
          </button>
        </>
      }
    >
      <div class="text-[11.5px] text-[var(--color-text-faint)] leading-snug mb-3">
        Chỉ đặt giá trị khi nick này cần khác mặc định (ví dụ nick mới nên thấp hơn). Để trống = dùng mặc định hiện ở mờ trong ô.
        Với “Gửi tin nhắn”, số tin/ngày thực tế còn bị chặn bởi trần của nick ({a.dailyMessageCap}) và lịch nuôi nick.
      </div>
      <LimitTable
        categories={categories}
        draft={draft}
        placeholders={placeholders}
        onChange={(cat, key, value) => setDraft((prev) => ({ ...prev, [cat]: { ...prev[cat], [key]: value } }))}
      />
    </Modal>
  );
}

export function QrLoginModal({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [state, setState] = useState<ZaloLiveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setState(null);
    setError(null);
    (async () => {
      try {
        await apiPost(`/api/m/zalo/accounts/${encodeURIComponent(accountId)}/login-qr`);
      } catch (err) {
        if (!cancelled) setError(errMsg(err));
        return;
      }
      const poll = async () => {
        if (cancelled) return;
        try {
          const s = await apiGet<ZaloLiveState>(`/api/m/zalo/accounts/${encodeURIComponent(accountId)}/state`);
          if (cancelled) return;
          setState(s);
          if (s.live === 'connected' || s.qr?.phase === 'done') {
            closeTimer.current = window.setTimeout(onClose, 1500);
            return;
          }
          if (s.qr && ['expired', 'declined', 'error'].includes(s.qr.phase)) return;
        } catch (err) {
          if (!cancelled) setError(errMsg(err));
        }
        timer = window.setTimeout(poll, 1500);
      };
      void poll();
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [accountId, attempt]);

  const qr = state?.qr;
  const done = state?.live === 'connected' || qr?.phase === 'done';
  const failed = qr && ['expired', 'declined', 'error'].includes(qr.phase);

  function close() {
    // Closing before a successful scan ends the pending QR flow in the daemon.
    if (!done) void apiPost(`/api/m/zalo/accounts/${encodeURIComponent(accountId)}/cancel-qr`).catch(() => {});
    onClose();
  }

  return (
    <Modal open onClose={close} title="Đăng nhập Zalo bằng mã QR" width={420}>
      <div class="flex flex-col items-center gap-3 py-2 text-center">
        {error && <div class="text-[12.5px] text-[var(--color-status-failed)]">{error}</div>}
        {!error && done && (
          <div class="py-8 text-[14px] font-medium text-[var(--color-status-done)]">Đăng nhập thành công. Đang kéo lịch sử nhóm…</div>
        )}
        {!error && !done && qr?.image && qr.phase === 'waiting' && (
          <>
            <img src={`data:image/png;base64,${qr.image}`} alt="Mã QR đăng nhập Zalo" class="w-60 h-60 rounded-lg bg-white p-2" />
            <div class="text-[12.5px] text-[var(--color-text-muted)] leading-relaxed">
              Mở app Zalo trên điện thoại → biểu tượng <b>Quét mã QR</b> → quét mã này, rồi bấm <b>Đăng nhập</b>.
            </div>
          </>
        )}
        {!error && !done && qr?.phase === 'scanned' && (
          <div class="py-8 text-[13px] text-[var(--color-text)]">
            Đã quét{qr.scannedName ? ` bởi ${qr.scannedName}` : ''}. Xác nhận đăng nhập trên điện thoại…
          </div>
        )}
        {!error && !done && !failed && !qr?.image && qr?.phase !== 'scanned' && (
          <div class="py-10 text-[12.5px] text-[var(--color-text-faint)]">Đang tạo mã QR…</div>
        )}
        {!error && failed && (
          <div class="py-6 text-[12.5px] text-[var(--color-status-failed)]">
            {qr?.phase === 'expired' ? 'Mã QR đã hết hạn.' : qr?.phase === 'declined' ? 'Đăng nhập bị từ chối trên điện thoại.' : qr?.error || 'Đăng nhập thất bại.'}
          </div>
        )}
        {(failed || error) && (
          <button type="button" class="control-button px-3 py-1.5 rounded text-[12.5px] font-medium control-accent" onClick={() => setAttempt((n) => n + 1)}>
            Tạo mã QR mới
          </button>
        )}
      </div>
    </Modal>
  );
}

/** "Thêm nick Zalo": asks for an optional label and the warm-up choice, creates the nick, then hands its id over (to open the QR login). */
export function AddZaloNickModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (accountId: string) => void }) {
  const [label, setLabel] = useState('');
  const [warmup, setWarmup] = useState(true);

  async function create() {
    try {
      const res = await apiPost<{ account: { id: string } }>('/api/m/zalo/accounts', { label, warmup });
      setLabel('');
      setWarmup(true);
      onCreated(res.account.id);
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không thêm được nick', description: errMsg(err) });
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Thêm nick Zalo"
      footer={
        <>
          <button type="button" class={BTN} onClick={onClose}>Huỷ</button>
          <button type="button" class="control-button ml-auto px-3 py-1.5 rounded text-[12.5px] font-medium control-accent" onClick={() => void create()} data-testid="zalo-add-continue">
            Tiếp tục quét QR
          </button>
        </>
      }
    >
      <label class="block text-[13px] text-[var(--color-text-muted)] mb-1.5">Tên gợi nhớ (tuỳ chọn)</label>
      <input
        class={INPUT}
        value={label}
        placeholder="Ví dụ: Nick CSKH khoá học"
        onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
      />
      <label class="flex items-start gap-2 mt-4 text-[12.5px] text-[var(--color-text)] cursor-pointer">
        <input
          type="checkbox"
          class="mt-0.5"
          checked={warmup}
          onChange={(e) => setWarmup((e.target as HTMLInputElement).checked)}
        />
        <span>
          Đây là nick mới — bật lịch nuôi nick
          <span class="block text-[11.5px] text-[var(--color-text-faint)] mt-0.5">
            Nick mới gửi nhiều ngay dễ bị Zalo khoá. Lịch nuôi nick giới hạn số tin/ngày tăng dần theo tuần đầu kể từ lần đăng nhập đầu tiên.
            Bỏ chọn nếu đây là nick đã dùng lâu.
          </span>
        </span>
      </label>
    </Modal>
  );
}

/** Calls of the nick card (shared by the accounts page and the care channel panel). */
export const zaloNickApi = {
  patch: (id: string, body: Record<string, unknown>) => apiPatch(`/api/m/zalo/accounts/${encodeURIComponent(id)}`, body),
  action: (id: string, name: string) => apiPost(`/api/m/zalo/accounts/${encodeURIComponent(id)}/${name}`),
};
