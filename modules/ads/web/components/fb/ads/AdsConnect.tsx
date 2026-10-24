import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Copy, ExternalLink, Link2 } from 'lucide-preact';
import { apiGet, apiPost } from '@/lib/api';
import { errorMessage } from '@/lib/marketing';
import { pushToast } from '@/lib/toasts';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import type { ConnStatus } from '@modules/ads/web/lib/fbstudio';
import { Card } from '../common';
import { BTN, BTN_PRIMARY, LINK_CLASS } from '@modules/ads/web/components/fb/DashStates';

interface ConnectInfo { hasAuthConfig: boolean; redirectUri: string; scopes: string }

const INPUT = 'h-9 px-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] text-[13px] text-[var(--color-text)] w-full font-mono focus:border-[var(--color-accent)] focus:outline-none';
const POLL_MS = 4000;
const POLL_FOR_MS = 4 * 60_000;

function CopyField({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div class="flex items-center gap-2 min-w-0">
      <code class="flex-1 min-w-0 truncate px-2.5 py-1.5 rounded-md bg-[var(--color-elevated)] text-[12px] text-[var(--color-text)]" title={value}>{value}</code>
      <button
        type="button"
        class={`${BTN} inline-flex items-center gap-1.5 shrink-0`}
        aria-label={`Sao chép ${label}`}
        onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}
      >
        {done ? <Check size={13} /> : <Copy size={13} />} {done ? 'Đã chép' : 'Chép'}
      </button>
    </div>
  );
}

/**
 * Waits for the new connection after the owner finishes Meta's login in the
 * other tab, then pulls the account list once. Stops after a few minutes.
 */
function useConnectWatcher(onConnected: () => void) {
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);
  return () => {
    if (timer.current) window.clearInterval(timer.current);
    const until = Date.now() + POLL_FOR_MS;
    timer.current = window.setInterval(async () => {
      if (Date.now() > until) { window.clearInterval(timer.current!); timer.current = null; return; }
      try {
        const res = await apiGet<{ connection: ConnStatus }>('/api/m/ads/accounts?fresh=1');
        if (res.connection !== 'ACTIVE') return;
        window.clearInterval(timer.current!);
        timer.current = null;
        await apiPost('/api/m/ads/accounts/sync').catch(() => undefined);
        invalidateFetchCache('/api/m/ads/');
        onConnected();
      } catch { /* keep waiting */ }
    }, POLL_MS);
  };
}

async function openConnect(body: Record<string, string> | undefined): Promise<string> {
  const res = await apiPost<{ redirectUrl: string }>('/api/m/ads/connect', body ?? {});
  window.open(res.redirectUrl, '_blank', 'noopener,noreferrer');
  return res.redirectUrl;
}

/** First connection: walks the owner through their own Meta app, then Meta's login. */
export function AdsConnectPanel() {
  const info = useFetch<ConnectInfo>('/api/m/ads/connect');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const watch = useConnectWatcher(() => {
    setWaiting(false);
    pushToast({ tone: 'success', title: 'Đã kết nối Meta Ads', description: 'Đang lấy danh sách tài khoản quảng cáo.' });
  });

  const idOk = /^\d{6,20}$/.test(appId.trim());
  const secretOk = /^[a-f0-9]{32}$/i.test(appSecret.trim());
  const needsApp = info.data ? !info.data.hasAuthConfig : false;

  async function connect() {
    setBusy(true);
    try {
      const u = await openConnect(needsApp ? { appId: appId.trim(), appSecret: appSecret.trim() } : undefined);
      setUrl(u);
      setWaiting(true);
      setAppSecret('');
      watch();
      info.refresh();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Chưa mở được trang đăng nhập Meta', description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const step = (n: number, title: string, body: preact.ComponentChildren) => (
    <li class="grid gap-3" style={{ gridTemplateColumns: '28px minmax(0, 1fr)' }}>
      <span class="w-7 h-7 rounded-full grid place-items-center text-[12.5px] font-semibold bg-[var(--color-accent-soft)] text-[var(--color-text)]" aria-hidden="true">{n}</span>
      <div class="flex flex-col gap-2 min-w-0 pt-0.5">
        <div class="text-[13.5px] font-semibold text-[var(--color-text)]">{title}</div>
        <div class="text-[13px] text-[var(--color-text-muted)] flex flex-col gap-2">{body}</div>
      </div>
    </li>
  );

  return (
    <Card title="Kết nối Meta Ads" aside={<span class="inline-flex items-center gap-1.5"><Link2 size={13} /> Chỉ đọc · quyền {info.data?.scopes ?? 'ads_read'}</span>}>
      <p class="m-0 text-[13px] text-[var(--color-text-muted)] max-w-3xl">
        Đăng nhập Meta một lần là AIOS-Lite thấy <strong class="text-[var(--color-text)]">mọi tài khoản quảng cáo</strong> bạn có quyền xem, ở tất cả business portfolio (Kaching Capital, Kaching Business…).
        Ứng dụng chỉ đọc số liệu, không tạo, sửa hay tắt quảng cáo nào.
      </p>

      {info.loading && !info.data ? (
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">Đang kiểm tra Composio…</p>
      ) : info.error && !info.data ? (
        <p class="m-0 text-[13px] text-[var(--color-text-muted)]">{info.error}</p>
      ) : needsApp ? (
        <ol class="list-none m-0 p-0 flex flex-col gap-4 max-w-3xl">
          {step(1, 'Tạo một Meta App (một lần)', (
            <>
              <span>
                Mở <a class={LINK_CLASS} href="https://developers.facebook.com/apps/creation/" target="_blank" rel="noopener noreferrer">developers.facebook.com › Tạo ứng dụng <ExternalLink size={11} class="inline" /></a>,
                chọn trường hợp sử dụng <strong>“Tạo và quản lý quảng cáo bằng Marketing API”</strong> và gắn với business portfolio của bạn. Ứng dụng để ở chế độ phát triển là đủ, vì chỉ bạn đăng nhập.
              </span>
              <span>Trong <strong>Facebook Login for Business › Cài đặt</strong>, dán đường dẫn này vào “URI chuyển hướng OAuth hợp lệ”:</span>
              {info.data && <CopyField value={info.data.redirectUri} label="URI chuyển hướng" />}
            </>
          ))}
          {step(2, 'Dán App ID và App Secret', (
            <>
              <span>Lấy ở <strong>Cài đặt ứng dụng › Thông tin cơ bản</strong>. Khóa bí mật được lưu trong Composio, không lưu trong AIOS-Lite.</span>
              <div class="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
                <label class="flex flex-col gap-1 text-[12px]">
                  App ID
                  <input class={INPUT} inputMode="numeric" autoComplete="off" placeholder="1234567890123456" value={appId} onInput={(e) => setAppId((e.target as HTMLInputElement).value)} />
                </label>
                <label class="flex flex-col gap-1 text-[12px]">
                  App Secret
                  <input class={INPUT} type="password" autoComplete="off" placeholder="32 ký tự" value={appSecret} onInput={(e) => setAppSecret((e.target as HTMLInputElement).value)} />
                </label>
              </div>
              {(appId && !idOk) || (appSecret && !secretOk) ? (
                <span style={{ color: 'color-mix(in srgb, #ef4444 55%, var(--color-text))' }}>App ID chỉ gồm chữ số; App Secret có 32 ký tự 0–9, a–f.</span>
              ) : null}
            </>
          ))}
          {step(3, 'Đăng nhập Meta và chọn tất cả tài khoản', (
            <>
              <span>Tab mới sẽ mở trang đăng nhập Meta. Khi Meta hỏi, chọn <strong>tất cả business portfolio và tài khoản quảng cáo</strong>. Xong quay lại đây, danh sách tự hiện.</span>
              <div class="flex flex-wrap items-center gap-3">
                <button type="button" class={BTN_PRIMARY} onClick={connect} disabled={busy || !idOk || !secretOk}>{busy ? 'Đang mở…' : 'Kết nối Meta Ads'}</button>
                {url && <a href={url} target="_blank" rel="noopener noreferrer" class={`${LINK_CLASS} text-[12.5px]`}>Tab không mở? Bấm vào đây</a>}
              </div>
            </>
          ))}
        </ol>
      ) : (
        <div class="flex flex-col gap-2 max-w-3xl">
          <span class="text-[13px] text-[var(--color-text-muted)]">Meta App đã có trong Composio. Bấm nút, đăng nhập Meta ở tab mới và chọn tất cả business portfolio, tài khoản quảng cáo.</span>
          <div class="flex flex-wrap items-center gap-3">
            <button type="button" class={BTN_PRIMARY} onClick={connect} disabled={busy}>{busy ? 'Đang mở…' : 'Kết nối Meta Ads'}</button>
            {url && <a href={url} target="_blank" rel="noopener noreferrer" class={`${LINK_CLASS} text-[12.5px]`}>Tab không mở? Bấm vào đây</a>}
          </div>
        </div>
      )}
      {waiting && <p role="status" class="m-0 text-[12.5px] text-[var(--color-text-muted)]">Đang chờ bạn đăng nhập Meta ở tab bên cạnh…</p>}
    </Card>
  );
}

/** "Thêm đăng nhập Meta khác": a second Meta user brings their own ad accounts. */
export function AddMetaLoginButton() {
  const [busy, setBusy] = useState(false);
  const watch = useConnectWatcher(() => pushToast({ tone: 'success', title: 'Đã thêm kết nối Meta Ads' }));
  async function go() {
    setBusy(true);
    try {
      await openConnect(undefined);
      watch();
    } catch (err) {
      pushToast({ tone: 'error', title: 'Chưa mở được trang đăng nhập Meta', description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" class={`${BTN} inline-flex items-center gap-1.5`} onClick={go} disabled={busy} title="Đăng nhập thêm một tài khoản Meta khác để lấy tài khoản quảng cáo của nó">
      <Link2 size={13} /> Thêm đăng nhập Meta
    </button>
  );
}
