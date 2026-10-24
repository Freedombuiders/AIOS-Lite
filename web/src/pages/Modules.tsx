import { Check, Plus, Power, Settings2, Trash2, X } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PageState } from '@/components/PageState';
import { Pill } from '@/components/Pill';
import { apiPost, ApiError, errorText } from '@/lib/api';
import type { ModuleInfo } from '@/lib/api-types';
import { CATEGORY_LABEL } from '@/lib/labels';
import { pushToast } from '@/lib/toasts';
import { useFetch } from '@/lib/useFetch';
import { refreshModules } from '@/module-host/host';
import { useEvents } from '@/lib/sse';
import { useCallback } from 'preact/hooks';
import { editableSettings, ModuleSettingsModal } from './modules/ModuleSettingsModal';

function Requirement({ r }: { r: ModuleInfo['requirements'][number] }) {
  return (
    <li class="flex items-start gap-1.5 text-[12px]">
      {r.ok ? <Check size={13} class="mt-0.5 shrink-0 text-[var(--color-status-done)]" /> : <X size={13} class="mt-0.5 shrink-0 text-[var(--color-status-failed)]" />}
      <span class={r.ok ? 'text-[var(--color-text-muted)]' : ''}>{r.message}</span>
    </li>
  );
}

function ModuleCard({ m, onAdd, onRemove, onPurge, onSettings }: { m: ModuleInfo; onAdd: () => void; onRemove: () => void; onPurge: () => void; onSettings: () => void }) {
  const enabled = m.state.enabled;
  const installed = m.state.installedAt !== null;
  return (
    <div class="card card-pad flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="m-0 text-[13.5px] font-semibold">{m.manifest.name}</h2>
        <Pill>{CATEGORY_LABEL[m.manifest.category]}</Pill>
        <span class="hint mono">{m.manifest.id} · v{m.manifest.version}</span>
        <span class="ml-auto"><Pill tone={enabled ? 'success' : 'neutral'}>{enabled ? 'Đang bật' : installed ? 'Đã tắt, còn dữ liệu' : 'Chưa thêm'}</Pill></span>
      </div>
      <p class="m-0 text-[12.5px] text-[var(--color-text-muted)]">{m.manifest.description}</p>
      {m.error && <div class="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 px-2.5 py-1.5 text-[12px] text-[var(--color-status-failed)]">Lỗi khi khởi động: {m.error}</div>}
      {m.requirements.length > 0 && (
        <div>
          <div class="section-title mb-1">Điều kiện</div>
          <ul class="m-0 flex list-none flex-col gap-1 p-0">{m.requirements.map((r) => <Requirement key={`${r.kind}:${r.id}`} r={r} />)}</ul>
        </div>
      )}
      {m.manifest.scopes && (
        <div class="hint">Quyền cấp cho agent: {Object.values(m.manifest.scopes).join(' · ')}</div>
      )}
      <div class="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {!enabled && <button type="button" class="control-button control-accent" disabled={!m.ready} title={m.ready ? undefined : 'Còn thiếu điều kiện ở trên'} onClick={onAdd}><Plus size={12} /> Thêm</button>}
        {enabled && editableSettings(m).length > 0 && <button type="button" class="control-button" onClick={onSettings}><Settings2 size={12} /> Cài đặt</button>}
        {enabled && <button type="button" class="control-button" onClick={onRemove}><Power size={12} /> Gỡ (giữ dữ liệu)</button>}
        {!enabled && installed && <button type="button" class="control-button control-danger" onClick={onPurge}><Trash2 size={12} /> Xoá dữ liệu</button>}
        {!enabled && !m.ready && <span class="hint">Chưa thêm được: hãy làm theo mục ✗ ở trên.</span>}
      </div>
    </div>
  );
}

export default function ModulesPage() {
  const f = useFetch<{ items: ModuleInfo[] }>('/modules');
  const refresh = f.refresh;
  useEvents(['module'], useCallback(() => refresh(), [refresh]));
  const [adding, setAdding] = useState<ModuleInfo | null>(null);
  const [installAgents, setInstallAgents] = useState(true);
  const [removing, setRemoving] = useState<ModuleInfo | null>(null);
  const [purging, setPurging] = useState<ModuleInfo | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<ModuleInfo | null>(null);
  const items = f.data?.items ?? [];

  async function done(msg: string) {
    pushToast({ tone: 'success', title: msg });
    refresh();
    await refreshModules();
  }

  async function add() {
    if (!adding) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await apiPost<{ agentsInstalled: string[]; migrationsApplied: string[] }>(`/modules/${adding.manifest.id}/add`, { installAgents: adding.agentTemplates.length > 0 && installAgents });
      await done(`Đã thêm module ${adding.manifest.name}${r.agentsInstalled.length ? ` · tạo agent: ${r.agentsInstalled.join(', ')}` : ''}`);
      setAdding(null);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'requirements_missing' ? `Chưa đủ điều kiện. ${e.message}` : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await apiPost(`/modules/${removing.manifest.id}/remove`);
      await done(`Đã gỡ module ${removing.manifest.name} (dữ liệu vẫn còn)`);
      setRemoving(null);
    } catch (e) {
      pushToast({ tone: 'error', title: 'Không gỡ được', description: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function purge() {
    if (!purging) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPost(`/modules/${purging.manifest.id}/purge`, { confirm: confirmText });
      await done(`Đã xoá dữ liệu của ${purging.manifest.name}`);
      setPurging(null);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="page">
      <PageHeader title="Module" />
      <p class="hint mt-0 mb-3 max-w-2xl">Module là tính năng thêm vào lõi: có menu, màn hình và API riêng. Thêm module khi cần, gỡ bất kỳ lúc nào. Gỡ chỉ tắt, dữ liệu vẫn còn cho đến khi bạn chọn “Xoá dữ liệu”.</p>
      <PageState loading={f.loading && !f.data} error={f.error} empty={!!f.data && items.length === 0} emptyTitle="Chưa có module nào" emptyDescription="Module nằm trong thư mục modules/<mã>. Sao chép modules/_template để viết module đầu tiên." />
      <div class="grid gap-3 lg:grid-cols-2">
        {items.map((m) => <ModuleCard key={m.manifest.id} m={m} onAdd={() => { setErr(null); setInstallAgents(true); setAdding(m); }} onRemove={() => setRemoving(m)} onPurge={() => { setErr(null); setConfirmText(''); setPurging(m); }} onSettings={() => setEditing(m)} />)}
      </div>

      <Modal open={adding !== null} onClose={() => setAdding(null)} title={`Thêm module ${adding?.manifest.name ?? ''}`} width={460} closeDisabled={busy} footer={<>{err && <span class="mr-auto text-[12px] text-[var(--color-status-failed)]">{err}</span>}<button type="button" class="control-button" disabled={busy} onClick={() => setAdding(null)}>Huỷ</button><button type="button" class="control-button control-accent" disabled={busy} onClick={() => void add()}>{busy ? 'Đang thêm…' : 'Thêm module'}</button></>}>
        {adding && (
          <div class="flex flex-col gap-3 text-[12.5px]">
            <p class="m-0">{adding.manifest.description}</p>
            <p class="hint m-0">Thêm sẽ tạo các bảng dữ liệu riêng của module ({adding.manifest.tables.join(', ')}) và bật menu của nó.</p>
            {adding.agentTemplates.length > 0 && (
              <label class="flex items-start gap-2"><input type="checkbox" class="mt-0.5" checked={installAgents} onChange={(e) => setInstallAgents((e.target as HTMLInputElement).checked)} /><span>Tạo agent mẫu <span class="hint">({adding.agentTemplates.join(', ')}) — bỏ qua nếu mã đã tồn tại</span></span></label>
            )}
          </div>
        )}
      </Modal>
      <ModuleSettingsModal module={editing} onClose={() => setEditing(null)} />
      <ConfirmModal open={removing !== null} onClose={() => setRemoving(null)} onConfirm={() => void remove()} loading={busy} title={`Gỡ module ${removing?.manifest.name ?? ''}?`} body="Menu và API của module bị ẩn, nhưng dữ liệu vẫn được giữ. Thêm lại bất kỳ lúc nào." confirmLabel="Gỡ" />
      <Modal open={purging !== null} onClose={() => setPurging(null)} title="Xoá dữ liệu của module" width={460} closeDisabled={busy} footer={<>{err && <span class="mr-auto text-[12px] text-[var(--color-status-failed)]">{err}</span>}<button type="button" class="control-button" disabled={busy} onClick={() => setPurging(null)}>Huỷ</button><button type="button" class="control-button control-danger" disabled={busy || confirmText !== purging?.manifest.id} onClick={() => void purge()}>Xoá vĩnh viễn</button></>}>
        {purging && (
          <div class="flex flex-col gap-3 text-[12.5px]">
            <p class="m-0">Hành động này xoá vĩnh viễn các bảng <span class="mono">{purging.manifest.tables.join(', ')}</span> và thư mục dữ liệu của module. Không khôi phục được.</p>
            <label class="block"><span class="label">Gõ <b class="mono">{purging.manifest.id}</b> để xác nhận</span><input class="field mono" value={confirmText} onInput={(e) => setConfirmText((e.target as HTMLInputElement).value)} /></label>
          </div>
        )}
      </Modal>
    </div>
  );
}
