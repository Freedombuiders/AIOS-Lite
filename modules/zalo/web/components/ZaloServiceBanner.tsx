import { useState } from 'preact/hooks';
import { Power, RefreshCw } from 'lucide-preact';
import { apiPost } from '@/lib/api';
import { pushToast } from '@/lib/toasts';
import type { ZaloServiceStatus } from '../lib/zalo';

interface Props {
  status: ZaloServiceStatus | null;
  onChange: () => void;
}

// Shown at the top of the Zalo pages while the Zalo service (daemon) is not running. Hidden when all is well.
export function ZaloServiceBanner({ status, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  if (!status || status.daemon.running) return null;

  async function restart() {
    setBusy(true);
    try {
      await apiPost('/api/m/zalo/daemon/restart');
      pushToast({ tone: 'success', title: 'Đã khởi động dịch vụ Zalo' });
      setTimeout(onChange, 1500);
    } catch (err) {
      pushToast({ tone: 'error', title: 'Không thực hiện được', description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="mx-6 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-[color-mix(in_srgb,var(--color-priority-high)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-priority-high)_8%,transparent)] px-4 py-3">
      <Power size={15} class="text-[var(--color-priority-high)] shrink-0" />
      <div class="flex-1 min-w-[200px] text-[12.5px] text-[var(--color-text)]">
        Dịch vụ Zalo chưa chạy (AIOS sẽ tự khởi động lại nếu nó bị sập). Bấm khởi động để đăng nhập nick và nhận tin nhắn.
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={restart}
        class="control-button inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium control-accent disabled:opacity-50"
      >
        {busy && <RefreshCw size={12} class="animate-spin" />}
        Khởi động ngay
      </button>
    </div>
  );
}
