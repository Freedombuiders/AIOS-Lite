import { useState } from 'preact/hooks';
import { RefreshCw } from 'lucide-preact';
import { apiPatch, apiPost } from '@/lib/api';
import { errorMessage } from '@/lib/marketing';
import { pushToast } from '@/lib/toasts';
import { invalidateFetchCache } from '@/lib/useFetch';
import { Toggle } from '@/components/Toggle';
import { fmtMoney, type AdAccountDto, type AdAccountUpdate, type AdsResultType, type ConnStatus } from '@modules/ads/web/lib/fbstudio';
import { Card, SetupNotice } from '../common';
import { BTN, BTN_PRIMARY, LINK_CLASS, SELECT } from '@modules/ads/web/components/fb/DashStates';
import { RESULT_META } from './adsMeta';
import { AddMetaLoginButton } from './AdsConnect';

const INPUT = 'h-8 px-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[12.5px] text-[var(--color-text)] w-full focus:border-[var(--color-accent)] focus:outline-none';

/** Re-link the EXPIRED Meta Ads connection (opens Composio's auth page in a new tab). */
export function ConnectionNotice({ connection }: { connection: ConnStatus }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  async function reconnect() {
    setBusy(true);
    try {
      const res = await apiPost<{ redirectUrl: string }>('/api/m/ads/reconnect');
      setUrl(res.redirectUrl);
      window.open(res.redirectUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      pushToast({ tone: 'error', title: 'Chưa mở được trang kết nối lại', description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (connection === 'EXPIRED') {
    return (
      <SetupNotice title="Kết nối Meta Ads đã hết hạn">
        <p class="m-0 mb-2">Composio không còn quyền đọc tài khoản quảng cáo, nên số liệu dừng cập nhật. Bấm nút dưới, đăng nhập lại Meta trong tab mới, rồi quay về đây bấm “Đồng bộ tài khoản”.</p>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" class={BTN_PRIMARY} onClick={reconnect} disabled={busy}>{busy ? 'Đang mở…' : 'Kết nối lại Meta Ads'}</button>
          {url && <a href={url} target="_blank" rel="noopener noreferrer" class={`${LINK_CLASS} text-[12.5px]`}>Tab không mở? Bấm vào đây</a>}
        </div>
      </SetupNotice>
    );
  }
  return (
    <SetupNotice title="Chưa có kết nối Meta Ads">
      <p class="m-0">Kết nối toolkit <strong>Meta Ads</strong> trong tài khoản Composio của bạn (mục Connected accounts), sau đó bấm “Đồng bộ tài khoản” bên dưới để lấy danh sách tài khoản quảng cáo. Nếu trước đây đã kết nối mà vẫn thấy thông báo này, hãy thử đồng bộ lại.</p>
    </SetupNotice>
  );
}

interface Draft { enabled: boolean; resultType: AdsResultType; targetCpa: string; monthlyBudget: string }

function toDraft(a: AdAccountDto): Draft {
  return { enabled: a.enabled, resultType: a.resultType, targetCpa: a.targetCpa === null ? '' : String(a.targetCpa), monthlyBudget: a.monthlyBudget === null ? '' : String(a.monthlyBudget) };
}

function numOrNull(v: string): number | null {
  const n = Number(v.replace(/[\s.,](?=\d{3}\b)/g, '').replace(',', '.'));
  return v.trim() === '' || !Number.isFinite(n) || n < 0 ? null : n;
}

function AccountRow({ account }: { account: AdAccountDto }) {
  const [d, setD] = useState<Draft>(() => toDraft(account));
  const [saving, setSaving] = useState(false);
  const base = toDraft(account);
  const dirty = d.enabled !== base.enabled || d.resultType !== base.resultType || d.targetCpa !== base.targetCpa || d.monthlyBudget !== base.monthlyBudget;
  const r = RESULT_META[d.resultType];
  const bad = (d.targetCpa.trim() !== '' && numOrNull(d.targetCpa) === null) || (d.monthlyBudget.trim() !== '' && numOrNull(d.monthlyBudget) === null);

  async function save() {
    setSaving(true);
    try {
      const body: AdAccountUpdate = { enabled: d.enabled, resultType: d.resultType, targetCpa: numOrNull(d.targetCpa), monthlyBudget: numOrNull(d.monthlyBudget) };
      await apiPatch(`/api/m/ads/accounts/${encodeURIComponent(account.id)}`, body);
      pushToast({ tone: 'success', title: 'Đã lưu tài khoản quảng cáo' });
      invalidateFetchCache('/api/m/ads/');
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const idp = `ads-${account.id}`;
  return (
    <div class="flex flex-col gap-3 py-3 border-t border-[var(--color-border)] first:border-t-0 first:pt-0">
      <div class="flex flex-wrap items-center gap-3">
        <Toggle on={d.enabled} onChange={() => setD({ ...d, enabled: !d.enabled })} ariaLabel={`Bật theo dõi ${account.name}`} size="sm" />
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-semibold text-[var(--color-text)] truncate">{account.name || account.id}</div>
          <div class="text-[11.5px] text-[var(--color-text-muted)]">{account.id} · {account.currency} · {account.status === 'ACTIVE' ? 'kết nối ổn' : account.status === 'EXPIRED' ? 'kết nối hết hạn' : 'chưa rõ kết nối'}</div>
        </div>
      </div>
      <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
        <label class="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]" for={`${idp}-rt`}>
          Kết quả cần đo
          <select id={`${idp}-rt`} class={`${SELECT} w-full`} value={d.resultType} onChange={(e) => setD({ ...d, resultType: (e.target as HTMLSelectElement).value as AdsResultType })}>
            {(Object.keys(RESULT_META) as AdsResultType[]).map((k) => <option key={k} value={k}>{RESULT_META[k].name}</option>)}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]" for={`${idp}-cpa`}>
          {r.cpa} mục tiêu ({account.currency})
          <input id={`${idp}-cpa`} class={INPUT} inputMode="decimal" placeholder="Ví dụ 120000" value={d.targetCpa} onInput={(e) => setD({ ...d, targetCpa: (e.target as HTMLInputElement).value })} />
        </label>
        <label class="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]" for={`${idp}-bud`}>
          Ngân sách tháng ({account.currency})
          <input id={`${idp}-bud`} class={INPUT} inputMode="decimal" placeholder="Để trống nếu không theo dõi" value={d.monthlyBudget} onInput={(e) => setD({ ...d, monthlyBudget: (e.target as HTMLInputElement).value })} />
        </label>
      </div>
      {bad && <div class="text-[12px]" style={{ color: 'color-mix(in srgb, #ef4444 55%, var(--color-text))' }}>Nhập số không âm, không kèm chữ.</div>}
      <div class="flex gap-2">
        <button type="button" class={BTN_PRIMARY} onClick={save} disabled={!dirty || saving || bad}>{saving ? 'Đang lưu…' : 'Lưu'}</button>
        {dirty && <button type="button" class={BTN} onClick={() => setD(base)} disabled={saving}>Hoàn tác</button>}
      </div>
    </div>
  );
}

export function AdsAccountsPanel({ accounts, canAddLogin = false }: { accounts: AdAccountDto[]; canAddLogin?: boolean }) {
  const [syncing, setSyncing] = useState(false);
  async function sync() {
    setSyncing(true);
    try {
      await apiPost('/api/m/ads/accounts/sync');
      pushToast({ tone: 'success', title: 'Đã đồng bộ tài khoản quảng cáo' });
      invalidateFetchCache('/api/m/ads/');
    } catch (err) {
      pushToast({ tone: 'error', title: 'Chưa đồng bộ được', description: errorMessage(err) });
    } finally {
      setSyncing(false);
    }
  }
  return (
    <Card
      title="Tài khoản & mục tiêu"
      aside={(
        <span class="inline-flex flex-wrap gap-2">
          {canAddLogin && <AddMetaLoginButton />}
          <button type="button" class={`${BTN} inline-flex items-center gap-1.5`} onClick={sync} disabled={syncing}><RefreshCw size={13} class={syncing ? 'animate-spin' : ''} /> Đồng bộ tài khoản</button>
        </span>
      )}
    >
      {accounts.length === 0 ? (
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Chưa có tài khoản quảng cáo nào. Bấm “Đồng bộ tài khoản” sau khi Meta Ads đã được kết nối trong Composio.</p>
      ) : (
        <div class="flex flex-col">
          <p class="m-0 mb-3 text-[12.5px] text-[var(--color-text-muted)]">Bật tài khoản cần theo dõi và đặt mục tiêu. Mọi đề xuất được tính theo giá mỗi kết quả mục tiêu này.</p>
          {accounts.map((a) => <AccountRow key={`${a.id}-${a.enabled}-${a.resultType}-${a.targetCpa}-${a.monthlyBudget}`} account={a} />)}
        </div>
      )}
    </Card>
  );
}

/**
 * Shown on an account screen with no target: the rules (cut, scale, refresh)
 * need one. Pre-filled with the last 14 days' cost per result when known.
 */
export function TargetPrompt({ account, suggested }: { account: AdAccountDto; suggested: number | null }) {
  const r = RESULT_META[account.resultType];
  const [type, setType] = useState<AdsResultType>(account.resultType);
  const [value, setValue] = useState(suggested ? String(Math.round(suggested)) : '');
  const [budget, setBudget] = useState('');
  const [saving, setSaving] = useState(false);
  const cpa = numOrNull(value);
  const bud = budget.trim() === '' ? null : numOrNull(budget);
  const bad = cpa === null || cpa <= 0 || (budget.trim() !== '' && bud === null);

  async function save() {
    if (bad) return;
    setSaving(true);
    try {
      const body: AdAccountUpdate = { resultType: type, targetCpa: cpa, ...(bud ? { monthlyBudget: bud } : {}) };
      await apiPatch(`/api/m/ads/accounts/${encodeURIComponent(account.id)}`, body);
      pushToast({ tone: 'success', title: 'Đã đặt mục tiêu', description: 'Đề xuất tắt, giảm, tăng ngân sách được tính lại ngay.' });
      invalidateFetchCache('/api/m/ads/');
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được mục tiêu', description: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const id = `tp-${account.id}`;
  return (
    <section aria-labelledby={`${id}-h`} class="rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-4 py-3.5 flex flex-col gap-3">
      <div>
        <h2 id={`${id}-h`} class="m-0 text-[14px] font-semibold text-[var(--color-text)]">Đặt mục tiêu để bật đề xuất tối ưu</h2>
        <p class="m-0 mt-1 text-[12.5px] text-[var(--color-text-muted)] max-w-3xl">
          Mọi luật (tắt nhóm đốt tiền, giảm, tăng ngân sách, làm mới creative) so với {r.cpa} mục tiêu.
          {suggested ? <> Gợi ý: <strong class="text-[var(--color-text)]">{fmtMoney(suggested, account.currency)}</strong>, bằng {r.cpa} trung bình 14 ngày qua.</> : ' Nhập mức bạn chấp nhận trả cho mỗi kết quả.'}
        </p>
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)]" for={`${id}-t`}>
          Kết quả cần đo
          <select id={`${id}-t`} class={SELECT} value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value as AdsResultType)}>
            {(Object.keys(RESULT_META) as AdsResultType[]).map((k) => <option key={k} value={k}>{RESULT_META[k].name}</option>)}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)] w-[170px]" for={`${id}-c`}>
          {RESULT_META[type].cpa} mục tiêu ({account.currency})
          <input id={`${id}-c`} class={INPUT} inputMode="decimal" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
        </label>
        <label class="flex flex-col gap-1 text-[12px] text-[var(--color-text-muted)] w-[190px]" for={`${id}-b`}>
          Ngân sách tháng (không bắt buộc)
          <input id={`${id}-b`} class={INPUT} inputMode="decimal" placeholder="Để theo dõi nhịp chi" value={budget} onInput={(e) => setBudget((e.target as HTMLInputElement).value)} />
        </label>
        <button type="button" class={BTN_PRIMARY} onClick={save} disabled={saving || bad}>{saving ? 'Đang lưu…' : 'Lưu mục tiêu'}</button>
      </div>
    </section>
  );
}
