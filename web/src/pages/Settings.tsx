import { OctagonAlert, RefreshCw } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { EnforcementBadge } from '@/components/agents/AccessEditor';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Toggle } from '@/components/Toggle';
import { Card } from '@/components/ui';
import { apiGet, apiPut, errorText, getToken, setToken } from '@/lib/api';
import type { RuntimeReport, SettingsDto } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { getAppearance, setAppearance } from '@/lib/personalization';
import type { Appearance } from '@/lib/personalization';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';

const STATUS_TONE = { pass: 'success', warn: 'warn', fail: 'error' } as const;
const STATUS_LABEL = { pass: 'Dùng được', warn: 'Cần chú ý', fail: 'Chưa dùng được' } as const;

function RuntimeRow({ r, probed }: { r: RuntimeReport; probed: boolean }) {
  return (
    <>
      <tr>
        <td class="font-medium">{r.label}</td>
        <td><Pill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Pill></td>
        <td class="mono">{r.version ?? '—'}</td>
        <td class="mono max-w-[180px] truncate" title={r.command}>{r.command ?? '—'}</td>
        <td><div class="flex flex-wrap gap-1"><EnforcementBadge level={r.capabilities.enforces.fileRead} /></div><div class="hint mt-0.5">đọc file</div></td>
        <td class="hint">{formatDateTime(r.testedAt)}{probed && <> · <b>đã gửi thử</b></>}</td>
      </tr>
      {r.checks.filter((c) => c.level !== 'info').map((c) => (
        <tr key={c.code}>
          <td />
          <td colSpan={5} class="!pt-0">
            <span class={c.level === 'error' ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-status-review)]'}>{c.message}</span>
            {c.hint && <span class="hint"> — {c.hint}</span>}
          </td>
        </tr>
      ))}
    </>
  );
}

export default function SettingsPage() {
  const rt = useFetch<{ items: RuntimeReport[] }>('/runtimes');
  const settings = useFetch<SettingsDto>('/settings');
  const [probed, setProbed] = useState<RuntimeReport[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [confirmProbe, setConfirmProbe] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [appearance, setAppearanceState] = useState<Appearance>(getAppearance());
  const [token, setTokenInput] = useState(getToken());

  const reports = probed ?? rt.data?.items ?? [];

  async function probe() {
    setConfirmProbe(false);
    setProbing(true);
    try {
      const r = await apiGet<{ items: RuntimeReport[] }>('/runtimes?probe=1');
      setProbed(r.items);
      pushToast({ tone: 'success', title: 'Đã kiểm tra thật xong' });
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không kiểm tra được', description: errorText(e) });
    } finally {
      setProbing(false);
    }
  }

  async function setStop(on: boolean) {
    setConfirmStop(false);
    try {
      await apiPut('/settings', { emergencyStop: on });
      settings.refresh();
      pushToast({ tone: on ? 'warn' : 'success', title: on ? 'Đã dừng khẩn cấp: không nhận việc mới' : 'Đã bật lại: nhận việc bình thường' });
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không đổi được', description: errorText(e) });
    }
  }

  const s = settings.data;
  return (
    <div class="page">
      <PageHeader title="Cài đặt" />

      <Card title="Dừng khẩn cấp" class="mb-3">
        <PageState loading={settings.loading && !s} error={settings.error} />
        {s && (
          <div class="flex items-center gap-3">
            <OctagonAlert size={18} class={s.emergencyStop ? 'text-[var(--color-status-failed)]' : 'text-[var(--color-text-faint)]'} />
            <div class="min-w-0 flex-1">
              <div class="text-[12.5px] font-medium">{s.emergencyStop ? 'Đang dừng: hệ thống không nhận việc mới' : 'Đang hoạt động bình thường'}</div>
              <div class="hint">Bật để ngừng giao việc mới cho mọi agent. Việc đang chạy vẫn tiếp tục cho đến khi xong hoặc bạn huỷ.</div>
            </div>
            <Toggle on={s.emergencyStop} onChange={() => (s.emergencyStop ? void setStop(false) : setConfirmStop(true))} ariaLabel="Dừng khẩn cấp" />
          </div>
        )}
      </Card>

      <Card title="Runtime (các CLI agent)" class="mb-3" actions={
        <div class="flex gap-2">
          <button type="button" class="control-button control-sm" onClick={() => { setProbed(null); rt.refresh(); }}><RefreshCw size={11} /> Kiểm tra lại</button>
          <button type="button" class="control-button control-sm control-accent" disabled={probing} onClick={() => setConfirmProbe(true)}>{probing ? 'Đang gửi thử…' : 'Kiểm tra thật'}</button>
        </div>
      }>
        <PageState loading={rt.loading && !rt.data} error={rt.error} />
        {reports.length > 0 && (
          <div class="overflow-x-auto">
            <table class="table">
              <thead><tr><th>Runtime</th><th>Tình trạng</th><th>Phiên bản</th><th>Lệnh</th><th>Chặn quyền</th><th>Kiểm tra lúc</th></tr></thead>
              <tbody>{reports.map((r) => <RuntimeRow key={r.runtime} r={r} probed={probed !== null && r.runtime !== 'mock'} />)}</tbody>
            </table>
          </div>
        )}
        <div class="hint mt-2">“Kiểm tra lại” chỉ xem lệnh và phiên bản, miễn phí. “Kiểm tra thật” gửi một câu “hello” qua từng CLI để chắc chắn đã đăng nhập, có thể tốn một lượt gọi.</div>
      </Card>

      <div class="grid gap-3 md:grid-cols-2">
        <Card title="Giao diện">
          <div class="flex gap-1.5">
            {(['dark', 'light', 'system'] as Appearance[]).map((m) => (
              <button key={m} type="button" class={`toolbar-control ${appearance === m ? 'is-active' : ''}`} onClick={() => { setAppearance(m); setAppearanceState(m); }}>{m === 'dark' ? 'Tối' : m === 'light' ? 'Sáng' : 'Theo hệ thống'}</button>
            ))}
          </div>
        </Card>
        <Card title="Mã truy cập">
          <div class="flex items-center gap-2">
            <input class="field" type="password" autocomplete="off" placeholder="Trống nếu không đặt AIOS_TOKEN" value={token} onInput={(e) => setTokenInput((e.target as HTMLInputElement).value)} />
            <button type="button" class="control-button" onClick={() => { setToken(token.trim()); pushToast({ tone: 'success', title: 'Đã lưu mã truy cập trên trình duyệt này' }); location.reload(); }}>Lưu</button>
          </div>
          <div class="hint mt-1.5">Chỉ cần khi máy chủ đặt AIOS_TOKEN. Mã được lưu trong trình duyệt này.</div>
        </Card>
        {s && <Card title="Hệ thống"><div class="text-[12px] leading-6">Phiên bản <span class="mono">{s.version}</span><br />Múi giờ <span class="mono">{s.timezone}</span><br />Chạy song song tối đa <b>{s.maxParallel}</b> việc</div></Card>}
      </div>

      <ConfirmModal open={confirmProbe} onClose={() => setConfirmProbe(false)} onConfirm={() => void probe()} title="Kiểm tra thật các CLI?" body="Mỗi CLI sẽ nhận một câu “hello” ngắn. Có thể tốn một lượt gọi nhỏ với runtime tính phí." confirmLabel="Gửi thử" />
      <ConfirmModal open={confirmStop} onClose={() => setConfirmStop(false)} onConfirm={() => void setStop(true)} destructive title="Dừng khẩn cấp?" body="Hệ thống sẽ ngừng nhận việc mới cho mọi agent. Việc đang chạy không bị ngắt." confirmLabel="Dừng nhận việc" />
    </div>
  );
}
