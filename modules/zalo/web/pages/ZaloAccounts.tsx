import { useEffect, useState } from 'preact/hooks';
import { History, Pencil, Plus, Power, QrCode, RefreshCw, ShieldCheck, Trash2, UsersRound } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Toggle } from '@/components/Toggle';
import { ZaloServiceBanner } from '../components/ZaloServiceBanner';
import { AddZaloNickModal, NickLimitsModal, ProtectionSettingsModal, QrLoginModal, UsageBar, effectiveStatus, zaloNickApi } from '../components/ZaloNickModals';
import { BTN, INPUT, errMsg } from '../components/shared';
import { apiDelete } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import { formatRelativeTime } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import {
  STATUS_LABEL, STATUS_TONE, initials,
  type ZaloAccount, type ZaloServiceStatus,
} from '../lib/zalo';


export function ZaloAccounts() {
  const status = useFetch<ZaloServiceStatus>('/api/m/zalo/status', 10_000);
  const accounts = useFetch<{ accounts: ZaloAccount[]; daemonReachable: boolean }>('/api/m/zalo/accounts', 5_000);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ZaloAccount | null>(null);
  const [protectionOpen, setProtectionOpen] = useState(false);
  const list = accounts.data?.accounts ?? [];

  async function removeAccount(a: ZaloAccount) {
    try {
      await apiDelete(`/api/m/zalo/accounts/${encodeURIComponent(a.id)}`);
      pushToast({ tone: 'success', title: `Đã xoá ${a.displayName || a.label}` });
      accounts.refresh();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không xoá được', description: errMsg(err) });
    }
  }

  return (
    <div class="flex flex-col h-full">
      <PageHeader
        breadcrumb="Zalo"
        title="Tài khoản"
        actions={
          <>
            <button type="button" class={BTN} onClick={() => setProtectionOpen(true)}>
              <ShieldCheck size={13} /> Cài đặt chống khoá
            </button>
            <button type="button" class={BTN} onClick={() => setAdding(true)}>
              <Plus size={13} /> Thêm nick Zalo
            </button>
          </>
        }
      />
      <ZaloServiceBanner status={status.data} onChange={() => { status.refresh(); accounts.refresh(); }} />

      <div class="flex-1 overflow-y-auto px-6 py-5">
        {accounts.error && <PageState error={accounts.error} />}
        {accounts.loading && list.length === 0 && <PageState loading />}
        {!accounts.loading && !accounts.error && list.length === 0 && (
          <PageState
            empty
            emptyTitle="Chưa có nick Zalo nào"
            emptyDescription="Thêm nick rồi quét mã QR bằng app Zalo trên điện thoại. Tin nhắn mới và lịch sử nhóm sẽ được lưu để chạy chiến dịch và đưa vào Hộp thư chăm sóc khách hàng."
          />
        )}
        <div class="grid gap-4 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
          {list.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              onQr={() => setQrFor(a.id)}
              onDelete={() => setDeleting(a)}
              onChanged={accounts.refresh}
            />
          ))}
        </div>

        <div class="mt-6 max-w-3xl text-[11.5px] leading-relaxed text-[var(--color-text-faint)]">
          Lưu ý an toàn nick: mỗi nick chỉ giữ được một phiên Zalo Web. Đừng mở Zalo Web/Zalo PC cho nick này ở nơi khác,
          và đừng chạy song song với ZaloCRM trên cùng nick — hai bên sẽ đá phiên của nhau liên tục.
          Giữ giới hạn tin/ngày ở mức thấp để tránh bị Zalo gắn cờ.
        </div>
      </div>

      <AddZaloNickModal
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(id) => { setAdding(false); accounts.refresh(); setQrFor(id); }}
      />

      {protectionOpen && <ProtectionSettingsModal onClose={() => setProtectionOpen(false)} onSaved={accounts.refresh} />}

      {qrFor && <QrLoginModal accountId={qrFor} onClose={() => { setQrFor(null); accounts.refresh(); }} />}

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) void removeAccount(deleting); setDeleting(null); }}
        title="Xoá nick Zalo?"
        body={`Xoá "${deleting?.displayName || deleting?.label}" cùng toàn bộ lịch sử chat và nhật ký đã lưu.`}
        detail="Không hoàn tác được. Nick trên điện thoại không bị ảnh hưởng."
        confirmLabel="Xoá"
        cancelLabel="Huỷ"
        destructive
      />
    </div>
  );
}

function AccountCard({ account: a, onQr, onDelete, onChanged }: {
  account: ZaloAccount;
  onQr: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [label, setLabel] = useState(a.label);
  const [cap, setCap] = useState(String(a.dailyMessageCap));
  const st = effectiveStatus(a);
  const connected = st === 'connected';

  useEffect(() => { setCap(String(a.dailyMessageCap)); }, [a.dailyMessageCap]);

  async function action(name: string, ok: string) {
    setBusy(name);
    try {
      await zaloNickApi.action(a.id, name);
      pushToast({ tone: 'success', title: ok });
      onChanged();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không thực hiện được', description: errMsg(err) });
    } finally {
      setBusy(null);
    }
  }

  async function patch(body: Record<string, unknown>) {
    try {
      await zaloNickApi.patch(a.id, body);
      onChanged();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không lưu được', description: errMsg(err) });
    }
  }

  return (
    <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4 flex flex-col gap-3">
      <div class="flex items-start gap-3">
        {a.avatarUrl ? (
          <img src={a.avatarUrl} alt="" class="w-11 h-11 rounded-full object-cover shrink-0" referrerpolicy="no-referrer" />
        ) : (
          <div class="w-11 h-11 rounded-full bg-[var(--color-elevated)] flex items-center justify-center text-[13px] font-semibold text-[var(--color-text-muted)] shrink-0">
            {initials(a.displayName || a.label)}
          </div>
        )}
        <div class="flex-1 min-w-0">
          {editing ? (
            <input
              class={INPUT}
              value={label}
              autoFocus
              onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
              onBlur={() => { setEditing(false); if (label.trim() !== a.label) void patch({ label }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          ) : (
            <div class="flex items-center gap-1.5">
              <div class="text-[14px] font-semibold text-[var(--color-text)] truncate">{a.displayName || a.label || 'Nick chưa đăng nhập'}</div>
              <button type="button" aria-label="Đổi tên gợi nhớ" class="p-1 rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]" onClick={() => setEditing(true)}>
                <Pencil size={11} />
              </button>
            </div>
          )}
          <div class="text-[11.5px] text-[var(--color-text-faint)] truncate">
            {a.displayName && a.label ? `${a.label} · ` : ''}{a.zaloUid ? `UID ${a.zaloUid}` : 'Chưa liên kết'}
          </div>
        </div>
        <div class="flex flex-col items-end gap-1">
          <Pill tone={STATUS_TONE[st]}>{STATUS_LABEL[st]}</Pill>
          {a.warmup.week > 0 && <Pill tone="accent">Nuôi nick tuần {a.warmup.week}</Pill>}
        </div>
      </div>

      <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--color-text-muted)]">
        <span>{a.threadCount} hội thoại</span>
        {a.lastConnectedAt && <span>Kết nối lần cuối {formatRelativeTime(a.lastConnectedAt)}</span>}
        {a.live?.backfilling && <span class="text-[var(--color-accent)]">Đang kéo lịch sử…</span>}
      </div>

      {a.lastError && !connected && (
        <div class="text-[11.5px] text-[var(--color-status-failed)] leading-snug">{a.lastError}</div>
      )}

      {a.sendLockReason && (
        <div class="rounded-md border border-[color-mix(in_srgb,var(--color-status-failed)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-status-failed)_10%,transparent)] px-3 py-2 text-[11.5px] leading-snug text-[var(--color-status-failed)]">
          <b>Nick bị khoá gửi tin tự động.</b> {a.sendLockReason}
          <div class="mt-1 text-[var(--color-text-muted)]">
            Kiểm tra nick trên điện thoại (có bị Zalo cảnh báo không), rồi bật lại “Cho phép gửi tin” để mở khoá.
          </div>
        </div>
      )}

      <UsageBar account={a} />

      <div class="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--color-border)] pt-3">
        <label class="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
          <Toggle size="sm" on={a.chatEnabled} onChange={() => void patch({ chatEnabled: !a.chatEnabled })} ariaLabel="Cho phép gửi tin" />
          Cho phép gửi tin
        </label>
        <label class="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
          Tối đa
          <input
            type="number"
            min={1}
            max={2000}
            value={cap}
            class="w-20 px-2 py-1 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-[13px] text-[var(--color-text)] tabular-nums"
            onInput={(e) => setCap((e.target as HTMLInputElement).value)}
            onBlur={() => { if (Number(cap) !== a.dailyMessageCap) void patch({ dailyMessageCap: Number(cap) }); }}
          />
          tin/ngày
        </label>
        <label class="flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]" title="Giới hạn số tin/ngày tăng dần theo tuần kể từ lần kết nối đầu tiên">
          <Toggle size="sm" on={a.warmup.enabled} onChange={() => void patch({ warmupEnabled: !a.warmup.enabled })} ariaLabel="Nuôi nick mới" />
          Nuôi nick mới
        </label>
      </div>

      <div class="flex flex-wrap gap-2">
        {(!connected) && (
          <button type="button" class={BTN} onClick={onQr}>
            <QrCode size={13} /> {a.hasSession ? 'Quét QR lại' : 'Đăng nhập QR'}
          </button>
        )}
        {!connected && a.hasSession && st !== 'connecting' && (
          <button type="button" class={BTN} disabled={busy !== null} onClick={() => action('reconnect', 'Đang kết nối lại')}>
            <RefreshCw size={13} class={busy === 'reconnect' ? 'animate-spin' : ''} /> Kết nối lại
          </button>
        )}
        {connected && (
          <>
            <button type="button" class={BTN} disabled={busy !== null} onClick={() => action('sync-history', 'Đã bắt đầu kéo lịch sử')}>
              <History size={13} /> Kéo lịch sử
            </button>
            <button type="button" class={BTN} disabled={busy !== null} onClick={() => action('sync-groups', 'Đã cập nhật danh sách nhóm')}>
              <UsersRound size={13} class={busy === 'sync-groups' ? 'animate-pulse' : ''} /> Cập nhật nhóm
            </button>
            <button type="button" class={BTN} disabled={busy !== null} onClick={() => action('disconnect', 'Đã ngắt kết nối')}>
              <Power size={13} /> Ngắt kết nối
            </button>
          </>
        )}
        <button type="button" class={BTN} onClick={() => setLimitsOpen(true)}>
          <ShieldCheck size={13} /> Trần an toàn
        </button>
        <button type="button" class={`${BTN} ml-auto text-[var(--color-status-failed)]`} onClick={onDelete}>
          <Trash2 size={13} /> Xoá
        </button>
      </div>

      {limitsOpen && <NickLimitsModal account={a} onClose={() => setLimitsOpen(false)} onSaved={onChanged} />}
    </div>
  );
}
