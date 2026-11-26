import { LogIn } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { errorText } from '@/lib/api';
import { signInToCloud, type CloudStatus } from '@/lib/packs';
import { pushToast } from '@/lib/toasts';

/**
 * "Đăng nhập cloud": opens the cloud's Google sign-in in the browser; the cloud sends the browser back to this
 * machine's /api/cloud/callback, which stores the session encrypted. Pasting a token on the Kết nối page still works.
 */
export function CloudSignInButton({ cloudUrl, label, accent = true, onDone }: { cloudUrl?: string; label?: string; accent?: boolean; onDone?: (s: CloudStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    setBusy(true);
    setError('');
    try {
      const s = await signInToCloud(cloudUrl?.trim() || undefined);
      pushToast({ tone: 'success', title: 'Đã đăng nhập AgenticOS Cloud', description: s.account || undefined });
      onDone?.(s);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span class="inline-flex flex-col gap-1">
      <button type="button" class={`control-button ${accent ? 'control-accent' : ''} inline-flex items-center gap-1`} disabled={busy} onClick={() => void go()}>
        <LogIn size={13} /> {busy ? 'Đang chờ đăng nhập trong trình duyệt…' : label ?? 'Đăng nhập cloud'}
      </button>
      {error && <span role="alert" class="text-[12px] text-[var(--color-status-failed)]">{error}</span>}
    </span>
  );
}

/** Panel shown on Kho dữ liệu when this machine has no cloud session. */
export function CloudSignInPanel({ status, onDone }: { status: CloudStatus | null; onDone: () => void }) {
  const [url, setUrl] = useState(status?.cloudUrl ?? '');
  return (
    <div class="card card-pad flex flex-col gap-2">
      <div class="font-medium">Đăng nhập AgenticOS Cloud để xem kho</div>
      <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">
        Kho dữ liệu nằm trên cloud. Nhập địa chỉ cloud rồi bấm đăng nhập: trình duyệt mở trang đăng nhập Google, xong thì quay lại đây.
        Phiên của máy được lưu mã hoá trên máy này; cloud không nhận dữ liệu khách của shop.
      </p>
      <label class="flex flex-col gap-1 text-[12.5px]">
        Địa chỉ cloud
        <input class="field" style={{ maxWidth: 360 }} placeholder="https://cloud.example.com" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
      </label>
      <div><CloudSignInButton cloudUrl={url} onDone={onDone} /></div>
      <p class="hint m-0">Hoặc dán mã phiên ở trang Kết nối › AgenticOS Cloud.</p>
    </div>
  );
}
